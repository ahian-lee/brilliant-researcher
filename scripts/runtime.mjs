import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { repositoryRoot as root, requireNode24 } from './setup.mjs';

requireNode24();
const path = resolve(process.env.BRI_NATIVE_CONFIG || process.argv[2] || join(root, 'var/native-runtime.local.json'));
let config;
try { config = JSON.parse(readFileSync(path, 'utf8')); }
catch (error) { throw new Error(`Cannot read native runtime config ${path}. Run npm run setup first. ${error.message}`); }
const port = Number(process.env.BRI_NATIVE_PORT || config.port || 8793);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Native runtime port must be an integer from 1 to 65535.');
console.log(`Native runtime: http://127.0.0.1:${port}; config=${path}. Dashboard workbench.local.json nativeUrl must use this port.`);
const child = spawn(process.execPath, ['--enable-source-maps', join(root, 'runner/native-runtime-host.ts'), path, String(port)], { cwd: root, stdio: 'inherit', windowsHide: true });
let closing = false;
function stop() { if (closing) return; closing = true; child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.channel) {
  process.on('message', message => { if (message === 'shutdown') stop(); });
  process.on('disconnect', stop);
}
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code || (closing ? 0 : signal ? 1 : 0); });
