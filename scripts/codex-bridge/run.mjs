import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { BridgeStore } from './store.mjs';
import { createBridgeServer, BRIDGE_PORT, SITE_ORIGIN } from './server.mjs';
import { createIdentity } from './identity.mjs';
import { recognizeWithPlan } from './transport.mjs';

export async function runBridge() {
  const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SpokenProjectLedgerCodex');
  const store = new BridgeStore({ stateDir });
  const redirectUri = `http://127.0.0.1:${BRIDGE_PORT}/auth/callback`;
  const identity = createIdentity({ hostId: store.hostId, registration: store.registration,
    saveRegistration: registration => store.saveRegistration(registration), redirectUri });
  // Diagnostics contain framing categories only: never response text, image
  // bytes, notes, project names, request headers or credentials.
  const recognizer = (input, options) => recognizeWithPlan(input, { ...options,
    onDiagnostic: value => console.log('识图格式诊断 ' + JSON.stringify(value)) });
  const bridge = createBridgeServer({ store, identity, recognizer, origin: SITE_ORIGIN, port: BRIDGE_PORT });
  try { await bridge.listen(); }
  catch (error) { store.close(); throw error; }
  console.log(`项目簿本机 Codex 桥已运行：http://127.0.0.1:${BRIDGE_PORT}/`);
  console.log('请在本机页面通过官方登录连接，然后使用一次性配对码。不会自动识别、启动隧道或写入项目簿。');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await bridge.close(); };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('用法：node scripts/codex-bridge/run.mjs\n固定监听 127.0.0.1:5197，仅允许原私有项目簿网站。登录及配对令牌仅在内存中，重启后需重新连接。');
  } else if (args.length) {
    console.error('不接受自定义地址、端口、账号密钥或代理参数。'); process.exitCode = 1;
  } else {
    runBridge().catch(() => { console.error('本机桥未能启动。请核对 Node 版本、5197 端口和本机状态目录权限。'); process.exitCode = 1; });
  }
}
