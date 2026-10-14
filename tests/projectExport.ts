import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { exportProjectResults, ProjectExportError } from '../packages/adapters/src/projectExport.ts';

const temp = mkdtempSync(join(tmpdir(), 'project-export-'));
const root = join(temp, '研究项目'); const second = join(temp, 'other-project');
const project = { id: 'fixture-a', root, name: '材料研究: 中文/结果', goal: '比较两个候选材料' };
const now = new Date('2026-10-13T01:23:45Z');
function put(path: string, body: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(directory, item.name)) : [join(directory, item.name)]);
}
function extract(bytes: Buffer, label: string): string {
  const archive = join(temp, `${label}.zip`); const output = join(temp, label);
  writeFileSync(archive, bytes); mkdirSync(output);
  // Use a separate, standard ZIP implementation to validate headers, CRCs and real extraction.
  if (process.platform === 'win32') {
    const result = spawnSync('tar.exe', ['-xf', archive, '-C', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, `Windows ZIP extraction failed: ${result.error ?? result.stderr}`);
  } else {
    const check = spawnSync('unzip', ['-t', archive], { encoding: 'utf8' });
    assert.equal(check.status, 0, `ZIP validation failed: ${check.error ?? check.stdout + check.stderr}`);
    const result = spawnSync('unzip', ['-qq', archive, '-d', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, `ZIP extraction failed: ${result.error ?? result.stderr}`);
  }
  return output;
}
const isLimit = (error: unknown) => error instanceof ProjectExportError && error.code === 'LIMIT_EXCEEDED';

try {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVyoAAAAASUVORK5CYII=', 'base64');
  const expected = new Map<string, string | Buffer>([
    ['论文/研究总结.md', '# 中文研究结果\n候选材料表现良好。'], ['figures/主图.png', png],
    ['data/results.csv', 'material,value\na,0.9\n'], ['data/structures/样本.cif', 'data_sample\n'],
    ['data/records.jsonl', '{"sample":1}\n'], ['src/analyze.py', 'print("analysis")\n'], ['src/index.ts', 'export const result = 1;\n'],
    ['.aris/progress.json', '{"status":"completed"}'], ['.aris/figures.json', '{"figures":[{"path":"figures/主图.png"}]}'],
    ['.aris/runs/研究流程.json', '{"phases":[{"phase":"summary","status":"done"}]}'],
    ['EXPORT_README.md', '用户已有说明'], ['README', '# Existing project readme'],
  ]);
  for (const [path, body] of expected) put(join(root, path), body);
  const secret = 'MUST_NEVER_EXPORT_PRIVATE_DATA';
  for (const path of [
    '.env', '.env.production', '.bri/events.jsonl', '.git/config', '.claude/settings.json', '.codex/auth.json', '.ssh/id_rsa', '.npmrc',
    'node_modules/lib/index.js', 'venv/lib/private.py', '.venv/lib/private.py', '__pycache__/result.py', 'cache/report.md',
    '.aris/tools/shared.py', '.aris/sessions/raw.jsonl', 'sessions/raw.jsonl', 'chat-log.jsonl', 'session.json', 'auth.json',
    'credentials.json', 'secrets/secret.csv', 'api-key.yaml', 'passwords.txt', 'private.pem', 'service-account.json',
    'config.toml', 'settings.json', 'AGENTS.md', 'unknown.blob', 'tmp/intermediate.csv',
    'pi-events.jsonl', 'pi-research-events.jsonl', '.aris/pi-run-01-events.jsonl',
  ]) put(join(root, path), secret);
  put(join(second, 'report.md'), 'ONLY_SECOND_PROJECT');
  put(join(temp, 'outside.md'), secret);
  if (process.platform === 'win32') {
    symlinkSync(second, join(root, 'external'), 'junction');
    symlinkSync(join(root, 'data'), join(root, 'internal-alias'), 'junction');
  } else {
    symlinkSync(second, join(root, 'external'));
    symlinkSync(join(temp, 'outside.md'), join(root, 'leak.md'));
    symlinkSync(join(root, 'data'), join(root, 'internal-alias'));
  }
  const result = await exportProjectResults(project, { now });
  assert.equal(result.exportedAt, now.toISOString());
  assert.equal(result.fileCount, expected.size);
  assert.equal(result.totalBytes, [...expected.values()].reduce((sum, body) => sum + Buffer.byteLength(body), 0));
  assert.ok(result.excludedCount > 20);
  assert.match(result.filename, /^材料研究- 中文-结果-results-2026-10-13\.zip$/);
  assert.doesNotMatch(result.filename, /[<>:"/\\|?*\x00-\x1f]/);
  const output = extract(result.bytes, 'extracted-a');
  const names = files(output).map(path => relative(output, path).split(sep).join('/')).sort();
  assert.deepEqual(names, [...expected.keys(), 'EXPORT_README-2.md'].sort());
  for (const [path, body] of expected) assert.deepEqual(readFileSync(join(output, path)), Buffer.from(body));
  const explanation = readFileSync(join(output, 'EXPORT_README-2.md'), 'utf8');
  assert.match(explanation, /材料研究: 中文\/结果/); assert.match(explanation, /2026-10-13T01:23:45.000Z/);
  assert.match(explanation, /未识别的文件扩展名/); assert.match(explanation, /\.aris\/tools/);
  assert.ok(!explanation.includes(root));
  for (const path of files(output)) assert.ok(!readFileSync(path).includes(Buffer.from(secret)));
  const other = await exportProjectResults({ id: 'fixture-b', root: second, name: 'Other' }, { now });
  const otherOutput = extract(other.bytes, 'extracted-b');
  assert.deepEqual(files(otherOutput).map(path => relative(otherOutput, path)).sort(), ['EXPORT_README.md', 'report.md']);
  assert.equal(readFileSync(join(otherOutput, 'report.md'), 'utf8'), 'ONLY_SECOND_PROJECT');
  assert.ok(!result.bytes.includes(Buffer.from('ONLY_SECOND_PROJECT')));

  const limited = join(temp, 'limits'); put(join(limited, 'one.md'), '12345');
  const limitProject = { id: 'limits', root: limited, name: 'Limits' };
  await assert.rejects(exportProjectResults(limitProject, { limits: { maxFileBytes: 4 } }), isLimit);
  put(join(limited, 'two.csv'), '12345');
  await assert.rejects(exportProjectResults(limitProject, { limits: { maxTotalBytes: 9 } }), isLimit);
  await assert.rejects(exportProjectResults(limitProject, { limits: { maxFiles: 1 } }), isLimit);
  await assert.rejects(exportProjectResults(limitProject, { limits: { maxFileBytes: 0 } }), error => error instanceof ProjectExportError && error.code === 'INVALID_INPUT');
  await assert.rejects(exportProjectResults(limitProject, { now: new Date('invalid') }), error => error instanceof ProjectExportError && error.code === 'INVALID_INPUT');

  const empty = join(temp, 'empty'); mkdirSync(empty);
  const emptyExport = await exportProjectResults({ id: 'empty', root: empty, name: 'Empty' }, { now });
  assert.equal(emptyExport.fileCount, 0);
  assert.deepEqual(files(extract(emptyExport.bytes, 'extracted-empty')).map(path => relative(join(temp, 'extracted-empty'), path)), ['EXPORT_README.md']);
  if (process.platform !== 'win32') {
    // Legal Linux filenames can become traversal or drive paths in Windows ZIP readers.
    for (const malicious of ['..\\outside.md', 'C:\\file.md']) {
      put(join(limited, malicious), 'unsafe extraction path');
      await assert.rejects(exportProjectResults(limitProject), error => error instanceof ProjectExportError && error.code === 'UNSAFE_PATH');
      rmSync(join(limited, malicious));
    }
  }
  // Continuously changing a source while compression is in flight must not produce a partial snapshot.
  put(join(limited, 'large.csv'), Buffer.alloc(8 * 1024 * 1024, 65));
  let revision = 0;
  const changing = setInterval(() => writeFileSync(join(limited, 'one.md'), String(++revision).padStart(5, '0')), 1);
  try {
    await assert.rejects(exportProjectResults(limitProject), error => error instanceof ProjectExportError && ['READ_FAILED', 'UNSAFE_PATH'].includes(error.code));
  } finally { clearInterval(changing); }
  console.log('projectExport: PASS (standard ZIP extraction, Chinese paths, project isolation, links, secrets, limits, concurrent changes)');
} finally { rmSync(temp, { recursive: true, force: true }); }
