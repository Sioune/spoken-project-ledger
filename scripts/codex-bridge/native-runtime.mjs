import os from 'node:os';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { PlanError } from './identity.mjs';

// Only this official npm installation is executable. No browser, request, CLI
// argument, PATH lookup, or Codex configuration can select another program.
export function createNativeRuntime() {
  if (arguments.length) throw new PlanError(400, 'CODEX_CLI_NOT_FOUND', '本机Codex路径不接受外部配置。');
  const home = os.homedir();
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  const executable = path.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  try {
    if (!lstatSync(executable).isFile() || realpathSync(executable).toLowerCase() !== executable.toLowerCase()) throw new Error('untrusted');
  } catch (error) {
    // A missing installation is reported by spawn as a disconnected identity,
    // so the local portal remains usable. Existing redirected paths fail shut.
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new PlanError(503, 'CODEX_CLI_NOT_FOUND', '官方本机Codex安装路径无法核验。');
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    PATH: [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
  };
  // This is the CLI's own durable login location. Only the path is forwarded;
  // this bridge never opens, copies, parses, logs, or persists its auth files.
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  return Object.freeze({ executable, env: Object.freeze(env) });
}
