import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const APP_NAME = '项目簿本机识图';
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const clientIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{3,200}$/.test(value) && value !== 'dynamic_agent_client';

export class PlanError extends Error {
  constructor(status, code, message) { super(message); this.name = 'PlanError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => new PlanError(status, code, message);

async function readJson(response, maximum) {
  if (!response.body) throw fail(502, 'OPENAI_RESPONSE', '授权服务返回了空响应，请重新操作。');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) throw fail(502, 'OPENAI_RESPONSE', '授权服务响应过大，已停止处理。');
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(data)) throw new Error('shape');
    return data;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Response contents are never logged. */ }
    if (error instanceof PlanError) throw error;
    throw fail(502, 'OPENAI_RESPONSE', '授权服务响应无法核验，请重新操作。');
  } finally { reader.releaseLock(); }
}

// This factory deliberately has no filesystem or existing Codex-auth access.
export function createIdentity({ hostId, registration, saveRegistration = async () => {}, redirectUri, fetchImpl = globalThis.fetch, jwks, now = Date.now } = {}) {
  if (typeof hostId !== 'string' || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId)) throw fail(400, 'HOST_ID', '本机安装编号无效。');
  let redirect;
  try { redirect = new URL(redirectUri); } catch { throw fail(400, 'CALLBACK_URI', '本机登录回调地址无效。'); }
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.pathname !== '/auth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password || redirect.href !== redirectUri) throw fail(400, 'CALLBACK_URI', '本机登录回调须使用127.0.0.1的固定回调路径。');
  let saved = null;
  if (registration != null) {
    if (!object(registration) || Object.keys(registration).some(key => !['host_id', 'client_id', 'subject'].includes(key)) || registration.host_id !== hostId || !clientIdValid(registration.client_id) || typeof registration.subject !== 'string' || registration.subject.length > 512) throw fail(400, 'REGISTRATION', '本机注册记录无效，请核对安装记录。');
    saved = { ...registration };
  }
  const clock = () => { const value = now(); return typeof value === 'number' ? value : new Date(value).getTime(); };
  let pending = null, active = null, generation = 0, refreshPromise = null;

  async function requestJson(url, init = {}, maximum = 131072) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(504, 'OPENAI_TIMEOUT', '授权服务响应超时，请稍后重试。')); }, 20000); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
        if (!response.ok) {
          let data = {};
          // Only the OAuth invalid_grant classification needs an error-body field.
          if (response.status === 400) { try { data = await readJson(response, maximum); } catch { /* Never reflect provider diagnostics. */ } }
          else { try { await response.body?.cancel(); } catch { /* HTTP status is sufficient. */ } }
          if (response.status === 400 && ['invalid_grant', 'invalid_token', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(data.error) || response.status === 401) throw fail(401, 'OAUTH_REAUTH', 'ChatGPT授权已失效，请重新登录。');
          if (response.status === 403) throw fail(403, 'PLAN_UNAUTHORIZED', 'ChatGPT计划尚未授权或当前账号无权访问。');
          if (response.status === 429) throw fail(429, 'OPENAI_RATE_LIMIT', 'ChatGPT请求过于频繁或额度已达上限，请稍后再试。');
          throw fail(502, 'OPENAI_HTTP', 'ChatGPT授权服务暂时不可用，请稍后重试。');
        }
        return await readJson(response, maximum);
      })()]);
    } catch (error) {
      controller.abort();
      if (error instanceof PlanError) throw error;
      throw fail(503, 'OPENAI_NETWORK', '无法连接ChatGPT授权服务，请检查网络。');
    } finally { clearTimeout(timer); }
  }

  const keySet = jwks ?? createRemoteJWKSet(new URL(JWKS), { timeoutDuration: 15000, [customFetch]: (url, init) => fetchImpl(url, { ...init, redirect: 'error' }) });
  async function verify(idToken, clientId, nonce, subject, refreshing = false) {
    try {
      const { payload } = await jwtVerify(idToken, keySet, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], currentDate: new Date(clock()), clockTolerance: 5, algorithms: ['RS256', 'ES256'] });
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512 || subject && payload.sub !== subject || (!refreshing || payload.nonce !== undefined) && !safeEqual(payload.nonce, nonce)) throw new Error('identity');
      return payload;
    } catch { throw fail(401, 'OAUTH_IDENTITY', 'ChatGPT身份签名或登录信息无法核验，请重新登录。'); }
  }
  function tokens(data, previous = null) {
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 32768 || !/^Bearer$/i.test(data.token_type ?? '') || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000 || data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 32768) || data.scope !== undefined && typeof data.scope !== 'string') throw fail(502, 'OAUTH_TOKEN', 'ChatGPT授权凭据格式无效，请重新登录。');
    const scopes = data.scope === undefined ? previous?.scopes ?? [] : data.scope.split(/\s+/).filter(Boolean);
    return { access: data.access_token, refresh: data.refresh_token ?? previous?.refresh ?? null, id: data.id_token ?? previous?.id ?? null, expires: clock() + data.expires_in * 1000, scopes };
  }
  async function persist(record) {
    try { await saveRegistration({ ...record }); } catch { throw fail(500, 'REGISTRATION_SAVE', '本机注册信息未能保存，请检查本机存储。'); }
    saved = { ...record };
  }
  function status() {
    return { connected: !!active, plan_authorized: !!active?.scopes.includes(PLAN_SCOPE), account_label: active?.label ?? null, account_key: active ? hash(`${ISSUER}\0${active.clientId}\0${active.subject}`) : null };
  }
  function start() {
    const verifier = random(), state = random(), nonce = random(); const attempt = ++generation;
    pending = { verifier, state, nonce, expires: clock() + 300000, clientId: saved?.client_id ?? null, subject: saved?.subject || null, generation: attempt };
    const url = new URL(AUTHORIZE);
    const params = { client_id: pending.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
    if (!pending.clientId) params.agent_name_hint = APP_NAME;
    // A second explicit sign-in can enable plan usage after an earlier decline.
    if (active && !active.scopes.includes(PLAN_SCOPE)) params.prompt = 'consent';
    // This URL stays in the local process/browser; no token hints enter the hosted UI.
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }
  async function callback(params) {
    if (!(params instanceof URLSearchParams) || ['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1)) throw fail(400, 'OAUTH_CALLBACK', '登录回调格式无效。');
    const attempt = pending;
    if (!attempt || attempt.expires <= clock()) { pending = null; throw fail(400, 'OAUTH_EXPIRED', '这次登录已过期，请重新发起登录。'); }
    if (!safeEqual(params.get('state'), attempt.state)) throw fail(400, 'OAUTH_STATE', '登录校验不匹配，已拒绝这次回调。');
    pending = null;
    if (params.has('error')) throw fail(403, 'OAUTH_DENIED', '尚未完成ChatGPT授权，可重新登录或继续手动录入。');
    const code = params.get('code'), issued = params.get('client_id') ?? attempt.clientId;
    if (typeof code !== 'string' || !code || code.length > 8192 || !clientIdValid(issued) || attempt.clientId && issued !== attempt.clientId) throw fail(400, 'OAUTH_CALLBACK', '登录回调缺少有效授权编号。');
    // Retain the newly issued registration even when a code subsequently expires.
    if (!attempt.clientId) await persist({ host_id: hostId, client_id: issued, subject: '' });
    const data = await requestJson(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: attempt.verifier, redirect_uri: redirectUri, resource: RESOURCE }) });
    if (typeof data.id_token !== 'string') throw fail(401, 'OAUTH_IDENTITY', 'ChatGPT未返回可核验身份，请重新登录。');
    const identity = await verify(data.id_token, issued, attempt.nonce, attempt.subject);
    const next = { ...tokens(data), clientId: issued, subject: identity.sub, nonce: attempt.nonce, label: typeof identity.email === 'string' && identity.email.length <= 320 ? identity.email : '已连接ChatGPT账号' };
    if (attempt.generation !== generation) throw fail(409, 'OAUTH_SUPERSEDED', '这次登录已被新的操作替代，请查看当前连接。');
    await persist({ host_id: hostId, client_id: issued, subject: identity.sub });
    if (attempt.generation !== generation) throw fail(409, 'OAUTH_SUPERSEDED', '这次登录已被新的操作替代，请查看当前连接。');
    active = next; return status();
  }
  async function accessToken() {
    if (!active) throw fail(401, 'OAUTH_REQUIRED', '请先在本机完成ChatGPT登录。');
    if (!active.scopes.includes(PLAN_SCOPE)) throw fail(403, 'PLAN_UNAUTHORIZED', '尚未授权使用ChatGPT计划，请重新登录并确认授权。');
    if (active.expires > clock() + 60000) return active.access;
    if (!active.refresh) throw fail(401, 'OAUTH_REAUTH', 'ChatGPT授权已到期，请重新登录。');
    if (!refreshPromise) {
      const previous = active;
      refreshPromise = (async () => {
        const data = await requestJson(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refresh, resource: RESOURCE }) });
        if (data.id_token !== undefined) { if (typeof data.id_token !== 'string') throw fail(401, 'OAUTH_IDENTITY', '刷新后的ChatGPT身份无法核验。'); await verify(data.id_token, previous.clientId, previous.nonce, previous.subject, true); }
        const next = { ...previous, ...tokens(data, previous) };
        if (active !== previous) throw fail(409, 'OAUTH_SUPERSEDED', 'ChatGPT连接已更换，请重新操作。');
        active = next;
        if (!next.scopes.includes(PLAN_SCOPE)) throw fail(403, 'PLAN_UNAUTHORIZED', 'ChatGPT计划授权已撤销，请重新确认授权。');
        return next.access;
      })().catch(error => {
        if (error instanceof PlanError && error.code === 'OAUTH_REAUTH' && active === previous) active = null;
        throw error;
      }).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }
  async function models() {
    const session = active, token = await accessToken();
    const data = await requestJson(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } }, 2097152);
    if (active?.subject !== session?.subject || active?.clientId !== session?.clientId) throw fail(409, 'OAUTH_SUPERSEDED', 'ChatGPT连接已更换，请重新加载模型。');
    if (!Array.isArray(data.models) || data.models.length > 10000) throw fail(502, 'MODEL_CATALOG', 'ChatGPT模型列表格式无效。');
    const seen = new Set(); const result = [];
    for (const item of data.models) {
      if (!object(item) || item.visibility !== 'list') continue;
      if (typeof item.slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(item.slug) || typeof item.display_name !== 'string' || !item.display_name.trim() || item.display_name.length > 300 || seen.has(item.slug)) throw fail(502, 'MODEL_CATALOG', 'ChatGPT模型列表存在无效或重复项目。');
      if (result.length >= 1000) throw fail(502, 'MODEL_CATALOG', 'ChatGPT模型列表过大，已停止处理。');
      seen.add(item.slug); result.push({ slug: item.slug, display_name: item.display_name });
    }
    return result;
  }
  async function logout() {
    const previous = active; active = null; pending = null; ++generation;
    if (!previous?.refresh) return status();
    try {
      const discovery = await requestJson(DISCOVERY);
      const endpoint = new URL(discovery.revocation_endpoint);
      if (discovery.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('endpoint');
      const controller = new AbortController(); let timer;
      try {
        const response = await Promise.race([fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: previous.refresh, token_type_hint: 'refresh_token', client_id: previous.clientId }) }), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 20000); })]);
        try { await response.body?.cancel(); } catch { /* Never read provider diagnostics. */ }
        if (response.status !== 200) throw new Error('revoke');
      } finally { clearTimeout(timer); controller.abort(); }
      return status();
    } catch { throw fail(503, 'LOGOUT_UNCONFIRMED', '本机已退出，但未确认远程授权撤销；可在ChatGPT设置中断开此应用。'); }
  }
  return { status, start, callback, models, accessToken, logout };
}
