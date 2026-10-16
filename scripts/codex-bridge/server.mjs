import http from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { BridgeError, BridgeStore } from './store.mjs';
import { validateRawRecognition } from './contract.mjs';
import { PlanError } from './identity.mjs';

export const BRIDGE_PORT = 5197;
export const SITE_ORIGIN = 'https://spoken-project-ledger.siounexzhao.chatgpt.site';
const MAX_BODY_BYTES = 1_700_000;
const MAX_IMAGE_BYTES = 1_500_000;
const PAIR_LIFETIME_MS = 5 * 60 * 1000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function publicIdentity(identity) {
  const value = identity.status();
  return {
    connected: value.connected === true,
    plan_authorized: value.plan_authorized === true,
    account_label: typeof value.account_label === 'string' ? value.account_label.slice(0, 200) : null,
    account_key: typeof value.account_key === 'string' ? value.account_key : null,
  };
}

function readBody(request, maximum) {
  if (request.headers['content-length'] && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > maximum)) {
    request.resume();
    return Promise.reject(new BridgeError(413, 'BODY_SIZE', '上传内容过大，图片没有发送给 Codex。'));
  }
  return new Promise((resolve, reject) => {
    let size = 0, failed = false;
    const chunks = [];
    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > maximum) {
        failed = true;
        chunks.length = 0;
        reject(new BridgeError(413, 'BODY_SIZE', '上传内容过大，图片没有发送给 Codex。'));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!failed) resolve(Buffer.concat(chunks, size)); });
    request.on('error', () => { if (!failed) { failed = true; reject(new BridgeError(400, 'BODY_READ', '未完整收到上传内容。')); } });
    request.on('aborted', () => { if (!failed) { failed = true; reject(new BridgeError(400, 'BODY_READ', '上传已中断。')); } });
  });
}

async function jsonBody(request, allowed) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new BridgeError(415, 'CONTENT_TYPE', '请使用 JSON 请求。');
  let body;
  try { body = JSON.parse((await readBody(request, 8192)).toString('utf8')); }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError(400, 'JSON', '请求不是有效的 JSON。'); }
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new BridgeError(400, 'FIELD', '请求包含未允许的字段。');
  return body;
}

function checkedImage(bytes, mime) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new BridgeError(413, 'IMAGE_SIZE', '原图必须大于 0 且不超过 1,500,000 字节。');
  const detected = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
  if (!detected || detected !== mime) throw new BridgeError(415, 'IMAGE_TYPE', '仅支持 MIME 与文件头一致的 PNG、JPEG 和 WebP 原图。');
  return sha256(bytes);
}

async function recognitionBody(request) {
  if (!/^multipart\/form-data\s*;/i.test(request.headers['content-type'] || '')) throw new BridgeError(415, 'CONTENT_TYPE', '请使用图片表单上传。');
  const body = await readBody(request, MAX_BODY_BYTES);
  let form;
  try { form = await new Response(body, { headers: { 'Content-Type': request.headers['content-type'] } }).formData(); }
  catch { throw new BridgeError(400, 'MULTIPART', '图片表单格式无效。'); }
  const allowed = ['image', 'note', 'projects_json', 'request_id', 'model', 'consent'];
  for (const key of form.keys()) {
    if (!allowed.includes(key) || form.getAll(key).length !== 1) throw new BridgeError(400, 'FIELD', '图片请求包含未知或重复字段；不接受路径、URL 或命令。');
  }
  const string = (name, maximum, fallback) => {
    const value = form.get(name) ?? fallback;
    if (typeof value !== 'string' || value.length > maximum) throw new BridgeError(400, 'FIELD', '图片请求字段缺失或过长：' + name);
    return value;
  };
  if (string('consent', 10) !== 'true') throw new BridgeError(400, 'CONSENT_REQUIRED', '请先明确同意本次将图片、说明和项目名称发送至 Codex。');
  const note = string('note', 2000, '');
  const requestId = string('request_id', 200);
  const model = string('model', 100);
  if (!requestId || requestId.trim() !== requestId || /[\x00-\x1f\x7f]/.test(requestId) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model)) throw new BridgeError(400, 'FIELD', '识别请求编号或模型无效。');
  let projects;
  try { projects = JSON.parse(string('projects_json', MAX_BODY_BYTES, '[]')); }
  catch { throw new BridgeError(400, 'PROJECTS', '项目列表不是有效 JSON。'); }
  if (!Array.isArray(projects) || projects.length > 1000 || projects.some(project => !object(project)
    || Object.keys(project).length !== 2 || !Object.hasOwn(project, 'id') || !Object.hasOwn(project, 'name')
    || typeof project.id !== 'string' || !project.id || project.id.length > 100
    || typeof project.name !== 'string' || !project.name || project.name.length > 300)
    || new Set(projects.map(project => project.id)).size !== projects.length) throw new BridgeError(400, 'PROJECTS', '仅接受至多 1000 个项目的 id 和 name。');
  projects = projects.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const image = form.get('image');
  if (!(image instanceof Blob) || typeof image.name !== 'string') throw new BridgeError(400, 'IMAGE', '请选择一张原图。');
  const bytes = Buffer.from(await image.arrayBuffer());
  const imageSha256 = checkedImage(bytes, image.type);
  return { bytes, mime_type: image.type, note, projects, requestId, model, imageSha256 };
}

