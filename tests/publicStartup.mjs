import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, repositoryRoot as root, requireNode24 } from '../scripts/setup.mjs';

requireNode24();
const directory = mkdtempSync(join(tmpdir(), 'brilliant-startup-'));
const children = [];
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result; }
function start(entry, args = [], env = {}) {
  const child = spawn(process.execPath, [join(root, entry), ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.log = ''; child.stdout.on('data', data => child.log += data); child.stderr.on('data', data => child.log += data);
  children.push(child); return child;
}
async function ready(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited (${child.exitCode}): ${child.log}`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return response; } catch { /* Wait for startup. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Startup timed out: ${child.log}`);
}
try {
  setup(directory);
  const runtimeFile = join(directory, 'var/native-runtime.local.json');
  const config = JSON.parse(readFileSync(runtimeFile, 'utf8'));
  const runtimePort = await port();
  config.port = runtimePort; config.sessionsDirectory = join(directory, 'sessions');
  writeFileSync(runtimeFile, JSON.stringify(config));
  const native = start('scripts/runtime.mjs', [runtimeFile]);
  const nativeUrl = `http://127.0.0.1:${runtimePort}`;
  assert.equal((await (await ready(nativeUrl + '/health', native)).json()).sessions, 0);
  const call = async (operation, args) => fetch(nativeUrl + '/runtime', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bri-native': '1' }, body: JSON.stringify({ operation, args }) });
  assert.deepEqual(await (await call('providers', [])).json(), []);
  const missing = await call('models', ['dsh-pi']);
  assert.equal(missing.status, 502); assert.match((await missing.json()).error, /未配置/);
  const workbenchFile = join(directory, 'var/workbench.local.json');
  writeFileSync(workbenchFile, JSON.stringify({ nativeUrl }));
  const dashboardPort = await port();
  const dashboard = start('scripts/start.mjs', [], {
    BRI_PORT: String(dashboardPort), BRI_DB: join(directory, 'state.db'),
    BRI_ARIS_PROJECTS: join(directory, 'var/aris-projects.local.json'), BRI_WORKBENCH_CONFIG: workbenchFile,
    // The public entry must override this unsafe caller environment.
    BRI_DISABLE_REMOTE: '0',
  });
  const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
  assert.deepEqual((await (await ready(dashboardUrl + '/api/projects', dashboard)).json()).projects, []);
  assert.equal((await fetch(dashboardUrl + '/')).status, 200);
  const providers = await (await fetch(dashboardUrl + '/api/workbench/providers')).json();
  assert.equal(providers.connected, true); assert.deepEqual(providers.providers, []);
  assert.equal((await fetch(dashboardUrl + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
  console.log('public startup PASS: empty project API, Dashboard HTML, separate unconfigured runtime, no available models, legacy writes disabled');
} finally {
  for (const child of children) if (child.exitCode === null) { if (child.connected) child.send('shutdown'); else child.kill('SIGTERM'); }
  await Promise.all(children.map(async child => { if (child.exitCode !== null) return; await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 6000))]); if (child.exitCode === null) child.kill('SIGKILL'); }));
  await new Promise(resolve => setTimeout(resolve, 300));
  rmSync(directory, { recursive: true, force: true });
}
