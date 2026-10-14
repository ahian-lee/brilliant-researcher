import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ArisReader, loadArisProjectRegistrations } from '../packages/adapters/src/arisReader.ts';

const scratch = mkdtempSync(join(tmpdir(), 'bri-aris-reader-'));
const projectRoot = join(scratch, 'project');
const otherRoot = join(scratch, 'other');
const pipelineRoot = join(scratch, 'pipeline');
const sharedRoot = join(scratch, 'shared-journal');
mkdirSync(join(projectRoot, '.aris', 'runs'), { recursive: true });
mkdirSync(join(projectRoot, 'reports'), { recursive: true });
mkdirSync(join(projectRoot, 'review-stage'), { recursive: true });
mkdirSync(join(otherRoot, '.aris', 'runs'), { recursive: true });
mkdirSync(join(otherRoot, 'review-stage'), { recursive: true });
mkdirSync(join(pipelineRoot, '.aris', 'runs'), { recursive: true });
mkdirSync(join(pipelineRoot, 'idea-stage'), { recursive: true });
mkdirSync(join(pipelineRoot, 'refine-logs'), { recursive: true });
mkdirSync(join(pipelineRoot, 'review-stage'), { recursive: true });
mkdirSync(join(pipelineRoot, 'summary-stage'), { recursive: true });
mkdirSync(join(sharedRoot, '.aris', 'runs'), { recursive: true });

writeFileSync(join(scratch, 'outside-secret.md'), 'DO NOT EXPOSE THIS CONTENT', 'utf8');
try {
  symlinkSync(join(scratch, 'outside-secret.md'), join(projectRoot, 'reports', 'outside-link.md'));
} catch {
  // Windows environments without symlink privileges still exercise the
  // lexical traversal assertion below.
}
writeFileSync(join(projectRoot, 'reports', 'plan.md'), '# plan\nfull plan artifact', 'utf8');
writeFileSync(join(projectRoot, 'review-stage', 'AUTO_REVIEW.md'), '# review\nreviewer details', 'utf8');
writeFileSync(join(projectRoot, 'review-stage', 'REVIEW_STATE.json'), JSON.stringify({ round: 2, status: 'accepted' }), 'utf8');
writeFileSync(
  join(projectRoot, '.aris', 'runs', 'run-one.json'),
  JSON.stringify({
    run_id: 'run-one',
    executor_model: 'pi-model',
    created: '2026-09-30T01:00:00Z',
    updated: '2026-09-30T02:00:00Z',
    phases: [
      { phase: 'plan', status: 'done', artifact: 'reports/plan.md', updated: '2026-09-30T01:30:00Z' },
      {
        phase: 'review',
        status: 'accepted',
        artifact: 'review-stage/AUTO_REVIEW.md',
        verdict_id: 'review-trace-1',
        reviewer: 'codex-reviewer',
        reviewer_family: 'codex',
        reviewer_independence: 'cross-family',
        acceptance_status: 'accepted',
        updated: '2026-09-30T02:00:00Z',
      },
      { phase: 'anchored-report', status: 'done', artifact: 'reports/plan.md#literature-landscape' },
      { phase: 'unsafe', status: 'done', artifact: '../outside-secret.md#literature-landscape' },
    ],
  }),
  'utf8',
);

// The same run id in another registered project must remain scoped to its own root.
writeFileSync(join(otherRoot, 'review-stage', 'AUTO_REVIEW.md'), 'OTHER PROJECT REPORT', 'utf8');
writeFileSync(
  join(otherRoot, '.aris', 'runs', 'run-one.json'),
  JSON.stringify({ run_id: 'run-one', phases: [{ phase: 'plan', status: 'done', artifact: 'review-stage/AUTO_REVIEW.md' }] }),
  'utf8',
);

const reader = new ArisReader([
  { id: 'aris-main', root: projectRoot, name: 'ARIS main' },
  { id: 'aris-other', root: otherRoot, name: 'ARIS other' },
]);
const overview = reader.overview('aris-main');
const done = overview.tasks.find((task) => task.phase === 'plan');
const accepted = overview.tasks.find((task) => task.phase === 'review');
const unsafe = overview.tasks.find((task) => task.phase === 'unsafe');
assert.equal(done?.phase_status, 'done');
assert.equal(done?.verdict, 'pending', 'executor done must not become accepted');
assert.equal(accepted?.phase_status, 'accepted');
assert.equal(accepted?.verdict, 'accepted');
assert.equal(unsafe?.artifacts.some((artifact) => artifact.content?.includes('DO NOT EXPOSE')), false);
const anchoredArtifact = done?.artifacts.find((artifact) => artifact.path === 'reports/plan.md#literature-landscape');
assert.equal(anchoredArtifact?.content, '# plan\nfull plan artifact', 'artifact fragments keep the locator but read the complete file');
assert.equal(anchoredArtifact?.readable, true);