// Factory-only overrides support offline tests. run.mjs fixes production Origin,
// loopback address and port; no environment variable broadens its trust boundary.
export function createBridgeServer({ stateDir, store: providedStore, identity, recognizer, origin = SITE_ORIGIN,
  port = BRIDGE_PORT, now = () => Date.now(), recognitionTimeoutMs = 120_000 } = {}) {
  if (!identity || typeof identity.status !== 'function' || typeof recognizer !== 'function') throw new Error('Identity and recognition adapters are required');
  if (new URL(origin).origin !== origin) throw new Error('An exact site Origin is required');
  if (!Number.isFinite(recognitionTimeoutMs) || recognitionTimeoutMs < 1 || recognitionTimeoutMs > 120_000) throw new Error('A bounded recognition deadline is required');
  const store = providedStore || new BridgeStore({ stateDir, now });
  const pairTokens = new Map();
  let pair, portalNonce = randomToken(), busy = false, activeAbort, lastLoginResult = null;
  const timestamp = () => new Date(now()).getTime();
  const rotatePair = () => {
    let code;
    do { code = randomInt(100_000_000).toString().padStart(8, '0'); } while (code === pair?.code);
    pair = { code, expires: timestamp() + PAIR_LIFETIME_MS, attempts: 0 };
  };
  rotatePair();
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      const safe = error instanceof BridgeError || error instanceof PlanError ? error : new BridgeError(500, 'BRIDGE_ERROR', '本机桥未完成请求；没有保存事项。');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.writeHead(safe.status);
      response.end(JSON.stringify({ error: safe.code, code: safe.code, message: safe.message, completed: false }));
    });
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

  const localOrigin = () => `http://127.0.0.1:${server.address()?.port ?? port}`;
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  function html(response, status, content) {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('X-Frame-Options', 'DENY');
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>项目簿 · 本机 Codex 桥</title><style>body{font:16px/1.7 system-ui;max-width:680px;margin:48px auto;padding:0 24px;color:#143a2c}output{font-size:36px;letter-spacing:8px;font-variant-numeric:tabular-nums}button{padding:10px 16px}small{color:#53665b}</style><body>${content}</body></html>`);
  }
  function requireOrigin(request) {
    if (request.headers.origin !== origin) throw new BridgeError(403, 'ORIGIN', '仅允许已配对的项目簿网站访问本机桥。');
  }
  function requireBearer(request) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '');
    const key = match ? sha256(match[1]) : '';
    const scope = pairTokens.get(key);
    if (!scope) throw new BridgeError(401, 'PAIR_REQUIRED', '请在本机桥页面完成一次性配对。');
    return { scope, key };
  }
  function requirePlan() {
    const status = publicIdentity(identity);
    if (!status.connected) throw new BridgeError(401, 'CODEX_NOT_CONNECTED', '请在本机桥页面通过官方登录连接 Codex。');
    if (!status.plan_authorized || !status.account_key) throw new BridgeError(403, 'PLAN_NOT_AUTHORIZED', '尚未取得 ChatGPT 套餐识别授权。');
    return status;
  }
  async function models() {
    const list = await identity.models();
    if (!Array.isArray(list)) throw new BridgeError(502, 'MODEL_CATALOG', '无法读取已授权模型列表。');
    return list.filter(item => object(item) && typeof item.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(item.slug))
      .map(item => ({ slug: item.slug, display_name: typeof item.display_name === 'string' ? item.display_name.slice(0, 300) : item.slug }));
  }
  async function portalForm(request) {
    if (request.headers.origin !== localOrigin()) throw new BridgeError(403, 'ORIGIN', '登录操作须在本机桥页面发起。');
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new BridgeError(415, 'CONTENT_TYPE', '登录表单格式无效。');
    const form = new URLSearchParams((await readBody(request, 8192)).toString('utf8'));
    if ([...form.keys()].some(key => key !== 'csrf') || form.getAll('csrf').length !== 1 || form.get('csrf') !== portalNonce) throw new BridgeError(403, 'CSRF', '本机页面校验已过期，请刷新后重试。');
    portalNonce = randomToken();
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.headers.host !== localOrigin().slice(7)) throw new BridgeError(403, 'HOST', '本机桥只接受指定的回环地址。');
    if (!request.url || request.url.length > 8192) throw new BridgeError(400, 'URL', '请求地址无效。');
    const url = new URL(request.url, localOrigin());
    if (url.origin !== localOrigin()) throw new BridgeError(403, 'HOST', '请求地址与本机桥不一致。');
    const portal = ['/', '/portal/connect', '/portal/logout', '/auth/callback'].includes(url.pathname);
    if (portal) {
      if (request.headers.origin !== undefined && request.headers.origin !== localOrigin()) throw new BridgeError(403, 'ORIGIN', '本机页面不接受其他来源读取。');
    } else {
      requireOrigin(request);
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (url.pathname !== '/auth/callback' && url.search) throw new BridgeError(400, 'FIELD', '此接口不接受 URL 参数。');
    if (request.method === 'OPTIONS' && !portal) {
      if (!['GET', 'POST'].includes(request.headers['access-control-request-method'])) throw new BridgeError(403, 'CORS_METHOD', '仅允许 GET 和 POST。');
      const headers = (request.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (headers.some(header => !['authorization', 'content-type'].includes(header))) throw new BridgeError(403, 'CORS_HEADERS', '请求头未获允许。');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.writeHead(204); response.end(); return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      // Preserve the same-origin form Origin; external OAuth navigation still
      // receives no referrer. Callback pages keep the default no-referrer.
      response.setHeader('Referrer-Policy', 'same-origin');
      store.expireResults();
      if (pair.expires <= timestamp() || pair.attempts >= 5) rotatePair();
      portalNonce = randomToken();
      const status = publicIdentity(identity);
      const loginNotice = lastLoginResult === 'success' ? '<p role="status">官方登录已完成，可返回项目簿核对连接状态。</p>'
        : lastLoginResult === 'failed' ? '<p role="status">最近一次登录未完成，可重新发起官方登录。</p>' : '';
      html(response, 200, `<h1>项目簿 · 本机 Codex 桥</h1>${loginNotice}<p>${status.connected ? `已连接：${escapeHtml(status.account_label || '本人账号')}` : '尚未连接 Codex，请通过官方登录连接。'}</p><section aria-label="连接前须知"><h2>连接前须知</h2><p>这是独立的官方授权，不读取已有 Codex 凭据。识别使用本人所选 ChatGPT 计划及其可用额度，不额外开启 API 付费，也不承诺免费；可用性和用量以本人账号与工作区政策为准。</p><p>仅在本人明确点击识别时，才将本次图片、说明和项目名称发送至 OpenAI。请求设置 store:false，但这不等于零保留；服务端保留仍按账号、工作区和服务政策处理。连接和配对本身不会发送图片。</p><p>原图不落盘；本机结构化结果保存 7 天，在访问或启动时清理。请求编号、hash、计数及公共注册信息长期保留用于防重，不能理解为所有本机数据都在 7 天后删除。</p><p><a href="https://openai.com/policies/sign-in-with-chatgpt-terms/" rel="noreferrer">Sign in with ChatGPT 条款</a> · <a href="https://openai.com/policies/privacy-policy/" rel="noreferrer">隐私政策</a></p></section><form method="post" action="/portal/connect"><input type="hidden" name="csrf" value="${portalNonce}"><button>通过官方页面连接 Codex</button></form><h2>网页配对码</h2><output id="pair-code">${pair.code}</output><p>5 分钟内有效，仅使用一次；最多尝试 5 次。</p><p>仅允许原项目簿网站配对。每台本机每天最多 10 次，失败和超时也计入。</p><p><small>本机桥必须保持运行。配对与登录令牌仅保存在进程内存；重启后需要重新登录和配对。它不会预约、发消息或写入项目簿。</small></p><form method="post" action="/portal/logout"><input type="hidden" name="csrf" value="${portalNonce}"><button>断开 Codex 账号</button></form>`);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/portal/connect') {
      await portalForm(request);
      const destination = new URL(identity.start());
      if (destination.protocol !== 'https:' || destination.hostname !== 'auth.openai.com' || destination.username || destination.password) throw new BridgeError(502, 'AUTH_URL', '官方登录地址无效。');
      response.writeHead(303, { Location: destination.href }); response.end(); return;
    }
    if (request.method === 'POST' && url.pathname === '/portal/logout') {
      await portalForm(request);
      activeAbort?.abort();
      await identity.logout();
      html(response, 200, '<h1>账号已断开</h1><p>本机进程中的登录令牌已清除。</p><p><a href="/">返回本机桥</a></p>'); return;
    }
    if (request.method === 'GET' && url.pathname === '/auth/callback') {
      try {
        await identity.callback(url.searchParams);
        lastLoginResult = 'success';
      } catch {
        lastLoginResult = 'failed';
      }
      response.writeHead(303, { Location: '/' }); response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/pair') {
      const body = await jsonBody(request, ['code', 'scope']);
      if (typeof body.scope !== 'string' || !/^[a-f0-9]{64}$/i.test(body.scope) || typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) throw new BridgeError(400, 'PAIR_FIELDS', '配对码或本人数据范围无效。');
      if (pair.expires <= timestamp()) throw new BridgeError(410, 'PAIR_EXPIRED', '配对码已过期，请刷新本机桥页面。');
      if (pair.attempts >= 5) throw new BridgeError(429, 'PAIR_LOCKED', '配对尝试已达上限，请在本机桥页面刷新。');
      pair.attempts++;
      if (!timingSafeEqual(Buffer.from(body.code), Buffer.from(pair.code))) throw new BridgeError(pair.attempts >= 5 ? 429 : 401, pair.attempts >= 5 ? 'PAIR_LOCKED' : 'PAIR_CODE', '配对码不正确，请核对本机桥页面。');
      const scope = body.scope.toLowerCase();
      for (const [key, pairedScope] of pairTokens) if (pairedScope === scope) pairTokens.delete(key);
      const token = randomToken(); pairTokens.set(sha256(token), scope); rotatePair();
      json(response, 200, { token, bridge_id: store.hostId }); return;
    }
    const auth = requireBearer(request);
    if (request.method === 'GET' && url.pathname === '/status') {
      store.expireResults();
      json(response, 200, { ...publicIdentity(identity), quota: store.quota(), bridge_id: store.hostId }); return;
    }
    if (request.method === 'GET' && url.pathname === '/models') {
      requirePlan(); json(response, 200, { models: await models() }); return;
    }
    if (request.method === 'POST' && url.pathname === '/disconnect') {
      if (request.headers['transfer-encoding'] || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') await jsonBody(request, []);
      pairTokens.delete(auth.key); rotatePair();
      json(response, 200, { disconnected: true, bridge_id: store.hostId }); return;
    }
    if (request.method === 'POST' && url.pathname === '/recognize') {
      const status = requirePlan();
      const input = await recognitionBody(request);
      if (!(await models()).some(model => model.slug === input.model)) throw new BridgeError(400, 'MODEL_NOT_ALLOWED', '请选择官方已授权列表中的模型。');
      requireBearer(request);
      if (requirePlan().account_key !== status.account_key) throw new BridgeError(409, 'OAUTH_SUPERSEDED', '账号连接已更换，请重新核对本次识别。');
      const fingerprint = sha256(JSON.stringify({ scope: auth.scope, account_key: status.account_key,
        image_sha256: input.imageSha256, note: input.note, projects: input.projects, model: input.model }));
      const reservation = store.reserve({ scope: auth.scope, requestId: input.requestId, fingerprint, accountKey: status.account_key, model: input.model, imageSha256: input.imageSha256 }, { allowNew: !busy });
      const result = raw => ({ result: raw, model: input.model, request_id: input.requestId, image_sha256: input.imageSha256,
        provider: 'codex-local-plan', completed: true });
      if (reservation.cached) { json(response, 200, { ...result(reservation.result), cached: true }); return; }
      busy = true;
      const controller = new AbortController(); activeAbort = controller;
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new BridgeError(504, 'RECOGNITION_TIMEOUT', '本次识别超时，可能已使用套餐额度；原请求不会自动重发。'));
        }, recognitionTimeoutMs); });
        const raw = await Promise.race([recognizer({ identity, bytes: input.bytes, mime_type: input.mime_type, note: input.note, projects: input.projects, model: input.model }, { signal: controller.signal, timeoutMs: recognitionTimeoutMs }), timeout]);
        requireBearer(request);
        if (requirePlan().account_key !== status.account_key) throw new BridgeError(409, 'OAUTH_SUPERSEDED', '账号连接已更换，旧结果不会填入当前草稿。');
        validateRawRecognition(raw);
        store.succeed(auth.scope, input.requestId, raw);
        json(response, 200, result(raw));
      } catch (error) {
        store.fail(auth.scope, input.requestId, error?.code);
        if (error instanceof BridgeError || error instanceof PlanError) throw error;
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'RECOGNITION_FAILED';
        throw new BridgeError(502, code, 'Codex 未完整完成识别，原图和草稿仍在网页中；本请求不会自动重发。');
      } finally {
        clearTimeout(timer); activeAbort = undefined; busy = false;
      }
      return;
    }
    throw new BridgeError(404, 'NOT_FOUND', '接口不存在。');
  }

  return {
    server, store, bridgeId: store.hostId,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      return localOrigin();
    },
    async close() {
      activeAbort?.abort();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      pairTokens.clear(); store.close();
    },
  };
}
