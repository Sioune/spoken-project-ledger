import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createIdentity } from '../scripts/codex-bridge/identity.mjs';

const require = createRequire(new URL('../scripts/codex-bridge/package.json', import.meta.url));
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import(pathToFileURL(require.resolve('jose')).href);
const key = await generateKeyPair('ES256');
const wrongKey = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'unit', alg: 'ES256' }] });
const issuer = 'https://auth.openai.com', endpoint = `${issuer}/api/accounts/oauth/token`;
const redirectUri = 'http://127.0.0.1:5197/auth/callback';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const secret = 'PRIVATE_ACCESS_TOKEN_DO_NOT_LEAK';
async function signed(nonce, { subject = 'unit-subject', audience = 'oaiapp_unit', iss = issuer, expiry, signer = key.privateKey, ...claims } = {}, clock) {
  return new SignJWT({ nonce, email: 'unit@example.test', ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'unit' }).setIssuer(iss).setAudience(audience).setSubject(subject).setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(expiry ?? Math.floor(clock / 1000) + 3600).sign(signer);
}
function fixture(options = {}) {
  let clock = Date.UTC(2026, 9, 17, 1); const calls = [], saved = [], queue = [];
  const hostId = `urn:uuid:${randomUUID()}`;
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); const response = queue.shift(); if (!response) throw new Error('Unexpected network call PRIVATE_ACCESS_TOKEN_DO_NOT_LEAK'); return typeof response === 'function' ? response(url, init) : response; };
  const identity = createIdentity({ hostId, redirectUri, fetchImpl, jwks, now: () => clock, saveRegistration: async record => { saved.push(structuredClone(record)); }, ...options });
  return { identity, calls, saved, queue, hostId, advance: ms => { clock += ms; }, clock: () => clock, async login({ claims, response = {}, callback = {}, issued = 'oaiapp_unit' } = {}) {
    const url = new URL(identity.start());
    queue.push(Response.json({ access_token: secret, refresh_token: 'PRIVATE_REFRESH_TOKEN', id_token: await signed(url.searchParams.get('nonce'), claims, clock), token_type: 'Bearer', expires_in: 3600, scope: scopes, ...response }));
    const result = await identity.callback(new URLSearchParams({ code: 'unit-code', state: url.searchParams.get('state'), client_id: issued, ...callback }));
    return { result, url };
  } };
}
const check = (code, status) => error => error.code === code && error.status === status && !String(error).includes('PRIVATE_');

test('只接受固定loopback回调和稳定安装编号，不接受凭据注册字段', () => {
  for (const url of ['http://localhost:5197/auth/callback', 'http://0.0.0.0:5197/auth/callback', 'https://127.0.0.1:5197/auth/callback', 'http://127.0.0.1:5197/callback', `${redirectUri}?next=bad`]) assert.throws(() => fixture({ redirectUri: url }), check('CALLBACK_URI', 400));
  assert.throws(() => fixture({ hostId: 'unit' }), check('HOST_ID', 400));
  assert.throws(() => fixture({ registration: { access_token: secret } }), check('REGISTRATION', 400));
});

test('首次注册生成PKCE/state/nonce，不发送网络、不复用桌面凭据', async () => {
  const f = fixture(), first = new URL(f.identity.start()), second = new URL(f.identity.start());
  assert.equal(first.origin + first.pathname, `${issuer}/api/accounts/authorize`);
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('agent_name_hint'), '项目簿本机识图');
  assert.equal(first.searchParams.get('ext_agent_host_id'), f.hostId);
  assert.equal(first.searchParams.get('scope'), scopes); assert.equal(first.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(first.searchParams.get('redirect_uri'), redirectUri);
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.notEqual(first.searchParams.get('nonce'), second.searchParams.get('nonce'));
  assert.equal(f.calls.length, 0); assert.equal(f.saved.length, 0);
  assert.deepEqual(f.identity.status(), { connected: false, plan_authorized: false, account_label: null, account_key: null });
});