const results = reader.results('aris-main');
assert.equal(results.results.find((result) => result.phase === 'plan')?.final_report, '# plan\nfull plan artifact');
assert.equal(results.results.find((result) => result.phase === 'review')?.final_report, '# review\nreviewer details');
assert.ok(results.results.find((result) => result.phase === 'plan')?.artifacts.some((artifact) => artifact.path === 'review-stage/AUTO_REVIEW.md'));

const detail = reader.runDetail('aris-main', 'run-one');
assert.equal((detail?.run as { source: string }).source, 'aris');
assert.equal((detail?.run as { status: string }).status, 'completed', 'executor completion must not imply acceptance or a live waiting process');
assert.equal((detail?.artifacts as Array<{ content: string | null }>).some((artifact) => artifact.content?.includes('DO NOT EXPOSE')), false);
assert.equal((reader.runDetail('aris-other', 'run-one')?.artifacts as Array<{ content: string }>)[0].content, 'OTHER PROJECT REPORT');

const configFile = join(scratch, 'aris-projects.json');
writeFileSync(configFile, JSON.stringify({ projects: [{ id: 'relative', root: 'project', goal: 'goal' }] }), 'utf8');
const registrations = loadArisProjectRegistrations(configFile, scratch);
assert.equal(registrations[0]?.root, resolve(projectRoot));
assert.equal(reader.findRunProject('run-one'), 'aris-main');
assert.equal(reader.findRunProject('../outside-secret'), null);

// A native full pipeline keeps all five phases distinct. `skipped` is the
// normal AUTO_WRITE=false terminal state and is not presented as accepted.
writeFileSync(join(pipelineRoot, 'idea-stage', 'IDEA_REPORT.md'), '# ideas\nidea evidence', 'utf8');
writeFileSync(join(pipelineRoot, 'refine-logs', 'EXPERIMENT_PLAN.md'), '# plan\nexperiment plan', 'utf8');
writeFileSync(join(pipelineRoot, 'refine-logs', 'EXPERIMENT_TRACKER.md'), '# tracker\nrun,status\n1,done', 'utf8');
writeFileSync(join(pipelineRoot, 'refine-logs', 'EXPERIMENT_RESULTS.md'), '# results\nmetric=0.91', 'utf8');
writeFileSync(join(pipelineRoot, 'review-stage', 'AUTO_REVIEW.md'), '# review\nfull review original', 'utf8');
writeFileSync(join(pipelineRoot, 'review-stage', 'round-1-review.raw.md'), 'raw independent review', 'utf8');
writeFileSync(join(pipelineRoot, 'review-stage', 'REVIEW_STATE.json'), JSON.stringify({ run_id: 'full-pipeline', round: 1, last_verdict: 'ready' }), 'utf8');
writeFileSync(join(pipelineRoot, 'summary-stage', 'SUMMARY.md'), '# summary\nsummary handoff', 'utf8');
writeFileSync(join(pipelineRoot, 'NARRATIVE_REPORT.md'), '# narrative\ncomplete report', 'utf8');
writeFileSync(
  join(pipelineRoot, '.aris', 'runs', 'full-pipeline.json'),
  JSON.stringify({
    run_id: 'full-pipeline',
    executor_model: 'pi-model',
    created: '2026-09-30T03:00:00Z',
    updated: '2026-09-30T04:00:00Z',
    phases: [
      { phase: 'idea-discovery', status: 'accepted', artifact: 'idea-stage/IDEA_REPORT.md', verdict_id: 'idea-verdict', reviewer: 'codex-gpt-6-astra', updated: '2026-09-30T03:10:00Z' },
      { phase: 'experiment-bridge', status: 'accepted', artifact: 'refine-logs/EXPERIMENT_RESULTS.md', verdict_id: 'experiment-verdict', reviewer: 'deterministic:experiment-bridge', updated: '2026-09-30T03:30:00Z' },
      { phase: 'auto-review-loop', status: 'accepted', artifact: 'review-stage/AUTO_REVIEW.md', verdict_id: 'review-verdict', reviewer: 'codex-gpt-6-astra', review_independence: 'cross-family', updated: '2026-09-30T03:40:00Z' },
      { phase: 'summary', status: 'accepted', artifact: 'NARRATIVE_REPORT.md', verdict_id: 'summary-verdict', reviewer: 'deterministic:summary', updated: '2026-09-30T03:50:00Z' },
      { phase: 'paper-writing', status: 'skipped', artifact: null, updated: '2026-09-30T04:00:00Z' },
    ],
  }),
  'utf8',
);
const pipelineReader = new ArisReader([{ id: 'aris-pipeline', root: pipelineRoot, name: 'ARIS pipeline' }]);
const pipelineOverview = pipelineReader.overview('aris-pipeline');
assert.deepEqual(
  pipelineOverview.tasks.map((task) => [task.phase, task.stage, task.phase_status, task.verdict]),
  [
    ['idea-discovery', 'idea', 'accepted', 'accepted'],
    ['experiment-bridge', 'experiments', 'accepted', 'accepted'],
    ['auto-review-loop', 'review', 'accepted', 'accepted'],
    ['summary', 'summary', 'accepted', 'accepted'],
    ['paper-writing', 'paper', 'skipped', 'pending'],
  ],
);
assert.equal((pipelineReader.runs('aris-pipeline')[0] as { status: string }).status, 'succeeded');
const pipelineResults = pipelineReader.results('aris-pipeline').results;
assert.ok(pipelineResults[1]?.artifacts.some((artifact) => artifact.path === 'refine-logs/EXPERIMENT_TRACKER.md'));
assert.ok(pipelineResults[2]?.artifacts.some((artifact) => artifact.path === 'review-stage/round-1-review.raw.md'));
assert.equal(pipelineResults.find((result) => result.phase === 'summary')?.final_report, '# narrative\ncomplete report');
assert.equal(pipelineResults.find((result) => result.phase === 'paper-writing')?.verdict, 'pending');
console.log('ARIS native five-stage pipeline and report artifact tests passed');

