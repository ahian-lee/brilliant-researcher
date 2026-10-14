import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
export function requireNode24() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Brilliant Researcher requires Node.js 24 or newer. Install Node.js, then run npm ci.');
}
/** Only create missing files. Never change an existing project registry or agent config. */
export function setup(root = repositoryRoot) {
  const directory = join(root, 'var');
  mkdirSync(directory, { recursive: true });
  const files = [
    ['aris-projects.local.json', 'aris-projects.example.json'],
    ['workbench.local.json', 'workbench.example.json'],
    ['native-runtime.local.json', 'native-runtime.example.json'],
  ];
  return files.map(([name, example]) => {
    const file = join(directory, name);
    try {
      writeFileSync(file, readFileSync(join(repositoryRoot, 'examples', example)), { flag: 'wx', mode: 0o600 });
      return { file, created: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { file, created: false };
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireNode24();
  for (const result of setup()) console.log(`${result.created ? 'Created' : 'Preserved'} ${result.file}`);
  const python = spawnSync(process.platform === 'win32' ? 'wsl.exe' : 'python3', process.platform === 'win32' ? ['--exec', 'python3', '--version'] : ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  console.log(python.status === 0 ? `ARIS helper prerequisite: ${(python.stdout || python.stderr).trim()}` : 'ARIS helper prerequisite missing: install Python 3; on Windows, install WSL with python3. The Dashboard can still start.');
  console.log('Next: npm start (local Dashboard; no model process or remote SSH).');
  console.log('For agent execution, install/authenticate DSH and/or Codex separately. Fill var/native-runtime.local.json with your own executable, home, DSH profile and optional cliEntry, set enabled:true, then run npm run runtime in another terminal.');
  console.log('Windows ARIS helpers require WSL + Python 3. Use absolute paths readable by the host running each command. No credentials, agent profiles, integrations or scheduled tasks were installed.');
}