test('正式回调验证JWT并仅保存非secret注册，code exchange使用issued ID和同一redirect', async () => {
  const f = fixture(); const { result, url } = await f.login();
  assert.equal(result.connected, true); assert.equal(result.plan_authorized, true); assert.equal(result.account_label, 'unit@example.test'); assert.match(result.account_key, /^[a-f0-9]{64}$/);
  assert.equal(await f.identity.accessToken(), secret); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.saved, [{ host_id: f.hostId, client_id: 'oaiapp_unit', subject: '' }, { host_id: f.hostId, client_id: 'oaiapp_unit', subject: 'unit-subject' }]);
  const request = f.calls[0]; assert.equal(request.url, endpoint); assert.equal(request.init.redirect, 'error');
  const form = request.init.body; assert.equal(form.get('client_id'), 'oaiapp_unit'); assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('redirect_uri'), redirectUri); assert.equal(form.get('resource'), 'https://api.openai.com/v1'); assert.equal(form.has('client_secret'), false);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(JSON.stringify([f.saved, f.identity.status()]).includes('PRIVATE_'), false);
  await assert.rejects(f.identity.callback(new URLSearchParams({ code: 'unit-code', state: url.searchParams.get('state') })), check('OAUTH_EXPIRED', 400));
});

test('state错误、重复字段、拒绝和五分钟过期均不交换code', async () => {
  const f = fixture(), url = new URL(f.identity.start());
  await assert.rejects(f.identity.callback(new URLSearchParams({ state: 'wrong', code: 'unit-code', client_id: 'oaiapp_unit' })), check('OAUTH_STATE', 400));
  await assert.rejects(f.identity.callback(new URLSearchParams({ state: '中'.repeat(43), code: 'unit-code', client_id: 'oaiapp_unit' })), check('OAUTH_STATE', 400));
  await assert.rejects(f.identity.callback(new URLSearchParams(`state=${url.searchParams.get('state')}&state=duplicate&code=x`)), check('OAUTH_CALLBACK', 400));
  await assert.rejects(f.identity.callback(new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied', error_description: secret })), check('OAUTH_DENIED', 403));
  const next = new URL(f.identity.start()); f.advance(300001);
  await assert.rejects(f.identity.callback(new URLSearchParams({ state: next.searchParams.get('state'), code: 'x', client_id: 'oaiapp_unit' })), check('OAUTH_EXPIRED', 400));
  assert.equal(f.calls.length, 0);
});

test('返回登录重用issued ID；拒绝client替换和身份替换，保留活跃连接', async () => {
  const f = fixture(); await f.login(); const before = f.identity.status(), url = new URL(f.identity.start());
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_unit'); assert.equal(url.searchParams.has('agent_name_hint'), false);
  await assert.rejects(f.identity.callback(new URLSearchParams({ code: 'x', state: url.searchParams.get('state'), client_id: 'oaiapp_attacker' })), check('OAUTH_CALLBACK', 400));
  await assert.rejects(f.login({ claims: { subject: 'attacker' }, response: { access_token: 'PRIVATE_ATTACKER_TOKEN' } }), check('OAUTH_IDENTITY', 401));
  assert.deepEqual(f.identity.status(), before); assert.equal(await f.identity.accessToken(), secret);
});

test('JWT签名、issuer、audience、expiry、nonce和sub逐项强制验证', async () => {
  for (const claims of [{ signer: wrongKey.privateKey }, { iss: 'https://attacker.test' }, { audience: 'oaiapp_other' }, { expiry: Math.floor(Date.UTC(2026, 9, 16) / 1000) }, { nonce: 'wrong' }, { subject: '' }]) {
    const f = fixture(); await assert.rejects(f.login({ claims }), check('OAUTH_IDENTITY', 401)); assert.equal(f.identity.status().connected, false);
  }
});

test('成功身份登录不等于计划授权，未授scope零模型调用', async () => {
  const f = fixture(); const { result } = await f.login({ response: { scope: 'openid profile email' } });
  assert.equal(result.connected, true); assert.equal(result.plan_authorized, false);
  await assert.rejects(f.identity.models(), check('PLAN_UNAUTHORIZED', 403)); assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.identity.start()).searchParams.get('prompt'), 'consent');
});