// Completed Idea helpers are not live Pi processes or separate review jobs.
writeFileSync(join(pipelineRoot, '.aris', 'runs', 'idea-child.json'), JSON.stringify({
  run_id: 'idea-child', phases: [
    { phase: 'research-lit', status: 'done' },
    { phase: 'idea-creator', status: 'done' },
    { phase: 'novelty-check', status: 'accepted' },
    { phase: 'research-review', status: 'accepted' },
    { phase: 'research-refine-pipeline', status: 'done' },
  ],
}), 'utf8');
const finished = pipelineReader.overview('aris-pipeline');
assert.equal(finished.project.active_count, 0);
assert.equal(finished.project.pending_review_count, 0);
assert.equal(finished.tasks.find(t => t.phase === 'research-lit')?.verdict, 'pending');
assert.equal(finished.tasks.find(t => t.phase === 'research-lit')?.run_status, 'completed');
assert.equal(pipelineReader.runDetail('aris-pipeline', 'idea-child')?.run.status, 'completed');


// A shared project journal without per-line run ids is retained as an
// artifact, but cannot be safely attributed to either of two runs.  The
// project-scope reader still exposes it with a cursor and file references.
writeFileSync(join(sharedRoot, 'pi-events.jsonl'), [
  JSON.stringify({ type: 'agent_start' }),
  JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'REPORT.md' } }),
  '',
].join('\n'), 'utf8');
writeFileSync(join(sharedRoot, 'pi-recovery-events.jsonl'), [
  JSON.stringify({ type: 'agent_settled' }),
  '{"type":"agent_start"',
].join('\n'), 'utf8');
writeFileSync(
  join(sharedRoot, '.aris', 'runs', 'shared-one.json'),
  JSON.stringify({ run_id: 'shared-one', phases: [{ phase: 'summary', status: 'accepted' }] }),
  'utf8',
);
writeFileSync(
  join(sharedRoot, '.aris', 'runs', 'shared-two.json'),
  JSON.stringify({ run_id: 'shared-two', phases: [{ phase: 'summary', status: 'accepted' }] }),
  'utf8',
);
const sharedReader = new ArisReader([{ id: 'aris-shared-journal', root: sharedRoot }]);
for (const runId of ['shared-one', 'shared-two']) {
  const sharedDetail = sharedReader.runDetail('aris-shared-journal', runId) as {
    events: unknown[];
    artifacts: Array<{ path: string }>;
  };
  assert.equal(sharedDetail.events.length, 0, 'unscoped shared journal must not be attributed to a run');
  assert.ok(sharedDetail.artifacts.some((artifact) => artifact.path === 'pi-events.jsonl'));
}
const projectJournalPage = sharedReader.projectJournal('aris-shared-journal', 0, 1);
assert.equal(projectJournalPage.scope, 'project');
assert.equal(projectJournalPage.project_id, 'aris-shared-journal');
assert.equal(projectJournalPage.events.length, 1);
assert.equal(projectJournalPage.events[0]?.run_id, null);
assert.equal(projectJournalPage.events[0]?.source_seq, 1);
assert.equal(projectJournalPage.has_more, true);
assert.equal(projectJournalPage.files.length, 2);
const projectJournalRest = sharedReader.projectJournal('aris-shared-journal', projectJournalPage.cursor, 20);
assert.deepEqual(projectJournalRest.events.map((event) => event.source_seq), [2, 3]);
assert.ok(projectJournalRest.events.some((event) => event.log_ref.startsWith('pi-recovery-events.jsonl#')));
assert.equal(projectJournalRest.events.some((event) => event.log_ref === 'pi-recovery-events.jsonl#L2'), false, 'unterminated final line is ignored');
assert.equal(projectJournalRest.has_more, false);
console.log('ARIS shared journal attribution tests passed');

