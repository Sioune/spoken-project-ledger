import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { BridgeStore } from './store.mjs';
import { createBridgeServer, BRIDGE_PORT, SITE_ORIGIN } from './server.mjs';
import { createNativeRuntime } from './native-runtime.mjs';
import { createNativeIdentity } from './native-identity.mjs';
import { recognizeWithCodex } from './native-transport.mjs';

export async function runBridge() {
  const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SpokenProjectLedgerCodex');
  const store = new BridgeStore({ stateDir });
  const runtime = createNativeRuntime();
  const identity = createNativeIdentity({ runtime });
  await identity.refresh();
  const recognizer = (input, options) => recognizeWithCodex(input, { ...options, runtime,
    onDiagnostic: value => console.log('本机识图诊断 ' + JSON.stringify(value)) });
  const bridge = createBridgeServer({ store, identity, recognizer, origin: SITE_ORIGIN, port: BRIDGE_PORT });
  try { await bridge.listen(); }
  catch (error) { store.close(); throw error; }
  console.log(`项目簿本机 Codex 桥已运行：http://127.0.0.1:${BRIDGE_PORT}/`);
  console.log('复用本机 Codex CLI 登录。网页配对不再发起独立OAuth；不会自动识别或写入项目簿。');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await bridge.close(); };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('用法：node scripts/codex-bridge/run.mjs\n固定监听127.0.0.1:5197，仅允许原私有站。复用官方CLI登录；重启不清除CLI登录，网页须重新配对。');
  } else if (args.length) {
    console.error('不接受自定义地址、端口、账号密钥或代理参数。'); process.exitCode = 1;
  } else {
    runBridge().catch(() => { console.error('本机桥未能启动。请核对 Node 版本、5197 端口和本机状态目录权限。'); process.exitCode = 1; });
  }
}
