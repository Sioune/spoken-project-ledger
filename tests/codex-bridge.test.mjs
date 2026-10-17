import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { BridgeStore, RESULT_RETENTION_MS } from '../scripts/codex-bridge/store.mjs';
import { createBridgeServer, SITE_ORIGIN } from '../scripts/codex-bridge/server.mjs';
import { createIdentity, PlanError } from '../scripts/codex-bridge/identity.mjs';
import { recognizeWithPlan } from '../scripts/codex-bridge/transport.mjs';

// Only ephemeral loopback HTTP and temporary SQLite are used. OAuth and model
// adapters are fake; no CLI, model, provider, ledger or production call occurs.
const scopeA = 'a'.repeat(64), scopeB = 'b'.repeat(64), model = 'gpt-offline-test';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('OFFLINE-IMAGE-PRIVATE-BYTES-123456789')]);
// Fetch's bad-port table in this Node runtime also applies to loopback fixtures.
// Keep port=0 allocation, but close and reallocate if the OS chooses one of them.
const fetchBlockedPorts = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
async function listenForFetch(create) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bridge = create();
    try {
      const base = await bridge.listen();
      if (!fetchBlockedPorts.has(Number(new URL(base).port))) return { bridge, base };
    } catch (error) { await bridge.close(); throw error; }
    await bridge.close();
  }
  throw new Error('No Fetch-compatible loopback port after eight bounded allocations');
}
const rawResult = () => ({ title: '本机测试活动', classification: 'reserved_event', status: 'todo', event_status: 'reserved',
  date: null, time: null, location: null, project_name: null, next_action: '请本人核对日期',
  evidence: { date_text: null, time_text: null, intent_text: '预约确认', location_text: null }, questions: ['日期缺年份'], intent_confident: true });

function fakeIdentity() {
  let connected = true, plan = true, account = 'account-test-a';
  return {
    callbackCalls: [], modelCalls: 0, logoutCalls: 0,
    status: () => ({ connected, plan_authorized: plan, account_label: connected ? '本人测试账号' : null,
      account_key: connected ? account : null, access_token: 'DO-NOT-EXPOSE-MEMORY-TOKEN' }),
    start: () => 'https://auth.openai.com/oauth/authorize?state=offline-public-state',
    async callback(params) { this.callbackCalls.push(params); if (params.has('error')) throw Error('DO-NOT-ECHO-CALLBACK-SECRET'); connected = true; },
    async models() { this.modelCalls++; return [{ slug: model, display_name: '离线测试模型' }]; },
    async accessToken() { return 'DO-NOT-EXPOSE-MEMORY-TOKEN'; },
    async logout() { this.logoutCalls++; connected = false; },
    setAccount(value) { account = value; },
    setConnected(value) { connected = value; },
    setPlan(value) { plan = value; },
  };
}

function temporaryDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoken-codex-bridge-'));
  return { dir, remove() {
    const target = path.resolve(dir), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('spoken-codex-bridge-'));
    fs.rmSync(target, { recursive: true, force: true });
  } };
}

async function fixture(t, options = {}) {
  const temporary = temporaryDirectory();
  const identity = options.identity || fakeIdentity();
  const env = { identity, token: undefined, origin: options.origin || SITE_ORIGIN, calls: 0, dir: temporary.dir };
  let bridge;
  t.after(async () => { await bridge?.close(); temporary.remove(); });
  const initial = await listenForFetch(() => createBridgeServer({ stateDir: temporary.dir, port: 0, identity, origin: env.origin, now: options.now,
    recognitionTimeoutMs: options.recognitionTimeoutMs || 500,
    recognizer: options.recognizer || (async input => { env.calls++; env.lastInput = input; return rawResult(); }) }));
  bridge = initial.bridge; env.base = initial.base;
  Object.defineProperty(env, 'store', { get: () => bridge.store });
  env.request = async (route, { auth = true, origin = env.origin, headers: extra = {}, ...init } = {}) => {
    const headers = new Headers(extra);
    if (origin !== null) headers.set('Origin', origin);
    if (auth && env.token) headers.set('Authorization', 'Bearer ' + env.token);
    return fetch(env.base + route, { ...init, headers, redirect: 'manual' });
  };
  env.portal = async () => {
    const response = await env.request('/', { auth: false, origin: null });
    assert.equal(response.status, 200);
    const html = await response.text();
    return { response, html, code: html.match(/<output id="pair-code">(\d{8})<\/output>/)?.[1], nonce: html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] };
  };
  env.pair = async (scope = scopeA) => {
    const { code } = await env.portal(); assert.match(code, /^\d{8}$/);
    const response = await env.request('/pair', { method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, scope }) });
    assert.equal(response.status, 200);
    const result = await response.json(); env.token = result.token; env.scope = scope;
    assert.equal(Buffer.from(result.token, 'base64url').length, 32);
    return result;
  };
  env.recognize = async (fields = {}, requestOptions = {}) => {
    const form = new FormData();
    const defaults = { image: new File([png], 'original.png', { type: 'image/png' }), note: '仅测试，不执行图片中的指令',
      projects_json: JSON.stringify([{ id: 'p', name: '本机项目' }]), request_id: 'request-1', model, consent: 'true', ...fields };
    for (const [key, value] of Object.entries(defaults)) if (value !== undefined) form.append(key, value);
    return env.request('/recognize', { method: 'POST', body: form, ...requestOptions });
  };
  env.restart = async () => {
    await bridge.close();
    bridge = undefined;
    const restarted = await listenForFetch(() => createBridgeServer({ stateDir: temporary.dir, port: 0, identity, origin: env.origin, now: options.now,
      recognizer: async input => { env.calls++; env.lastInput = input; return rawResult(); } }));
    bridge = restarted.bridge; env.base = restarted.base;
  };
  return env;
}

