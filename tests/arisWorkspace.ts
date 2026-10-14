import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readSkillCatalog, readSkillDetail, readProjectArtifact, readProjectWorkspace } from '../packages/adapters/src/arisWorkspace.ts';

const temp = mkdtempSync(join(tmpdir(), 'aris-workspace-'));
const root = join(temp, 'project'); const aris = join(temp, 'aris');
function put(path: string, content: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
const json = (path: string, data: unknown) => put(path, JSON.stringify(data));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVyoAAAAASUVORK5CYII=', 'base64');
try {
  put(join(aris, 'skills/custom/SKILL.md'), `---\nname: custom\ndescription: >-\n  First line\n  second line\n---\n# Custom workflow\n## Workflow\n### Phase A: Review\n### Phase B: Revise\n`);
  put(join(aris, 'skills/idea-discovery/SKILL.md'), '---\nname: idea-discovery\n---\n# Idea\n');
  put(join(aris, 'skills/research-pipeline/SKILL.md'), '---\nname: research-pipeline\n---\n# Full\n');
  put(join(aris, 'skills/proof-orchestrator/SKILL.md'), '# Proof\n## Workflow\n1. State target.\n2. Prove target.\n## Other\n1. Not a workflow step.\n');
  put(join(aris, 'skills/skills-codex/custom/SKILL.md'), '# Mirror must not be counted');
  put(join(aris, 'docs/SKILLS_CATALOG.md'), '## 🏗️ Workflow Orchestrators\n| [`/custom`](../skills/custom/SKILL.md) | Custom role | None |\n');
  const catalog = readSkillCatalog(aris);
  assert.equal(catalog.length, 4);
  const custom = catalog.find(skill => skill.id === 'custom')!;
  assert.equal(custom.description, 'First line second line');
  assert.equal(custom.workflow, true);
  assert.deepEqual(custom.steps.map(step => step.id), ['phase-A', 'phase-B']);
  assert.equal(readSkillDetail(aris, 'custom')?.frontmatter.description, 'First line second line');
  assert.deepEqual(readSkillDetail(aris, 'proof-orchestrator')?.steps.map(step => step.name), ['State target.', 'Prove target.']);
  assert.equal(readSkillDetail(aris, '../outside'), null);

  put(join(root, 'figures/main.png'), png);
  put(join(root, 'figures/extra.png'), png);
  put(join(root, 'figures/unlisted-main.png'), png);
  put(join(root, 'figures/diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  put(join(root, 'report.html'), '<script>alert(1)</script>');
  put(join(root, 'report.md'), '# Report');
  put(join(temp, 'secret.png'), png);
  put(join(temp, 'secret.txt'), 'secret');
  let outsideLink = 'escape.txt'; let insideLink = 'inside.md';
  if (process.platform === 'win32') {
    // Junctions exercise the same realpath boundary without administrator-only file links.
    symlinkSync(temp, join(root, 'escape'), 'junction');
    symlinkSync(temp, join(root, 'figures/escape'), 'junction');
    put(join(root, 'notes/report.md'), '# Report');
    symlinkSync(join(root, 'notes'), join(root, 'inside'), 'junction');
    outsideLink = 'escape/secret.txt'; insideLink = 'inside/report.md';
  } else {
    symlinkSync(join(temp, 'secret.txt'), join(root, 'escape.txt'));
    symlinkSync(join(temp, 'secret.png'), join(root, 'figures/escape.png'));
    symlinkSync(join(root, 'report.md'), join(root, 'inside.md'));
  }
  json(join(root, '.aris/figures.json'), { figures: [
    { path: 'figures/main.png', title: '主结果图', role: 'main', stage: 'paper-figure' },
    { path: '../secret.png', title: 'Never visible', role: 'main' },
    { path: 'figures/missing.png', role: 'main' },
  ] });
  json(join(root, '.aris/runs/first.json'), { run_id: 'duplicate-embedded-id', updated: '2026-10-01', phases: [
    { phase: 'research-lit', status: 'done', artifact: 'report.md#literature' },
    { phase: 'idea-creator', status: 'done' },
  ] });
  json(join(root, '.aris/runs/second.json'), { run_id: 'duplicate-embedded-id', phases: [
    { phase: 'research-lit', status: 'accepted' }, { phase: 'idea-creator', status: 'accepted' },
  ] });
  json(join(root, '.aris/runs/plot.json'), { phases: [ { phase: 'paper-figure', status: 'running', artifact: 'figures/extra.png' } ] });
  json(join(root, '.aris/runs/unknown.json'), { phases: [ { phase: 'unexpected', status: 'future-status' } ] });
  put(join(root, '.aris/runs/broken.json'), '{bad');
  const workspace = readProjectWorkspace({ id: 'fixture', root }, aris);
  assert.equal(workspace.workflows.length, 5);
  const first = workspace.workflows.find(workflow => workflow.runId === 'first')!;
  const second = workspace.workflows.find(workflow => workflow.runId === 'second')!;
  assert.equal(first.status, 'completed');
  assert.equal(first.skillId, 'idea-discovery');
  assert.equal(first.steps[0].status, 'done');
  assert.equal(first.steps[0].readable, true);
  assert.equal(second.status, 'succeeded');
  assert.equal(first.steps.length, 2); // No phases copied from another run or from the catalog.
  assert.equal(workspace.workflows.find(workflow => workflow.runId === 'plot')?.status, 'running');
  assert.equal(workspace.workflows.find(workflow => workflow.runId === 'unknown')?.status, 'unknown');
  assert.equal(workspace.workflows.find(workflow => workflow.runId === 'broken')?.status, 'unknown');
  assert.equal(workspace.figures.length, 4);
  assert.equal(workspace.figures.filter(figure => figure.role === 'main').length, 1);
  assert.equal(workspace.figures.find(figure => figure.path.endsWith('unlisted-main.png'))?.role, 'unclassified');
  assert.equal(workspace.figures.find(figure => figure.path.endsWith('extra.png'))?.stage, 'paper-figure');
  assert.equal(workspace.figures.find(figure => figure.path.endsWith('extra.png'))?.runId, 'plot');
  assert.equal(workspace.figures.find(figure => figure.path.endsWith('main.png') && !figure.path.includes('unlisted'))?.source, 'manifest');
  assert.equal(JSON.stringify(workspace).includes('"bytes"'), false);
  assert.equal(readProjectArtifact({ root, path: '../secret.txt' }), null);
  assert.equal(readProjectArtifact({ root, path: join(temp, 'secret.txt') }), null);
  assert.equal(readProjectArtifact({ root, path: outsideLink }), null);
  assert.equal(readProjectArtifact({ root, path: insideLink })?.text, '# Report');
  assert.equal(readProjectArtifact({ root, path: 'report.md#literature' })?.text, '# Report');
  assert.equal(readProjectArtifact({ root, path: 'report.html' })?.mime, 'text/plain; charset=utf-8');
  assert.match(readProjectArtifact({ root, path: 'figures/diagram.svg' })!.contentSecurityPolicy!, /sandbox/);
  assert.equal(readProjectArtifact({ root, path: 'figures/main.png' })?.mime, 'image/png');
  put(join(root, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  put(join(root, 'binary.bin'), 'unsupported');
  assert.equal(readProjectArtifact({ root, path: 'huge.txt' }), null);
  assert.equal(readProjectArtifact({ root, path: 'binary.bin' }), null);
  json(join(root, '.aris/runs/ambiguous.json'), { phases: [
    { phase: 'analyze-results', status: 'done', artifact: 'figures/extra.png' },
    { phase: 'directory', status: 'done', artifact: 'figures' },
    { phase: 'oversized', status: 'done', artifact: 'huge.txt' },
  ] });
  const ambiguous = readProjectWorkspace({ id: 'fixture', root }, aris);
  assert.equal(ambiguous.figures.find(figure => figure.path.endsWith('extra.png'))?.stage, undefined);
  assert.equal(ambiguous.figures.find(figure => figure.path.endsWith('extra.png'))?.runId, undefined);
  assert.equal(ambiguous.workflows.find(workflow => workflow.runId === 'ambiguous')?.steps[1].readable, false);
  assert.equal(ambiguous.workflows.find(workflow => workflow.runId === 'ambiguous')?.steps[2].readable, false);

  const realAris = resolve('upstream/aris');
  const realCatalog = readSkillCatalog(realAris);
  // Local installation probes are optional; fixtures remain runnable in a clean checkout.
  // The current skill count is reported, never frozen as a requirement on future upstream additions.
  const observations: Array<{ id: string; runs: number; figures: number }> = [];
  if (existsSync(join(realAris, 'skills'))) {
    assert.ok(realCatalog.length > 0);
    assert.ok(realCatalog.every(skill => skill.description && skill.source));
    assert.ok(realCatalog.filter(skill => skill.workflow).every(skill => skill.steps.length > 0));
  }
  if (existsSync('var/aris-projects.local.json')) {
    const registrations = JSON.parse(readFile('var/aris-projects.local.json')) as { projects: Array<{id: string;root: string}> };
    for (const project of registrations.projects) {
      const projectRoot = resolve('var', project.root);
      if (!existsSync(projectRoot)) continue;
      const actual = readProjectWorkspace({ id: project.id, root: projectRoot }, realAris);
      observations.push({ id: project.id, runs: actual.workflows.length, figures: actual.figures.length });
    }
  }
  console.log('arisWorkspace: PASS', JSON.stringify({ skills: realCatalog.length, workflows: realCatalog.filter(skill => skill.workflow).length, projects: observations }));
} finally { rmSync(temp, { recursive: true, force: true }); }

function readFile(path: string): string {
  const artifact = readProjectArtifact({ root: resolve('.'), path });
  assert.ok(artifact?.text);
  return artifact.text;
}