console.log('arisReader tests passed');

// The existing Pi parser drives a paginated journal; incomplete live lines are ignored.
writeFileSync(join(projectRoot, 'review-stage', 'REVIEW_STATE.json'), JSON.stringify({ run_id: 'run-one' }));
writeFileSync(join(projectRoot, 'pi-events.jsonl'), [
  JSON.stringify({type:'agent_start'}),
  JSON.stringify({type:'message_update',text:'streaming delta'}),
  JSON.stringify({type:'tool_execution_start',toolName:'read',args:{path:'REPORT.md'}}),
  JSON.stringify({type:'tool_execution_end',toolName:'read',isError:false}),
  '{"type":"tool_execution_start"',
].join('\n'));
const firstJournal = reader.runDetail('aris-main','run-one',0,1)?.events as Array<{source_seq:number}>;
assert.equal(firstJournal.length,1);
assert.equal(firstJournal[0].source_seq,1);
const restJournal = reader.runDetail('aris-main','run-one',1,200)?.events as Array<{source_seq:number}>;
assert.deepEqual(restJournal.map(e=>e.source_seq),[3,4]);
assert.equal((reader.runDetail('aris-main','run-one')?.run as {exit_code:number|null}).exit_code,null,'phase completion is not a measured process exit code');
writeFileSync(join(projectRoot, 'pi-resume-events.jsonl'), [
  JSON.stringify({type:'turn_start'}),
  JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'resume journal'}]}}),
  '',
].join('\n'));
writeFileSync(join(projectRoot, 'pi-recovery-events.jsonl'), [
  JSON.stringify({type:'agent_start'}),
  JSON.stringify({type:'agent_settled'}),
  '',
].join('\n'));
writeFileSync(join(projectRoot, 'pi-recovery-stderr.log'), 'recovery stderr\n', 'utf8');
writeFileSync(join(projectRoot, 'pi.stderr.log'), 'legacy stderr\n', 'utf8');
const journals = reader.runDetail('aris-main','run-one') as { events: Array<{ summary: string; log_ref: string }>; logPaths: { journals: string[] } };
assert.ok(journals.events.some((event) => event.summary.includes('resume journal')));
assert.ok(journals.events.some((event) => event.log_ref.startsWith('pi-recovery-events.jsonl#')));
assert.equal(journals.logPaths.journals.length, 3);
assert.equal((reader.runDetail('aris-main','run-one')?.logPaths as { stderr: string[] }).stderr.length, 2);
writeFileSync(join(projectRoot,'review-stage','REVIEW_STATE.json'),JSON.stringify({run_id:'another-run'}));
assert.equal((reader.runDetail('aris-main','run-one')?.events as unknown[]).length,0,'do not attach another run\'s live journal');
assert.equal(reader.runDetail('aris-main','run-one')?.reviewLog,null,'do not attach another run\'s global review log');
console.log('ARIS journal pagination and source-scoping tests passed');
