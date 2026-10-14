import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, repositoryRoot } from '../scripts/setup.mjs';
import { loadConfig } from '../apps/controller/src/config.ts';

const root = mkdtempSync(join(tmpdir(), 'brilliant-setup-'));
try {
  const first = setup(root);
  assert.equal(first.length, 3);
  assert.ok(first.every(result => result.created));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'var/aris-projects.local.json'))), { projects: [] });
  const workbench = JSON.parse(readFileSync(join(root, 'var/workbench.local.json')));
  assert.equal(workbench.nativeUrl, 'http://127.0.0.1:8793');
  assert.equal(workbench.approvalReview.enabled, false);
  const runtime = JSON.parse(readFileSync(join(root, 'var/native-runtime.local.json')));
  assert.equal(runtime.dsh.enabled, false);
  assert.equal(runtime.codex.enabled, false);
  assert.equal(runtime.dsh.home, '');
  assert.equal(runtime.dsh.profile, '');
  assert.equal(runtime.codex.executable, '');
  assert.ok(!JSON.stringify(runtime).match(/paseo|sk-/i));
  // Preserve user-edited files byte for byte, even if invalid JSON. Setup isn't a repair tool.
  for (const result of first) writeFileSync(result.file, `user-owned ${result.file}\n`);
  assert.ok(setup(root).every(result => !result.created));
  for (const result of first) assert.equal(readFileSync(result.file, 'utf8'), `user-owned ${result.file}\n`);
  const old = process.env.BRI_DISABLE_REMOTE;
  delete process.env.BRI_DISABLE_REMOTE;
  try { assert.equal(loadConfig(root).disableRemote, true); }
  finally { if (old !== undefined) process.env.BRI_DISABLE_REMOTE = old; }
  for (const file of ['scripts/setup.mjs', 'scripts/start.mjs', 'scripts/runtime.mjs', 'runner/native-runtime-service.ps1', 'examples/workbench.example.json', 'examples/native-runtime.example.json']) {
    assert.doesNotMatch(readFileSync(join(repositoryRoot, file), 'utf8'), /C:\\Users\\|\/home\/lyh\//i);
  }
  console.log('public setup PASS: empty registry, no configured models, idempotent preservation, remote disabled, portable bootstrap paths');
} finally { rmSync(root, { recursive: true, force: true }); }
