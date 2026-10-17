import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { PlanError } from './identity.mjs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code, message) => new PlanError(status, code, message);
const off = ['shell_tool', 'unified_exec', 'hooks', 'apps', 'plugins', 'remote_plugin', 'code_mode_host', 'multi_agent', 'skill_search', 'skill_mcp_dependency_install', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation', 'workspace_dependencies', 'tool_suggest', 'view_image', 'sleep_tool'];
// app-server has no --ignore-user-config option. It receives explicit safe
// overrides, uses a non-project cwd, and is never sent any thread/turn/tool RPC.
const ARGS = Object.freeze([
  ...off.flatMap(name => ['--disable', name]),
  '--enable', 'skip_host_skill_discovery',
  '-c', 'model_provider="openai"',
  '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
  '-c', 'web_search="disabled"',
  '-c', 'tools.view_image=false',
  '-c', 'approval_policy="never"',
  '-c', 'sandbox_mode="read-only"',
  '-c', 'mcp_servers={}',
  'app-server', '--listen', 'stdio://',
]);
const ALLOWED = new Set(['initialize', 'account/read', 'model/list']);
const MAX_BYTES = 2_000_000;
const disconnected = error_code => ({ connected: false, plan_authorized: false, account_label: null, account_key: null, ...(error_code ? { error_code } : {}) });
const safeError = error => error instanceof PlanError ? error : fail(503, 'CODEX_CLI_FAILED', '无法核验本机Codex，请检查官方CLI登录。');

function accountStatus(response) {
  if (!object(response) || typeof response.requiresOpenaiAuth !== 'boolean') throw fail(502, 'CODEX_CLI_OUTPUT', '本机Codex账户响应格式无法核验。');
  if (response.account == null) throw fail(401, 'CODEX_CLI_NOT_LOGGED_IN', '请先在官方Codex CLI中登录ChatGPT账号。');
  const account = response.account;
  if (!object(account) || account.type !== 'chatgpt') throw fail(403, 'CODEX_CLI_ACCOUNT', '仅支持官方Codex的ChatGPT登录，不使用API密钥账号。');
  const email = typeof account.email === 'string' ? account.email.trim().toLowerCase() : '';
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof account.planType !== 'string') throw fail(403, 'CODEX_CLI_ACCOUNT', '本机Codex未提供可核验的ChatGPT账号标识。');
  return {
    connected: true,
    plan_authorized: true,
    account_label: `${email}（本机Codex）`,
    account_key: createHash('sha256').update(`codex-cli\0chatgpt\0${email}`).digest('hex'),
  };
}

function rpcSession(runtime, spawnImpl, timeoutMs) {
  let child;
  try { child = spawnImpl(runtime.executable, [...ARGS], { env: runtime.env, cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw fail(503, error?.code === 'ENOENT' ? 'CODEX_CLI_NOT_FOUND' : 'CODEX_CLI_FAILED', '无法启动官方本机Codex账户核验。'); }
  let ended = false, serial = 0, buffer = '', bytes = 0, finalError = null;
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  function close(error) {
    if (ended) return;
    ended = true; finalError = error ?? fail(503, 'CODEX_CLI_FAILED', '本机Codex账户核验已结束。'); clearTimeout(timer);
    for (const entry of pending.values()) entry.reject(finalError);
    pending.clear();
    try { child.stdin.end(); } catch { /* No provider messages are surfaced. */ }
    try { child.kill(); } catch { /* The process may have already exited. */ }
  }
  const timer = setTimeout(() => close(fail(504, 'CODEX_CLI_TIMEOUT', '本机Codex账户核验超时，请稍后重试。')), timeoutMs);
  child.once('error', error => close(fail(503, error?.code === 'ENOENT' ? 'CODEX_CLI_NOT_FOUND' : 'CODEX_CLI_FAILED', '无法启动官方本机Codex账户核验。')));
  child.once('close', () => close(fail(503, 'CODEX_CLI_FAILED', '本机Codex提前结束账户核验。')));
  child.stdin.on('error', () => close(fail(503, 'CODEX_CLI_FAILED', '本机Codex账户核验连接已关闭。')));
  child.stderr.on('data', () => { /* Drain, but never retain or log CLI diagnostics. */ });
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) return close(fail(502, 'CODEX_CLI_OUTPUT', '本机Codex账户响应超出限制。'));
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while (!ended && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return close(fail(502, 'CODEX_CLI_OUTPUT', '本机Codex账户响应无法解析。')); }
      if (!object(message)) return close(fail(502, 'CODEX_CLI_OUTPUT', '本机Codex账户响应格式无法核验。'));
      if (typeof message.method === 'string') {
        if (message.id !== undefined) return close(fail(403, 'CODEX_CLI_TOOL', '账户核验期间不允许执行工具或授权请求。'));
        continue; // Notifications are never reflected or retained.
      }
      const entry = pending.get(message.id);
      if (!entry) return close(fail(502, 'CODEX_CLI_OUTPUT', '本机Codex账户响应编号无法核验。'));
      pending.delete(message.id);
      if (object(message.error)) entry.reject(fail(503, 'CODEX_CLI_FAILED', '本机Codex拒绝了账户或模型目录查询。'));
      else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else entry.reject(fail(502, 'CODEX_CLI_OUTPUT', '本机Codex账户响应缺少结果。'));
    }
  });
  function write(message) {
    if (ended) throw finalError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params) {
    if (!ALLOWED.has(method)) throw fail(403, 'CODEX_CLI_TOOL', '不允许的本机Codex请求。');
    if (ended) return Promise.reject(finalError);
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { write({ id, method, params }); } catch (error) { pending.delete(id); reject(safeError(error)); }
    });
  }
  return {
    request,
    async initialize() {
      const result = await request('initialize', { clientInfo: { name: 'spoken_project_ledger_account', title: '项目簿本机账户核验', version: '1.0.0' }, capabilities: { experimentalApi: false } });
      if (!object(result)) throw fail(502, 'CODEX_CLI_OUTPUT', '本机Codex初始化响应无法核验。');
      write({ method: 'initialized' });
    },
    close,
  };
}