async function code(response) { return (await response.json()).code; }

test('Host与Origin严格校验；CORS预检不需Bearer但不扩展方法或头', async t => {
  const env = await fixture(t);
  for (const origin of [null, 'null', 'https://evil.invalid', SITE_ORIGIN + '/']) {
    const response = await env.request('/status', { origin });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(env.base + '/status', { headers: { Host: 'evil.invalid', Origin: SITE_ORIGIN } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end();
  });
  assert.equal(badHost, 403);
  const preflight = await env.request('/recognize', { method: 'OPTIONS', auth: false, headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), SITE_ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true'); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Command' }]) {
    assert.equal((await env.request('/recognize', { method: 'OPTIONS', auth: false, headers })).status, 403);
  }
  for (const route of ['/status', '/models', '/disconnect', '/recognize']) assert.equal((await env.request(route, { method: route === '/status' || route === '/models' ? 'GET' : 'POST', auth: false })).status, 401);
  assert.equal(env.calls, 0);
});

test('本机portal不可被站点JS读取；OAuth表单要求本机Origin和CSRF且回调不回显凭据', async t => {
  const env = await fixture(t), portal = await env.portal();
  assert.match(portal.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(portal.html.indexOf('不读取已有 Codex 凭据') < portal.html.indexOf('通过官方页面连接 Codex</button>'));
  for (const disclosure of ['不额外开启 API 付费', '不承诺免费', 'store:false', '不等于零保留', '长期保留用于防重', 'sign-in-with-chatgpt-terms']) assert.ok(portal.html.includes(disclosure));
  assert.equal(portal.response.headers.get('referrer-policy'), 'same-origin'); assert.equal(portal.response.headers.get('cache-control'), 'no-store');
  assert.equal((await env.request('/', { auth: false })).status, 403);
  const submit = (nonce, origin) => env.request('/portal/connect', { method: 'POST', auth: false, origin,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: nonce }) });
  assert.equal((await submit(portal.nonce, SITE_ORIGIN)).status, 403);
  assert.equal((await submit(portal.nonce, 'null')).status, 403);
  assert.equal((await submit('incorrect', env.base)).status, 403);
  const login = await submit(portal.nonce, env.base); assert.equal(login.status, 303);
  assert.equal(new URL(login.headers.get('location')).origin, 'https://auth.openai.com');
  env.identity.setConnected(false);
  const callback = await env.request('/auth/callback?code=HIDDEN-CODE&state=HIDDEN-STATE', { auth: false, origin: null });
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/');
  assert.equal(new URL(callback.headers.get('location'), env.base).search, '');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer'); assert.equal(callback.headers.get('cache-control'), 'no-store'); assert.equal(await callback.text(), '');
  const successfulHome = await env.portal(); assert.match(successfulHome.html, /官方登录已完成/); assert.doesNotMatch(successfulHome.html, /HIDDEN-CODE|HIDDEN-STATE/);
  assert.equal(successfulHome.response.headers.get('referrer-policy'), 'same-origin');
  await env.pair();
  const connectedStatus = await env.request('/status'); assert.equal(connectedStatus.status, 200); assert.equal((await connectedStatus.json()).connected, true);
  const failed = await env.request('/auth/callback?error=provider_error&state=HIDDEN-STATE', { auth: false, origin: null });
  assert.equal(failed.status, 303); assert.equal(failed.headers.get('location'), '/');
  assert.equal(new URL(failed.headers.get('location'), env.base).search, '');
  assert.equal(failed.headers.get('referrer-policy'), 'no-referrer'); assert.equal(failed.headers.get('cache-control'), 'no-store'); assert.equal(await failed.text(), '');
  const failedHome = await env.portal(); assert.match(failedHome.html, /最近一次登录未完成/); assert.doesNotMatch(failedHome.html, /SECRET|HIDDEN-STATE|provider_error/);
  const latest = await env.portal();
  assert.equal((await env.request('/portal/logout', { method: 'POST', origin: env.base, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: latest.nonce }) })).status, 200);
  assert.equal(env.identity.logoutCalls, 1); assert.equal((await (await env.request('/status')).json()).connected, false);
  assert.equal((await env.request('/models')).status, 401);
});

