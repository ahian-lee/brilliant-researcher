import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build, createServer } from 'vite';
import { requireNode24, repositoryRoot as root } from './setup.mjs';

requireNode24();
const projects = resolve(process.env.BRI_ARIS_PROJECTS || join(root, 'var/aris-projects.local.json'));
const config = resolve(process.env.BRI_WORKBENCH_CONFIG || join(root, 'var/workbench.local.json'));
if (!existsSync(projects) || !existsSync(config)) throw new Error('Local configuration is missing. Run npm run setup first.');
const port = Number(process.env.BRI_PORT || 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BRI_PORT must be an integer from 1 to 65535.');
const env = { ...process.env, BRI_ARIS_PROJECTS: projects, BRI_WORKBENCH_CONFIG: config, BRI_PORT: String(port), BRI_DISABLE_REMOTE: '1', BRI_DASHBOARD_READ_ONLY: '1', BRI_WORKBENCH_ENABLED: '1' };
const dev = process.argv.includes('--dev');
const dashboard = join(root, 'apps/dashboard');
const configFile = join(dashboard, 'vite.config.ts');
if (!dev && !existsSync(join(dashboard, 'dist/index.html'))) await build({ root: dashboard, configFile });
const child = spawn(process.execPath, ['--enable-source-maps', join(root, 'apps/controller/src/server.ts')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
let vite, closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await vite?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => { child.kill('SIGKILL'); process.exit(code); }, 5000);
  timer.unref();
  process.exitCode = code;
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
if (process.channel) {
  process.on('message', message => { if (message === 'shutdown') void close(); });
  process.on('disconnect', () => void close());
}
child.on('error', error => { console.error(error.message); void close(1); });
child.on('exit', (code, signal) => { if (!closing && signal) console.error(`Controller exited: ${signal}`); void close(code || (closing ? 0 : 1)); });
if (dev) {
  try {
    vite = await createServer({ root: dashboard, configFile, server: { proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } } } });
    if (closing) await vite.close();
    else { await vite.listen(); vite.printUrls(); }
  } catch (error) { console.error(error.message); await close(1); }
} else console.log(`Dashboard: http://127.0.0.1:${port} (remote SSH disabled; native runtime starts separately)`);