export function createNativeIdentity({ runtime, spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  if (!runtime || typeof runtime.executable !== 'string' || !object(runtime.env)) throw fail(503, 'CODEX_CLI_NOT_FOUND', '未找到官方本机Codex。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw fail(400, 'CODEX_CLI_TIMEOUT', '账户核验超时设置无效。');
  let cached = disconnected(), refreshPromise = null, modelsPromise = null;
  async function run(callback) {
    let session;
    try { session = rpcSession(runtime, spawnImpl, timeoutMs); await session.initialize(); return await callback(session); }
    catch (error) { throw safeError(error); }
    finally { session?.close(); }
  }
  async function refresh() {
    if (!refreshPromise) refreshPromise = run(async session => accountStatus(await session.request('account/read', { refreshToken: false })))
      .then(status => { cached = status; return { ...cached }; }, error => { cached = disconnected(safeError(error).code); return { ...cached }; })
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function models() {
    if (!modelsPromise) modelsPromise = run(async session => {
      const before = accountStatus(await session.request('account/read', { refreshToken: false }));
      const found = new Map(), cursors = new Set(); let cursor = null;
      for (let page = 0; page < 20; page++) {
        const result = await session.request('model/list', { cursor, limit: 100, includeHidden: false });
        if (!object(result) || !Array.isArray(result.data) || result.data.length > 1000 || result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4000)) throw fail(502, 'CODEX_CLI_OUTPUT', '本机Codex模型目录格式无法核验。');
        for (const model of result.data) {
          if (!object(model) || typeof model.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model.model) || typeof model.displayName !== 'string' || !model.displayName.trim() || model.displayName.length > 200 || typeof model.hidden !== 'boolean' || model.inputModalities !== undefined && (!Array.isArray(model.inputModalities) || model.inputModalities.some(mode => !['text', 'image', 'audio'].includes(mode)))) throw fail(502, 'CODEX_CLI_OUTPUT', '本机Codex模型记录无法核验。');
          if (!model.hidden && (model.inputModalities === undefined || model.inputModalities.includes('image'))) found.set(model.model, { slug: model.model, display_name: model.displayName });
        }
        cursor = result.nextCursor ?? null;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 19) throw fail(502, 'CODEX_CLI_OUTPUT', '本机Codex模型目录分页无法核验。');
        cursors.add(cursor);
      }
      const after = accountStatus(await session.request('account/read', { refreshToken: false }));
      if (before.account_key !== after.account_key) throw fail(409, 'CODEX_CLI_ACCOUNT', '本机Codex账号已改变，请重新核对后识别。');
      cached = after;
      if (!found.size) throw fail(403, 'CODEX_CLI_ACCOUNT', '当前本机Codex账号未提供可用的图像模型。');
      return [...found.values()];
    }).catch(error => { const safe = safeError(error); cached = disconnected(safe.code); throw safe; }).finally(() => { modelsPromise = null; });
    return modelsPromise;
  }
  return Object.freeze({ kind: 'codex-cli', status: () => ({ ...cached }), refresh, models });
}