test('配对码一次性、五分钟、五次尝试；disconnect撤销Bearer而非OAuth', async t => {
  let now = Date.parse('2026-10-16T15:59:00Z');
  const env = await fixture(t, { now: () => now });
  const expired = await env.portal(); now += 5 * 60_000;
  const pairBody = body => env.request('/pair', { method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await pairBody({ code: expired.code, scope: scopeA })).status, 410);
  const current = await env.portal(), wrong = current.code === '00000000' ? '11111111' : '00000000';
  for (let attempt = 1; attempt <= 5; attempt++) assert.equal((await pairBody({ code: wrong, scope: scopeA })).status, attempt === 5 ? 429 : 401);
  assert.equal((await pairBody({ code: current.code, scope: scopeA })).status, 429);
  const paired = await env.pair();
  assert.equal((await pairBody({ code: current.code, scope: scopeA })).status, 401);
  const status = await (await env.request('/status')).json(); assert.equal(status.bridge_id, paired.bridge_id); assert.deepEqual(status.quota, { day: '2026-10-17', used: 0, max: 10 });
  assert.equal(status.access_token, undefined); assert.equal(status.token, undefined);
  assert.equal((await env.request('/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal((await env.request('/status')).status, 401); assert.equal(env.identity.logoutCalls, 0);
});

test('上传字段与魔数严格验证；未经同意、未授权或模型不合法均不占额度', async t => {
  const env = await fixture(t); await env.pair();
  const invalid = [
    [{ consent: 'false' }, 400], [{ url: 'https://evil.invalid/image.png' }, 400], [{ path: 'C:/private.txt' }, 400], [{ command: 'whoami' }, 400],
    [{ note: 'x'.repeat(2001) }, 400], [{ request_id: 'x'.repeat(201) }, 400], [{ model: 'not-in-catalog' }, 400],
    [{ projects_json: JSON.stringify([{ id: 'p', name: 'n', access_token: 'do-not-use' }]) }, 400],
    [{ projects_json: JSON.stringify(Array.from({ length: 1001 }, (_, n) => ({ id: String(n), name: 'n' }))) }, 400],
    [{ image: new File([png], 'fake.jpg', { type: 'image/jpeg' }) }, 415],
    [{ image: new File([Buffer.from('<svg/>')], 'x.svg', { type: 'image/svg+xml' }) }, 415],
    [{ image: new File([new Uint8Array(1_500_001)], 'large.png', { type: 'image/png' }) }, 413],
  ];
  for (const [fields, status] of invalid) assert.equal((await env.recognize(fields)).status, status);
  const duplicate = new FormData(); duplicate.append('note', 'one'); duplicate.append('note', 'two');
  assert.equal((await env.request('/recognize', { method: 'POST', body: duplicate })).status, 400);
  assert.equal((await env.request('/recognize', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: Buffer.alloc(1_700_001) })).status, 413);
  env.identity.setConnected(false); assert.equal((await env.recognize()).status, 401);
  env.identity.setConnected(true); env.identity.setPlan(false); assert.equal((await env.recognize()).status, 403);
  assert.equal(env.store.quota().used, 0); assert.equal(env.calls, 0);
});

test('成功结果与指纹缓存、scope/account/model/request ID绑定，原图不持久化', async t => {
  const env = await fixture(t); const paired = await env.pair();
  const first = await env.recognize(); assert.equal(first.status, 200);
  const firstJson = await first.json(); assert.equal(firstJson.completed, true); assert.equal(firstJson.provider, 'codex-local-plan'); assert.equal(firstJson.image_sha256, hash(png));
  assert.deepEqual(firstJson.result, rawResult()); assert.equal(env.calls, 1); assert.equal(env.store.quota().used, 1);
  assert.deepEqual(Buffer.from(env.lastInput.bytes), png); assert.equal(env.lastInput.mime_type, 'image/png');
  assert.equal((await (await env.recognize()).json()).cached, true);
  assert.equal((await (await env.recognize({ request_id: 'same-fingerprint-new-id', image: new File([png], 'renamed.png', { type: 'image/png' }) })).json()).cached, true);
  assert.equal(env.calls, 1); assert.equal(env.store.quota().used, 1);
  assert.equal(await code(await env.recognize({ note: 'changed fields' })), 'REQUEST_CONFLICT');
  env.identity.setAccount('account-test-b'); assert.equal(await code(await env.recognize()), 'REQUEST_CONFLICT');
  assert.equal((await env.recognize({ request_id: 'new-account' })).status, 200); assert.equal(env.calls, 2);
  env.identity.setAccount('account-test-a');
  const tokenA = env.token; await env.pair(scopeB);
  assert.equal((await env.recognize()).status, 200); assert.equal(env.calls, 3); assert.equal(env.store.quota().used, 3);
  env.token = tokenA; assert.equal((await (await env.recognize()).json()).cached, true);
  const schema = env.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.deepEqual(schema.sort(), ['metadata', 'recognitions']);
  const stored = JSON.stringify(env.store.db.prepare('SELECT * FROM recognitions').all());
  assert.doesNotMatch(stored, /OFFLINE-IMAGE-PRIVATE|DO-NOT-EXPOSE-MEMORY-TOKEN|仅测试，不执行/);
  env.store.saveRegistration({ host_id: paired.bridge_id, client_id: 'public-client', subject: 'public-subject' });
  assert.throws(() => env.store.saveRegistration({ host_id: paired.bridge_id, client_id: 'public-client', subject: 'sub', access_token: 'NEVER-SAVE-TOKEN' }));
});

test('单并发，先持久pending再识别；pending重放不发请求，新请求busy不占额度', async t => {
  let resolveResult, started;
  const ready = new Promise(resolve => { started = resolve; });
  const result = new Promise(resolve => { resolveResult = resolve; });
  let env, calls = 0;
  env = await fixture(t, { recognitionTimeoutMs: 2000, recognizer: async () => {
    calls++;
    assert.equal(env.store.db.prepare("SELECT state FROM recognitions WHERE request_id = 'request-1'").get().state, 'pending');
    assert.equal(env.store.quota().used, 1); started(); return result;
  } });
  await env.pair(); const original = env.recognize(); await ready;
  assert.equal(await code(await env.recognize()), 'REQUEST_PENDING');
  assert.equal(await code(await env.recognize({ request_id: 'second', note: 'different' })), 'BRIDGE_BUSY');
  assert.equal(env.store.quota().used, 1); assert.equal(calls, 1);
  resolveResult(rawResult()); assert.equal((await original).status, 200);
  assert.equal((await (await env.recognize({ request_id: 'cached-during-normal-use' })).json()).cached, true); assert.equal(calls, 1);
});

test('超时及时响应，但取消后的进程清理结束前仍保持单并发；迟到结果不改failed回执', { timeout: 5000 }, async t => {
  for (const outcome of ['late-rejection', 'late-success']) {
    await t.test(outcome, async t => {
      let releaseCleanup, reportAborted, reportSettled, calls = 0;
      const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
      const aborted = new Promise(resolve => { reportAborted = resolve; });
      const settled = new Promise(resolve => { reportSettled = resolve; });
      // Release this gate even if an assertion fails; no fake background work
      // is allowed to leak into another test's temporary store.
      t.after(() => releaseCleanup());
      const env = await fixture(t, { recognitionTimeoutMs: 25, recognizer: async (_input, { signal }) => {
        calls++;
        if (calls > 1) return rawResult();
        await new Promise(resolve => signal.addEventListener('abort', () => { reportAborted(); resolve(); }, { once: true }));
        await cleanup; // Simulate a CLI process tree and original-image cleanup.
        reportSettled();
        if (outcome === 'late-rejection') throw new PlanError(499, 'PLAN_CANCELLED', '离线取消已完成');
        return rawResult();
      } });
      await env.pair();
      const original = env.recognize(); await aborted;
      // The HTTP response must arrive while cleanup is deliberately blocked.
      const timeout = await original; assert.equal(timeout.status, 504);
      assert.equal(await code(timeout), 'RECOGNITION_TIMEOUT');
      assert.equal(await code(await env.recognize({ request_id: 'after-timeout', note: 'new work' })), 'BRIDGE_BUSY');
      assert.equal(await code(await env.recognize()), 'REQUEST_FAILED');
      assert.equal(calls, 1); assert.equal(env.store.quota().used, 1);
      assert.equal(env.store.db.prepare("SELECT COUNT(*) AS count FROM recognitions WHERE request_id = 'after-timeout'").get().count, 0);
      releaseCleanup(); await settled;
      const next = await env.recognize({ request_id: 'after-timeout', note: 'new work' });
      assert.equal(next.status, 200); assert.equal(calls, 2); assert.equal(env.store.quota().used, 2);
      const originalRecord = env.store.db.prepare("SELECT state, result_json FROM recognitions WHERE request_id = 'request-1'").get();
      assert.equal(originalRecord.state, 'failed'); assert.equal(originalRecord.result_json, null);
      assert.equal(await code(await env.recognize()), 'REQUEST_FAILED'); assert.equal(calls, 2);
    });
  }
});

test('失败与超时均占额度且同ID永不自动重调；无效结构不伪报completed', async t => {
  for (const mode of ['failed', 'timeout', 'invalid']) {
    await t.test(mode, async t => {
      let calls = 0;
      const env = await fixture(t, { recognitionTimeoutMs: 15, recognizer: async () => {
        calls++; if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'invalid') return { title: 'missing schema fields', tools: ['command'] };
        throw Object.assign(Error('NEVER-ECHO-PRIVATE-TOKEN'), { code: 'CODEX_UPSTREAM' });
      } });
      await env.pair(); const response = await env.recognize(); assert.equal(response.status, mode === 'timeout' ? 504 : 502);
      const body = await response.json(); assert.equal(body.completed, false); assert.doesNotMatch(JSON.stringify(body), /NEVER-ECHO/);
      assert.equal(await code(await env.recognize()), 'REQUEST_FAILED'); assert.equal(calls, 1); assert.equal(env.store.quota().used, 1);
      assert.equal(env.store.db.prepare('SELECT state FROM recognitions').get().state, 'failed');
    });
  }
});

test('本机host每日十次含失败，跨scope不能重置额度；上海跨日才恢复', async t => {
  let now = Date.parse('2026-10-16T15:59:59Z');
  const env = await fixture(t, { now: () => now }); await env.pair();
  for (let index = 0; index < 10; index++) assert.equal((await env.recognize({ request_id: 'q-' + index, note: 'unique note ' + index })).status, 200);
  assert.deepEqual(env.store.quota(), { day: '2026-10-16', used: 10, max: 10 });
  assert.equal((await env.recognize({ request_id: 'over-limit', note: 'new' })).status, 429);
  await env.pair(scopeB); assert.equal((await env.recognize({ request_id: 'new-scope' })).status, 429);
  assert.equal(env.calls, 10); now += 1000;
  assert.deepEqual(env.store.quota(), { day: '2026-10-17', used: 0, max: 10 });
  assert.equal((await env.recognize({ request_id: 'tomorrow' })).status, 200); assert.equal(env.calls, 11);
});

test('重启保留public host/registration和成功缓存，但忘记所有配对Bearer', async t => {
  const env = await fixture(t); const first = await env.pair();
  env.store.saveRegistration({ host_id: first.bridge_id, client_id: 'issued-public-id', subject: 'public-subject' });
  assert.equal((await env.recognize()).status, 200);
  const oldToken = env.token; await env.restart();
  assert.equal((await env.request('/status')).status, 401);
  const second = await env.pair(); assert.equal(second.bridge_id, first.bridge_id); assert.notEqual(second.token, oldToken);
  assert.deepEqual(env.store.registration, { host_id: first.bridge_id, client_id: 'issued-public-id', subject: 'public-subject' });
  assert.equal((await (await env.recognize()).json()).cached, true); assert.equal(env.calls, 1); assert.equal(env.store.quota().used, 1);
  const bytes = fs.readdirSync(env.dir).map(filename => fs.readFileSync(path.join(env.dir, filename)));
  for (const content of bytes) { assert.equal(content.includes(Buffer.from(oldToken)), false); assert.equal(content.includes(png), false); assert.equal(content.includes(Buffer.from('DO-NOT-EXPOSE-MEMORY-TOKEN')), false); }
});

test('真实identity/transport模块与HTTP桥对接：URN安装ID、Uint8Array图片、tools空集和信号传递', async t => {
  let transportCalls = 0;
  const env = await fixture(t, { recognizer: (input, options) => recognizeWithPlan(input, { ...options, fetchImpl: async (url, init) => {
    transportCalls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body); assert.deepEqual(body.tools, []); assert.equal(body.store, false); assert.equal(body.stream, true);
    const image = body.input[0].content.find(item => item.type === 'input_image');
    assert.deepEqual(Buffer.from(image.image_url.split(',')[1], 'base64'), png);
    const completed = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(rawResult()) }] }] } };
    return new Response('data: ' + JSON.stringify(completed) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } }) });
  assert.match(env.store.hostId, /^urn:uuid:/);
  const disconnected = createIdentity({ hostId: env.store.hostId, redirectUri: env.base + '/auth/callback', fetchImpl: async () => { throw Error('No OAuth request allowed'); } });
  assert.equal(disconnected.status().connected, false);
  await env.pair(); assert.equal((await env.recognize()).status, 200); assert.equal(transportCalls, 1);
});

