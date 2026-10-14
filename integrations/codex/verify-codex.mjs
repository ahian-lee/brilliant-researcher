#!/usr/bin/env node
/** Read only the installed bri registration and test its exact stdio command; never copy credentials. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexHome } from './install.mjs';

export function readRegistration(text) {
  const section = (header) => text.split(/(?=^\[[^\n]+\]\s*(?:#.*)?$)/m).find((s) => s.startsWith(`[${header}]`));
  const get = (body, key) => {
    const raw = body?.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();
    if (raw === undefined) return undefined;
    if (raw.startsWith("'")) return raw.slice(1, raw.lastIndexOf("'"));
    return JSON.parse(raw);
  };
  const root = section('mcp_servers.bri');
  if (!root) throw new Error('bri MCP is not registered. Run npm run codex:install first.');
  if (get(root, 'enabled') === false) throw new Error('bri MCP is disabled.');
  const command = get(root, 'command');
  const args = get(root, 'args') ?? [];
  if (!command || !Array.isArray(args)) throw new Error('Invalid bri command/args');
  return { command, args, env: { BRI_URL: get(section('mcp_servers.bri.env'), 'BRI_URL') ?? 'http://127.0.0.1:8791' } };
}

export async function verify(config) {
  let command = config.command;
  let args = config.args;
  if (process.platform === 'win32' && command.startsWith('/')) {
    args = ['--exec', command, ...args]; command = 'wsl.exe';
  }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...config.env } });
  let sequence = 0, buffer = '', stderr = '';
  const waiting = new Map();
  const fail = (error) => {
    for (const job of waiting.values()) { clearTimeout(job.timer); job.reject(error); }
    waiting.clear();
  };
  child.on('error', fail);
  child.on('close', (code) => fail(new Error(`MCP exited (${code}); ${stderr.slice(-250)}`)));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (s) => { stderr = (stderr + s).slice(-1000); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (s) => {
    buffer += s;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('MCP stdout is not JSON-RPC')); continue; }
      const job = waiting.get(message.id);
      if (!job) continue;
      waiting.delete(message.id); clearTimeout(job.timer);
      if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
    }
  });
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, 25000);
    waiting.set(id, { resolve, reject, timer }); send({ jsonrpc: '2.0', id, method, params });
  });
  const tool = async (name, arguments_ = {}) => {
    const result = await call('tools/call', { name, arguments: arguments_ });
    const body = result.content?.find((c) => c.type === 'text')?.text;
    if (result.isError) throw new Error(`${name}: ${body}`);
    return JSON.parse(body);
  };
  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bri-installed-check', version: '1.0' } });
    if (init.serverInfo?.name !== 'bri-supervisor') throw new Error('Unexpected MCP server');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await call('tools/list');
    const overview = await tool('bri_overview');
    if (!overview.project?.id) throw new Error('Controller returned no project');
    const changes = await tool('bri_changes', { since: 0, limit: 5 });
    let reportChars = null;
    const completed = overview.tasks?.find((t) => t.run_status === 'succeeded');
    if (completed) {
      const report = await tool('bri_read_report', { run_id: completed.run_id });
      reportChars = report.report?.length ?? 0;
      if (!reportChars) throw new Error('Completed run has no readable final report');
    }
    return { handshake: true, toolNames: list.tools.map((t) => t.name), controllerConnected: true, tasks: overview.tasks?.length ?? 0, changes: changes.changes?.length ?? 0, reportChars, desktopSessionReloadVerified: false };
  } finally {
    fail(new Error('Verifier closed')); child.stdin.end(); child.kill();
  }
}

async function main() {
  const opt = process.argv.slice(2).find((s) => s.startsWith('--codex-home='))?.slice(13);
  const config = readRegistration(readFileSync(join(codexHome(opt), 'config.toml'), 'utf8'));
  console.log(JSON.stringify(await verify(config), null, 2));
  console.log('Installed command and live Controller verified. This is not proof of tool loading in an already-open Desktop chat.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
