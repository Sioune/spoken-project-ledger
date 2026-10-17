import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createNativeRuntime } from '../scripts/codex-bridge/native-runtime.mjs';
import { createNativeIdentity } from '../scripts/codex-bridge/native-identity.mjs';
import { PlanError } from '../scripts/codex-bridge/identity.mjs';

const runtime = Object.freeze({ executable: 'C:\\trusted\\codex.exe', env: Object.freeze({ SystemRoot: 'C:\\Windows' }) });
const account = email => ({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email, planType: 'plus' } });
const model = (slug, extra = {}) => ({ id: `catalog-${slug}`, model: slug, displayName: `模型 ${slug}`, hidden: false, inputModalities: ['text', 'image'], ...extra });
function fakeSpawn(handler = message => message.method === 'account/read' ? account('person@example.com') : {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const call = { executable, args, options, messages: [], child }; calls.push(call);
    child.reply = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); return true; };
    let buffer = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); call.messages.push(message);
        queueMicrotask(() => {
          const result = handler(message, call, calls);
          if (message.id !== undefined && result !== undefined) child.reply({ id: message.id, result });
        });
      }
      done();
    } });
    return child;
  };
  return { calls, spawnImpl };
}

test('native runtime is fixed, frozen and strips provider credentials/configuration', () => {
  const keys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME', 'HTTPS_PROXY', 'NODE_OPTIONS'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = key === 'CODEX_HOME' ? path.join(os.tmpdir(), 'official-cli-login-home') : 'must-not-be-inherited';
    const value = createNativeRuntime();
    assert.equal(value.executable, path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    assert.equal(value.env.CODEX_HOME, process.env.CODEX_HOME);
    for (const key of keys.filter(key => key !== 'CODEX_HOME')) assert.equal(value.env[key], undefined);
    assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.env), true);
    assert.equal(value.env.USERPROFILE, os.homedir());
    assert.throws(() => createNativeRuntime({ executable: 'C:\\evil.exe' }), error => error.code === 'CODEX_CLI_NOT_FOUND');
  } finally { for (const key of keys) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key]; }
});

test('refresh sends only initialized and read-only account RPC with minimal child options', async () => {
  const fake = fakeSpawn(); const identity = createNativeIdentity({ runtime, ...fake });
  assert.equal(identity.kind, 'codex-cli'); assert.equal(identity.status().connected, false);
  const [first, second] = await Promise.all([identity.refresh(), identity.refresh()]);
  assert.equal(fake.calls.length, 1); assert.deepEqual(first, second); assert.equal(first.connected, true);
  const call = fake.calls[0];
  assert.equal(call.executable, runtime.executable); assert.equal(call.options.env, runtime.env);
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.cwd, os.tmpdir());
  assert.deepEqual(call.messages.map(message => message.method), ['initialize', 'initialized', 'account/read']);
  assert.deepEqual(call.messages[2].params, { refreshToken: false });
  for (const feature of ['shell_tool', 'hooks', 'plugins', 'apps', 'image_generation', 'browser_use', 'computer_use', 'view_image']) assert.equal(call.args.includes(feature), true);
  for (const config of ['mcp_servers={}', 'web_search="disabled"', 'model_provider="openai"']) assert.equal(call.args.includes(config), true);
  assert.equal(call.args.includes('--ignore-user-config'), false);
  assert.equal(call.child.killed, true);
  first.account_key = 'tampered'; assert.notEqual(identity.status().account_key, 'tampered');
  const snapshot = identity.status(); snapshot.connected = false; assert.equal(identity.status().connected, true);
});

test('account is email-bound, normalized and does not expose account/provider contents', async () => {
  let email = ' Person@Example.COM ';
  const fake = fakeSpawn(message => message.method === 'account/read' ? { ...account(email), token: 'never-expose', accountSecret: 'hidden' } : {});
  const identity = createNativeIdentity({ runtime, ...fake }); const first = await identity.refresh();
  email = 'person@example.com'; assert.equal((await identity.refresh()).account_key, first.account_key);
  email = 'another@example.com'; assert.notEqual((await identity.refresh()).account_key, first.account_key);
  assert.match(first.account_key, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first).sort(), ['account_key', 'account_label', 'connected', 'plan_authorized']);
  assert.equal(JSON.stringify(first).includes('never-expose'), false);
});