test('保留已审查PlanError状态；账号在模型校验期间变更不调用识别或扣额度', async t => {
  const env = await fixture(t); await env.pair();
  env.identity.models = async () => { throw new PlanError(503, 'PLAN_TEMPORARY', '计划授权暂时无法核对'); };
  const unavailable = await env.request('/models'); assert.equal(unavailable.status, 503); assert.equal(await code(unavailable), 'PLAN_TEMPORARY');
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  env.identity.models = async () => { started(); await gate; return [{ slug: model, display_name: '测试' }]; };
  const request = env.recognize(); await ready; env.identity.setAccount('changed-account'); release();
  const changed = await request; assert.equal(changed.status, 409); assert.equal(await code(changed), 'OAUTH_SUPERSEDED');
  assert.equal(env.calls, 0); assert.equal(env.store.quota().used, 0);
});

test('本机退出账号会立即取消在途识别并保留失败计数，不等到最长deadline', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const env = await fixture(t, { recognitionTimeoutMs: 1000, recognizer: async (_input, { signal }) => {
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new PlanError(499, 'PLAN_CANCELLED', '本次识别已停止')), { once: true }));
  } });
  await env.pair(); const request = env.recognize(); await ready;
  const portal = await env.portal();
  const logout = await env.request('/portal/logout', { method: 'POST', origin: env.base,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: portal.nonce }) });
  assert.equal(logout.status, 200); const cancelled = await request; assert.equal(cancelled.status, 499); assert.equal(await code(cancelled), 'PLAN_CANCELLED');
  assert.equal(env.store.quota().used, 1); assert.equal(env.store.db.prepare('SELECT state FROM recognitions').get().state, 'failed');
});

