import { existsSync, readFileSync } from 'node:fs';
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
const withRuntime = process.argv.includes('--with-runtime');
const dashboard = join(root, 'apps/dashboard');
const configFile = join(dashboard, 'vite.config.ts');
// Rebuild after upgrades; the presence of an older dist is not evidence it matches the source.
if (!dev && !process.argv.includes('--no-build')) await build({ root: dashboard, configFile });
if (!dev && !existsSync(join(dashboard, 'dist/index.html'))) throw new Error('No Dashboard build exists. Run npm run build.');
let native;
if (withRuntime) {
  const nativeConfig = resolve(process.env.BRI_NATIVE_CONFIG || join(root, 'var/native-runtime.local.json'));
  const settings = JSON.parse(readFileSync(nativeConfig, 'utf8'));
  const nativePort = Number(process.env.BRI_NATIVE_PORT || settings.port || 8793);
  const nativeUrl = JSON.parse(readFileSync(config, 'utf8')).nativeUrl || 'http://127.0.0.1:8793';
  const endpoint = new URL(nativeUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw new Error('Native runtime must use localhost.');
  if (endpoint.port !== String(nativePort)) throw new Error('Runtime port and workbench nativeUrl differ. Run npm run connect.');
  let connected = false;
  let health;
  try { const r=await fetch(nativeUrl+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok)health=await r.json(); } catch {}
  const sameConfig=(value)=>typeof value==='string' && (process.platform==='win32'?resolve(value).toLowerCase()===nativeConfig.toLowerCase():resolve(value)===nativeConfig);
  if(health && (health.runtime!=='native'||!sameConfig(health.configPath)))throw new Error('This port belongs to another runtime/configuration. It was left running. Use a different port or your existing configuration.');
  connected=health?.runtime==='native';
  if (!connected) {
    native=spawn(process.execPath,[join(root,'scripts/runtime.mjs'),nativeConfig],{cwd:root,stdio:['ignore','inherit','inherit','ipc'],env:process.env,windowsHide:true});
    let startupError;
    native.once('error',error=>{startupError=error;});
    const deadline=Date.now()+15000;
    while(!connected && Date.now()<deadline){
      if(startupError||native.exitCode!==null)throw new Error('Native runtime failed to start. Check agent configuration.');
      try{const r=await fetch(nativeUrl+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){const value=await r.json();connected=value.runtime==='native'&&sameConfig(value.configPath);}}catch{}
      if(!connected)await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!connected){native.kill();throw new Error('Native runtime did not become ready.');}
  }
}
const child = spawn(process.execPath, ['--enable-source-maps', join(root, 'apps/controller/src/server.ts')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
let vite, closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await vite?.close();
  if(native?.connected)native.send('shutdown');
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => { child.kill('SIGKILL'); process.exit(code); }, 5000);
  timer.unref();
  if(native){const nativeTimer=setTimeout(()=>native.kill('SIGKILL'),5000);nativeTimer.unref();}
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
} else console.log(`Dashboard: http://127.0.0.1:${port} (remote SSH disabled; ${withRuntime ? 'native runtime connected' : 'start native runtime separately, or use --with-runtime'})`);
