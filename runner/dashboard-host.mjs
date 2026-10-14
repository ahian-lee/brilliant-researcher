// The console-free Windows host owns this process; no terminal is required.
import { appendFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Console } from 'node:console';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projects = resolve(process.argv[2] || resolve(root, 'var/aris-projects.local.json'));
const port = Number(process.argv[3] || 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Dashboard port');
const logs = resolve(root, 'var');
mkdirSync(logs, { recursive: true });
const lifecycle = resolve(logs, `dashboard-${port}-service.log`);
const log = message => appendFileSync(lifecycle, `${new Date().toISOString()} ${message}\n`);
globalThis.console = new Console({ stdout: createWriteStream(resolve(logs, 'dashboard.stdout.log'), { flags: 'a' }), stderr: createWriteStream(resolve(logs, 'dashboard.stderr.log'), { flags: 'a' }) });
process.env.BRI_DISABLE_REMOTE = '1';
process.env.BRI_DASHBOARD_READ_ONLY = '1';
// Interactive research has its own local-only API; historical BRI writes stay disabled.
process.env.BRI_WORKBENCH_ENABLED = '1';
process.env.BRI_ARIS_PROJECTS = projects;
process.env.BRI_PORT = String(port);
if (process.env.BRI_DASHBOARD_MANAGED !== '1') {
  writeFileSync(resolve(logs, `dashboard-${port}-child.json`), JSON.stringify({ pid: process.pid }));
}
log(`research workbench started pid=${process.pid} port=${port}; legacy remote execution disabled`);
process.on('exit', code => log(`read-only server exited pid=${process.pid} code=${code}`));
process.on('uncaughtExceptionMonitor', error => log(`uncaught: ${error.stack || error}`));
try {
  await import('../apps/controller/src/server.ts');
} catch (error) {
  log(`startup failed: ${error.stack || error}`);
  process.exitCode = 1;
}