test('not logged in, API key, non-ChatGPT and unidentified accounts remain disconnected', async () => {
  for (const [value, expected] of [
    [{ requiresOpenaiAuth: true, account: null }, 'CODEX_CLI_NOT_LOGGED_IN'],
    [{ requiresOpenaiAuth: false, account: { type: 'apiKey' } }, 'CODEX_CLI_ACCOUNT'],
    [{ requiresOpenaiAuth: false, account: { type: 'amazonBedrock' } }, 'CODEX_CLI_ACCOUNT'],
    [account(null), 'CODEX_CLI_ACCOUNT'], [account('missing-at'), 'CODEX_CLI_ACCOUNT'],
    [{ account: account('person@example.com').account }, 'CODEX_CLI_OUTPUT'],
  ]) {
    const fake = fakeSpawn(message => message.method === 'account/read' ? value : {});
    const identity = createNativeIdentity({ runtime, ...fake });
    const status = await identity.refresh(); assert.equal(status.connected, false); assert.equal(status.error_code, expected);
    await assert.rejects(identity.models(), error => error instanceof PlanError && error.code === expected);
  }
});

test('models reads real paginated account catalog, filters hidden/text-only and rechecks identity', async () => {
  const fake = fakeSpawn(message => {
    if (message.method === 'account/read') return account('person@example.com');
    if (message.method === 'model/list') return message.params.cursor === null
      ? { data: [model('actual-image'), model('hidden', { hidden: true }), model('text-only', { inputModalities: ['text'] })], nextCursor: 'page-2' }
      : { data: [model('actual-image'), model('vendor/image', { inputModalities: undefined })], nextCursor: null };
    return {};
  });
  const identity = createNativeIdentity({ runtime, ...fake });
  const [first, second] = await Promise.all([identity.models(), identity.models()]);
  assert.deepEqual(first, [{ slug: 'actual-image', display_name: '模型 actual-image' }, { slug: 'vendor/image', display_name: '模型 vendor/image' }]);
  assert.deepEqual(first, second); assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].messages.map(message => message.method), ['initialize', 'initialized', 'account/read', 'model/list', 'model/list', 'account/read']);
  assert.deepEqual(fake.calls[0].messages[3].params, { cursor: null, limit: 100, includeHidden: false });
  assert.equal(identity.status().connected, true);
});

test('account changes during model enumeration are rejected without retaining prior account', async () => {
  let reads = 0;
  const fake = fakeSpawn(message => message.method === 'account/read' ? account(++reads === 1 ? 'one@example.com' : 'two@example.com') : message.method === 'model/list' ? { data: [model('image')], nextCursor: null } : {});
  const identity = createNativeIdentity({ runtime, ...fake });
  await assert.rejects(identity.models(), error => error.code === 'CODEX_CLI_ACCOUNT' && error.status === 409);
  assert.equal(identity.status().connected, false); assert.equal(identity.status().account_key, null);
});

test('malformed, empty, cyclic and non-image catalogs fail shut', async () => {
  for (const result of [
    { data: [], nextCursor: null },
    { data: [model('text', { inputModalities: ['text'] })] },
    { data: [model('--arbitrary-option')] },
    { data: [model('image', { inputModalities: ['file'] })] },
    { data: [model('image')], nextCursor: 'repeated' },
    { data: 'not-an-array' },
  ]) {
    const fake = fakeSpawn(message => message.method === 'account/read' ? account('person@example.com') : message.method === 'model/list' ? result : {});
    const identity = createNativeIdentity({ runtime, ...fake });
    await assert.rejects(identity.models(), error => ['CODEX_CLI_ACCOUNT', 'CODEX_CLI_OUTPUT'].includes(error.code));
    assert.equal(fake.calls[0].child.killed, true);
  }
});

