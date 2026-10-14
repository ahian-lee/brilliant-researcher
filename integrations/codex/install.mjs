#!/usr/bin/env node
/** Register BRI directly as MCP + discoverable skill. No marketplace install or credentials needed. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
export const PLUGIN = join(HERE, 'plugins/bri-research');
export const SERVER = join(PLUGIN, 'mcp/server.mjs');
const SKILL = join(PLUGIN, 'skills/bri-supervisor');
const LEGACY_PLUGIN = 'plugins."bri-research@bri-marketplace"';

export function nativePath(value) {
  if (process.platform !== 'win32') return value;
  const match = value.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}` : value;
}
export function codexHome(value) {
  return resolve(nativePath(value || process.env.CODEX_HOME || join(homedir(), '.codex')));
}
function wslPath(value) {
  const match = value.match(/^([a-z]):[\\/](.*)$/i);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : value;
}

// Replace only the exact BRI tables. Preserve all unrelated configuration verbatim.
export function replaceTables(text, predicate) {
  const sections = text.split(/(?=^\[[^\n]+\]\s*(?:#.*)?$)/m);
  return sections.filter((section) => {
    const header = section.match(/^\[([^\n]+)\]/)?.[1];
    return !header || !predicate(header);
  }).join('');
}
export function registration({ node = process.execPath, server = SERVER, url = 'http://127.0.0.1:8791', wsl = false } = {}) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('BRI_URL must be HTTP(S), without embedded credentials');
  }
  const command = wsl ? wslPath(node) : node;
  return `\n[mcp_servers.bri]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify([server])}\nenabled = true\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.bri.tools.bri_submit_task]\napproval_mode = "prompt"\n\n[mcp_servers.bri.tools.bri_run_control]\napproval_mode = "prompt"\n\n[mcp_servers.bri.tools.bri_cancel_run]\napproval_mode = "prompt"\n\n[mcp_servers.bri.env]\nBRI_URL = ${JSON.stringify(endpoint.href.replace(/\/$/, ''))}\n`;
}
export function makeConfig(original, options = {}) {
  let next = replaceTables(original, (h) => h === 'mcp_servers.bri' || h.startsWith('mcp_servers.bri.'));
  // Only disable the superseded BRI plugin, leaving its source and other plugin settings intact.
  const sections = next.split(/(?=^\[[^\n]+\]\s*(?:#.*)?$)/m);
  next = sections.map((s) => {
    if (s.match(/^\[([^\n]+)\]/)?.[1] !== LEGACY_PLUGIN) return s;
    if (/^enabled\s*=/m.test(s)) return s.replace(/^enabled\s*=.*$/m, 'enabled = false');
    return s.replace(/^([^\n]+\n)/, '$1enabled = false\n');
  }).join('');
  return `${next.trimEnd()}\n${registration(options)}`;
}

function installSkill(home, options) {
  const target = join(home, 'skills/bri-supervisor');
  mkdirSync(join(target, 'references'), { recursive: true });
  copyFileSync(join(SKILL, 'SKILL.md'), join(target, 'SKILL.md'));
  const paths = `# Local BRI connection\n\nLegacy Controller HTTP (existing service-owned tasks only): ${options.url}\n\nProject root: ${ROOT}\n\nDefault research CLI (use direct mode on every command; never interpolate brief text):\n\n\`\`\`text\n${process.execPath} ${join(ROOT, 'integrations/bri.mjs')} overview --direct\n\`\`\`\n\nWindows paths above map to /mnt/<drive>/... when using a WSL shell.\n\nDetailed research workflow: ${join(ROOT, 'workflows/experiment-bridge/WORKFLOW.md')}\n\nARIS research pipeline: ${join(ROOT, 'upstream/aris/skills/research-pipeline/SKILL.md')}\n\nARIS review loop: ${join(ROOT, 'upstream/aris/skills/auto-review-loop/SKILL.md')}\n\nConnection check: ${join(HERE, 'verify-codex.mjs')}\n\nFor every new research action, append --direct to each CLI command; without it the legacy HTTP path is used. BRI MCP uses Controller HTTP and is reserved for explicitly requested existing service-owned tasks. The direct CLI works while Controller is offline. Do not claim that installing configuration injects tools into an already active turn.\n`;
  writeFileSync(join(target, 'references/connection.md'), paths);
  return target;
}

export function main(argv = process.argv.slice(2)) {
  const has = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const home = codexHome(value('codex-home', undefined));
  const config = join(home, 'config.toml');
  const original = existsSync(config) ? readFileSync(config, 'utf8') : '';
  const dry = has('dry-run');
  // Auto-match this desktop's WSL executor when called from Windows with a WSL CODEX_HOME.
  const wsl = !has('win-paths') && (has('wsl') || (process.platform === 'win32' && (/^\/mnt\//.test(process.env.CODEX_HOME ?? '') || /\[mcp_servers\.bri\]\s*\ncommand\s*=\s*"\/mnt\//.test(original))));
  const options = { url: value('url', process.env.BRI_URL ?? 'http://127.0.0.1:8791'), wsl };
  const next = has('uninstall')
    ? replaceTables(original, (h) => h === 'mcp_servers.bri' || h.startsWith('mcp_servers.bri.'))
    : makeConfig(original, options);
  console.log(`${dry ? '[dry-run] ' : ''}${has('uninstall') ? 'Remove' : 'Register'} bri MCP: ${config}`);
  if (!has('uninstall')) console.log(registration(options).trim());
  if (dry) return;
  mkdirSync(home, { recursive: true });
  if (next !== original) {
    if (existsSync(config)) copyFileSync(config, `${config}.bri-backup-${Date.now()}`);
    writeFileSync(config, next);
  }
  if (has('uninstall')) {
    // Remove only this skill's known files; leave unrelated additions in place.
    for (const name of ['SKILL.md', 'references/connection.md']) rmSync(join(home, 'skills/bri-supervisor', name), { force: true });
    console.log('BRI registration removed; other servers and plugins preserved.');
  } else {
    console.log(`Skill installed: ${installSkill(home, options)}`);
    console.log('BRI configured. Refresh the bri MCP server or open a new Codex chat to load tools.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