test('七天后只清结果，ID冲突/失败/pending防重与额度元数据跨重启保留', () => {
  const temporary = temporaryDirectory(); let now = Date.parse('2026-10-16T08:00:00Z');
  let store = new BridgeStore({ stateDir: temporary.dir, now: () => now });
  const input = requestId => ({ scope: scopeA, requestId, fingerprint: hash(requestId), accountKey: 'account', model, imageSha256: hash(png) });
  try {
    store.reserve(input('success')); store.succeed(scopeA, 'success', rawResult());
    store.reserve(input('failed')); store.fail(scopeA, 'failed', 'CODEX_TIMEOUT'); store.reserve(input('pending'));
    assert.equal(store.quota().used, 3); const hostId = store.hostId; store.close();
    now += RESULT_RETENTION_MS + 1; store = new BridgeStore({ stateDir: temporary.dir, now: () => now }); assert.equal(store.hostId, hostId);
    assert.equal(store.db.prepare("SELECT result_json FROM recognitions WHERE request_id = 'success'").get().result_json, null);
    for (const [id, code] of [['success', 'RESULT_EXPIRED'], ['failed', 'REQUEST_FAILED'], ['pending', 'REQUEST_PENDING']]) assert.throws(() => store.reserve(input(id)), error => error.code === code);
    assert.throws(() => store.reserve({ ...input('success'), fingerprint: 'different' }), error => error.code === 'REQUEST_CONFLICT');
    assert.equal(store.db.prepare('SELECT SUM(charged) AS n FROM recognitions').get().n, 3);
    assert.equal(store.quota().used, 0);
  } finally { store.close(); temporary.remove(); }
});