test('RPC errors are redacted and a subsequent failed refresh clears connected state', async () => {
  let failing = false;
  const fake = fakeSpawn((message, call) => {
    if (message.method === 'account/read' && failing) { call.child.reply({ id: message.id, error: { code: 999, message: 'token=private-secret-provider-data' } }); return; }
    return message.method === 'account/read' ? account('person@example.com') : {};
  });
  const identity = createNativeIdentity({ runtime, ...fake }); assert.equal((await identity.refresh()).connected, true);
  failing = true; const status = await identity.refresh(); assert.equal(status.connected, false); assert.equal(status.error_code, 'CODEX_CLI_FAILED');
  await assert.rejects(identity.models(), error => error.code === 'CODEX_CLI_FAILED' && !error.message.includes('private-secret'));
});

test('CLI protocol rejects executable tool requests, malformed JSON, unknown ids and oversized output', async () => {
  for (const [emit, expected] of [
    [child => child.reply({ id: 82, method: 'item/commandExecution/requestApproval', params: { command: 'evil' } }), 'CODEX_CLI_TOOL'],
    [child => child.stdout.write('not-json\n'), 'CODEX_CLI_OUTPUT'],
    [child => child.reply({ id: 900, result: {} }), 'CODEX_CLI_OUTPUT'],
    [child => child.stdout.write(' '.repeat(2_000_001)), 'CODEX_CLI_OUTPUT'],
  ]) {
    const fake = fakeSpawn((message, call) => { if (message.method === 'initialize') emit(call.child); return; });
    const identity = createNativeIdentity({ runtime, ...fake });
    assert.equal((await identity.refresh()).error_code, expected); assert.equal(fake.calls[0].child.killed, true);
    assert.deepEqual(fake.calls[0].messages.map(message => message.method), ['initialize']);
  }
});

test('timeouts and missing CLI are safe errors and always stop the child', async () => {
  const fake = fakeSpawn(() => undefined); const identity = createNativeIdentity({ runtime, ...fake, timeoutMs: 5 });
  assert.equal((await identity.refresh()).error_code, 'CODEX_CLI_TIMEOUT'); assert.equal(fake.calls[0].child.killed, true);
  await assert.rejects(identity.models(), error => error.code === 'CODEX_CLI_TIMEOUT' && error.status === 504);
  const missing = createNativeIdentity({ runtime, spawnImpl() { const error = new Error('private path'); error.code = 'ENOENT'; throw error; } });
  assert.equal((await missing.refresh()).error_code, 'CODEX_CLI_NOT_FOUND');
  const asynchronous = fakeSpawn(() => undefined);
  const unavailable = createNativeIdentity({ runtime, spawnImpl(...args) { const child = asynchronous.spawnImpl(...args); queueMicrotask(() => child.emit('error', Object.assign(new Error('private path'), { code: 'ENOENT' }))); return child; } });
  assert.equal((await unavailable.refresh()).error_code, 'CODEX_CLI_NOT_FOUND');
});

test('notifications are ignored and split UTF-8 models preserve names', async () => {
  const fake = fakeSpawn((message, call) => {
    if (message.method === 'initialize') { call.child.reply({ method: 'account/updated', params: { privateData: 'not-returned' } }); return {}; }
    if (message.method === 'account/read') return account('person@example.com');
    if (message.method === 'model/list') {
      const bytes = Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [model('image')], nextCursor: null } })}\n`);
      const at = bytes.indexOf(Buffer.from('模型')) + 1; call.child.stdout.write(bytes.subarray(0, at)); call.child.stdout.write(bytes.subarray(at)); return;
    }
  });
  const identity = createNativeIdentity({ runtime, ...fake }); assert.equal((await identity.models())[0].display_name, '模型 image');
  assert.equal(JSON.stringify(identity.status()).includes('not-returned'), false);
});
