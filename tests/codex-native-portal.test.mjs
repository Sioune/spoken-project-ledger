import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeServer, SITE_ORIGIN } from '../scripts/codex-bridge/server.mjs';

// Native identity is fully fake. Only this test's random loopback listener and
// isolated temporary SQLite are used; no CLI, OAuth or model call is possible.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'spoken-native-portal-'));
  const calls = { refresh: 0, models: 0, start: 0, callback: 0, logout: 0, recognize: 0 };
  const identity = {
    kind: 'codex-cli',
    status: () => ({ connected: true, plan_authorized: true, account_label: '离线CLI账号', account_key: 'offline-native-account' }),
    async refresh() { calls.refresh++; },
    async models() { calls.models++; return [{ slug: 'gpt-offline-test', display_name: '离线模型' }]; },
    start() { calls.start++; assert.fail('Native portal must not start OAuth'); },
    async callback() { calls.callback++; assert.fail('Native portal must not process OAuth callbacks'); },
    async logout() { calls.logout++; assert.fail('Native portal must not log out the shared CLI'); },
  };
  const bridge = createBridgeServer({ stateDir: directory, port: 0, identity, recognizer: async () => { calls.recognize++; assert.fail('No native model call allowed'); } });
  const origin = await bridge.listen();
  t.after(async () => {
    await bridge.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('spoken-native-portal-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const request = (route, { token, site = false, headers = {}, ...init } = {}) => fetch(origin + route, { ...init, redirect: 'manual', headers: { ...(site ? { Origin: SITE_ORIGIN } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  async function portal() { const response = await request('/'); assert.equal(response.status, 200); const html = await response.text(); return { html, code: html.match(/<output id="pair-code">(\d{8})<\/output>/)?.[1], csrf: html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] }; }
  async function pair(scope) { const { code } = await portal(); assert.match(code, /^\d{8}$/); const response = await request('/pair', { method: 'POST', site: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, scope }) }); assert.equal(response.status, 200); return (await response.json()).token; }
  const form = (route, csrf) => request(route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
  return { origin, request, portal, pair, form, identity, calls };
}

test('native连接页面仅检查已有CLI并配对，不显示独立OAuth登录或退出账号入口', async t => {
  const env = await fixture(t), { html } = await env.portal();
  assert.match(html, /Codex CLI 已登录/); assert.match(html, /复用本机 Codex 登录/); assert.match(html, /ephemeral/); assert.match(html, /临时/);
  assert.match(html, /停用本机网页连接/); assert.match(html, /action="\/portal\/logout"/);
  assert.doesNotMatch(html, /action="\/portal\/connect"|auth\.openai\.com|通过官方页面连接|断开 Codex 账号/);
  assert.equal(env.calls.refresh, 1); assert.equal(env.calls.start + env.calls.callback + env.calls.logout + env.calls.recognize, 0);
});

test('native旧connect路径拒绝，旧OAuth callback只跳转干净首页且不调用OAuth适配器', async t => {
  const env = await fixture(t), { csrf } = await env.portal();
  const connect = await env.form('/portal/connect', csrf); assert.equal(connect.status, 410); assert.equal((await connect.json()).code, 'NATIVE_LOGIN'); assert.equal(connect.headers.get('location'), null);
  const callback = await env.request('/auth/callback?code=offline-never-consume&state=offline-never-consume'); assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/');
  assert.doesNotMatch(await callback.text(), /offline-never-consume/); assert.equal(env.calls.start, 0); assert.equal(env.calls.callback, 0); assert.equal(env.calls.logout, 0); assert.equal(env.calls.recognize, 0);
});

test('停用网页连接受CSRF保护并撤销全部pair，保留共享CLI登录且可重新配对', async t => {
  const env = await fixture(t), tokenA = await env.pair('a'.repeat(64)), tokenB = await env.pair('b'.repeat(64));
  for (const token of [tokenA, tokenB]) assert.equal((await env.request('/status', { site: true, token })).status, 200);
  const rejected = await env.form('/portal/logout', 'invalid-csrf'); assert.equal(rejected.status, 403); assert.equal((await env.request('/status', { site: true, token: tokenA })).status, 200);
  const { csrf } = await env.portal(), stopped = await env.form('/portal/logout', csrf); assert.equal(stopped.status, 200); assert.match(await stopped.text(), /本机 Codex 登录保持不变/);
  for (const token of [tokenA, tokenB]) { const response = await env.request('/status', { site: true, token }); assert.equal(response.status, 401); assert.equal((await response.json()).code, 'PAIR_REQUIRED'); }
  assert.equal(env.identity.status().connected, true); assert.equal(env.calls.logout, 0); assert.equal(env.calls.recognize, 0);
  const fresh = await env.pair('a'.repeat(64)), response = await env.request('/status', { site: true, token: fresh }); assert.equal(response.status, 200); const status = await response.json(); assert.equal(status.connected, true); assert.equal(status.auth_mode, 'codex-cli');
});