test('近到期刷新singleflight、保留scope、使用旋转refresh token，无client secret', async () => {
  const f = fixture(); await f.login({ response: { expires_in: 120 } }); f.advance(90000);
  f.queue.push(Response.json({ access_token: 'PRIVATE_ACCESS_NEW', refresh_token: 'PRIVATE_REFRESH_NEW', token_type: 'Bearer', expires_in: 120 }));
  assert.deepEqual(await Promise.all([f.identity.accessToken(), f.identity.accessToken(), f.identity.accessToken()]), ['PRIVATE_ACCESS_NEW', 'PRIVATE_ACCESS_NEW', 'PRIVATE_ACCESS_NEW']);
  assert.equal(f.calls.length, 2); const first = f.calls[1].init.body;
  assert.equal(first.get('grant_type'), 'refresh_token'); assert.equal(first.get('client_id'), 'oaiapp_unit'); assert.equal(first.get('refresh_token'), 'PRIVATE_REFRESH_TOKEN'); assert.equal(first.has('scope'), false); assert.equal(first.has('client_secret'), false);
  f.advance(90000); f.queue.push(Response.json({ access_token: 'PRIVATE_ACCESS_FINAL', refresh_token: 'PRIVATE_REFRESH_FINAL', token_type: 'Bearer', expires_in: 3600 }));
  assert.equal(await f.identity.accessToken(), 'PRIVATE_ACCESS_FINAL'); assert.equal(f.calls[2].init.body.get('refresh_token'), 'PRIVATE_REFRESH_NEW'); assert.equal(f.identity.status().plan_authorized, true);
});

test('刷新不能更换身份、取消授权后阻止推理；安全处理invalid_grant', async () => {
  const f = fixture(); await f.login({ response: { expires_in: 1 } });
  f.queue.push(Response.json({ error: 'invalid_grant', error_description: secret }, { status: 400 }));
  await assert.rejects(f.identity.accessToken(), check('OAUTH_REAUTH', 401));
  assert.equal(f.identity.status().connected, false);
  await assert.rejects(f.identity.accessToken(), check('OAUTH_REQUIRED', 401));
  assert.equal(f.calls.length, 2);
  await f.login({ response: { expires_in: 1 } });
  f.queue.push(Response.json({ access_token: 'PRIVATE_NEW', token_type: 'Bearer', expires_in: 3600, scope: 'openid' }));
  await assert.rejects(f.identity.accessToken(), check('PLAN_UNAUTHORIZED', 403)); assert.equal(f.identity.status().plan_authorized, false);
  assert.equal(f.calls.length, 4);
});

test('目录仅返回当前账号可见模型，保持顺序且不泄露额外字段', async () => {
  const f = fixture(); await f.login();
  f.queue.push(Response.json({ models: [{ slug: 'model-z', display_name: '乙', visibility: 'list', private: secret }, { slug: 'hidden', display_name: '隐藏', visibility: 'hide' }, { slug: 'model-a', display_name: '甲', visibility: 'list' }] }));
  assert.deepEqual(await f.identity.models(), [{ slug: 'model-z', display_name: '乙' }, { slug: 'model-a', display_name: '甲' }]);
  const request = f.calls.at(-1); assert.equal(request.url, 'https://api.openai.com/v1/models'); assert.equal(request.init.headers.Authorization, `Bearer ${secret}`); assert.equal(request.init.redirect, 'error');
  f.queue.push(Response.json({ models: [{ slug: 'a', display_name: '甲', visibility: 'list' }, { slug: 'a', display_name: '重复', visibility: 'list' }] }));
  await assert.rejects(f.identity.models(), check('MODEL_CATALOG', 502));
  f.queue.push(Response.json({ models: Array.from({ length: 1001 }, (_, i) => ({ slug: `m${i}`, display_name: `M${i}`, visibility: 'list' })) }));
  await assert.rejects(f.identity.models(), check('MODEL_CATALOG', 502));
});

test('退出先清内存和pending，再向官方discovery声明的端点撤销refresh', async () => {
  const f = fixture(); await f.login(); const url = new URL(f.identity.start());
  f.queue.push(Response.json({ issuer, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke` })); f.queue.push(new Response('', { status: 200 }));
  assert.equal((await f.identity.logout()).connected, false);
  await assert.rejects(f.identity.accessToken(), check('OAUTH_REQUIRED', 401));
  await assert.rejects(f.identity.callback(new URLSearchParams({ code: 'x', state: url.searchParams.get('state') })), check('OAUTH_EXPIRED', 400));
  assert.equal(f.calls[1].url, `${issuer}/.well-known/openid-configuration`); assert.equal(f.calls[2].init.body.get('token_type_hint'), 'refresh_token'); assert.equal(f.calls[2].init.body.get('client_id'), 'oaiapp_unit'); assert.equal(f.calls[2].init.redirect, 'error');
  assert.equal(new URL(f.identity.start()).searchParams.get('client_id'), 'oaiapp_unit');
});

test('退出远程未确认仍清本机，拒绝discovery的跨域撤销地址', async () => {
  const f = fixture(); await f.login(); f.queue.push(Response.json({ issuer, revocation_endpoint: 'https://attacker.test/steal' }));
  await assert.rejects(f.identity.logout(), check('LOGOUT_UNCONFIRMED', 503)); assert.equal(f.identity.status().connected, false); assert.equal(f.calls.length, 2);
});

test('旧登录回调和旧刷新不得在logout后恢复连接', async () => {
  const f = fixture(), url = new URL(f.identity.start()); let resolve;
  const token = await signed(url.searchParams.get('nonce'), {}, f.clock());
  f.queue.push(() => new Promise(done => { resolve = done; }));
  const callback = f.identity.callback(new URLSearchParams({ code: 'x', state: url.searchParams.get('state'), client_id: 'oaiapp_unit' }));
  while (!resolve) await new Promise(done => setImmediate(done));
  await f.identity.logout(); resolve(Response.json({ access_token: secret, token_type: 'Bearer', expires_in: 3600, scope: scopes, id_token: token }));
  await assert.rejects(callback, check('OAUTH_SUPERSEDED', 409)); assert.equal(f.identity.status().connected, false);
});

test('错误响应和底层网络错误不回显token、响应body或原始异常', async () => {
  const f = fixture(); const url = new URL(f.identity.start()); f.queue.push(() => { throw new Error(`${secret} PRIVATE_REFRESH_TOKEN`); });
  await assert.rejects(f.identity.callback(new URLSearchParams({ code: 'x', state: url.searchParams.get('state'), client_id: 'oaiapp_unit' })), check('OPENAI_NETWORK', 503));
  const next = new URL(f.identity.start()); f.queue.push(Response.json({ error: secret }, { status: 500 }));
  await assert.rejects(f.identity.callback(new URLSearchParams({ code: 'x', state: next.searchParams.get('state') })), check('OPENAI_HTTP', 502));
  for (const [status, code, outputStatus] of [[401, 'OAUTH_REAUTH', 401], [403, 'PLAN_UNAUTHORIZED', 403], [429, 'OPENAI_RATE_LIMIT', 429], [500, 'OPENAI_HTTP', 502]]) {
    const url = new URL(f.identity.start()); f.queue.push(new Response(`PRIVATE_BODY ${secret}`, { status }));
    await assert.rejects(f.identity.callback(new URLSearchParams({ code: 'x', state: url.searchParams.get('state') })), check(code, outputStatus));
  }
});

test('刷新ID token不得换账号；logout中的旧刷新不能恢复内存连接', async () => {
  const f = fixture(); await f.login({ response: { expires_in: 1 } });
  f.queue.push(Response.json({ access_token: 'PRIVATE_OTHER', token_type: 'Bearer', expires_in: 3600, scope: scopes, id_token: await signed(undefined, { subject: 'other-sub' }, f.clock()) }));
  await assert.rejects(f.identity.accessToken(), check('OAUTH_IDENTITY', 401));
  let resolve; f.queue.push(() => new Promise(done => { resolve = done; }));
  const refreshing = f.identity.accessToken(); while (!resolve) await new Promise(done => setImmediate(done));
  f.queue.push(Response.json({ issuer, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke` })); f.queue.push(new Response('', { status: 200 }));
  await f.identity.logout(); resolve(Response.json({ access_token: 'PRIVATE_OLD_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: scopes }));
  await assert.rejects(refreshing, check('OAUTH_SUPERSEDED', 409)); assert.equal(f.identity.status().connected, false);
});
