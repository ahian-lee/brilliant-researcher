import assert from 'node:assert/strict';
import { buildResearchFocus } from '../packages/adapters/src/researchFocus.ts';
import type { ArisRun } from '../packages/adapters/src/arisReader.ts';

function run(id: string, entries: Array<[string, string]>, updated = '2026-10-13T00:00:00Z'): ArisRun {
  return { run_id: id, updated, created: updated, executor_model: null, status: 'unknown',
    artifacts: [], review_state: null, review_log: null, state_error: null,
    phases: entries.map(([phase, status]) => ({ phase, status, artifact: null, artifact_path: null,
      artifact_content: null, verdict_id: null, reviewer: null, reviewer_family: null,
      reviewer_independence: null, acceptance_status: null, updated })),
  };
}
const pipeline = run('pipeline', [['idea-discovery', 'accepted'], ['experiment-bridge', 'done'], ['auto-review-loop', 'pending'], ['summary', 'pending'], ['paper-writing', 'skipped']]);
const helper = run('later-helper', [['research-lit', 'done']], '2026-10-13T01:00:00Z');
const focus = buildResearchFocus([pipeline, helper], null, {});
assert.equal(focus.pipeline_run_id, 'pipeline', 'newer subflows cannot replace whole-pipeline progress');
assert.equal(focus.completed, 1, 'done is not accepted');
assert.equal(focus.total, 4, 'explicitly skipped optional stage is excluded');
assert.equal(focus.headline, '实验与验证 · 待审核');
assert.equal(focus.questions.length, 0, 'pending review is not a user decision');
assert.equal(focus.sessions.length, 0, 'ARIS runs are not fabricated agent sessions');

const attention = buildResearchFocus([pipeline], {
  run_id: 'pipeline', summary: '已完成初轮实验', next_step: '修复数据缺项',
  blockers: [{ id: 'data', title: '数据缺项', detail: '缺少温度' }],
  questions: [{ id: 'budget', title: '是否增加预算？' }, { title: '旧问题', status: 'answered' }],
}, {});
assert.equal(attention.headline, '有问题需要你决定');
assert.equal(attention.questions.length, 1);
assert.equal(attention.blockers.length, 1);
assert.equal(attention.next_step, '修复数据缺项');
const wrongRun = buildResearchFocus([pipeline], { run_id: 'other', summary: '不能串入', questions: ['不能串入'] }, {});
assert.equal(wrongRun.questions.length, 0);
assert.doesNotMatch(wrongRun.summary, /不能串入/);
assert.match(wrongRun.source_note, /另一轮/);
const stale = buildResearchFocus([run('old', [['experiment-bridge', 'running']], '2026-09-01T00:00:00Z')], null, {}, Date.parse('2026-10-13T00:00:00Z'));
assert.match(stale.headline, /等待进展更新/);
assert.match(stale.source_note, /不能确认仍在运行/);
const empty = buildResearchFocus([], null, {});
assert.equal(empty.headline, '等待研究开始');
assert.equal(empty.review.status, 'unknown');
assert.equal(empty.completed, 0);
const completed = buildResearchFocus([run('finished', [['idea-discovery', 'accepted'], ['experiment-bridge', 'accepted'], ['auto-review-loop', 'accepted'], ['summary', 'accepted'], ['paper-writing', 'skipped']])], null, {});
assert.equal(completed.headline, '当前流程已完成');
assert.equal(completed.review.status, 'accepted');
console.log('PASS research focus: parent pipeline, done/accepted, stale status, human decisions, run scoping, empty and complete');
const decision = {questionId:'budget',runId:'pipeline',title:'是否增加预算？',detail:'',source:'.aris/progress.json',answer:'不增加',sessionId:'executor',at:'2026-10-13T01:00:00Z',state:'sent' as const};
const answered = buildResearchFocus([pipeline], {questions:[{id:'budget',title:'是否增加预算？',status:'open'},{id:'defer',title:'暂缓',status:'resolved-deferred-by-user'}],blockers:[{title:'已解决',status:'resolved-by-compliant-stop'}]}, {},Date.now(),[decision]);
assert.equal(answered.questions.length,0,'delivered human answers do not wait for agent to edit progress');
assert.equal(answered.answeredQuestions.length,1,'delivery history is separate from execution completion');
assert.equal(answered.blockers.length,0,'resolved status variants are closed');
const freshRun=buildResearchFocus([run('new-round',[['idea-discovery','running']])],{questions:[{id:'budget',title:'是否增加预算？'}]}, {},Date.now(),[decision]);
assert.equal(freshRun.questions.length,1,'an old answer cannot hide a new research round question');

const partial=buildResearchFocus([pipeline,run('followup',[['experiment-bridge','running'],['auto-review-loop','pending'],['summary','pending']],'2026-10-14T00:00:00Z')],{run_id:'followup'},{});
assert.deepEqual(partial.stages.map(s=>s.id),['experiment-bridge','auto-review-loop','summary'],'partial follow-up does not invent literature or paper stages');
assert.equal(partial.total,3);
const single=run('single-summary',[['summary','running']],'2026-10-14T01:00:00Z');
const singleFocus=buildResearchFocus([pipeline,single],{run_id:'single-summary',workbench_iteration:true},{});
assert.equal(singleFocus.pipeline_run_id,'single-summary');
assert.deepEqual(singleFocus.stages.map(s=>s.id),['summary']);
const readable=buildResearchFocus([pipeline],{run_id:'pipeline',summary:'可读结论',technical_summary:'详细统计与原始记录',briefing:{question:'要解决什么？',finding:'有改善，但还没达到原目标',limitation:'证据不完整',next_step:'下一步建议'}},{});
assert.equal(readable.briefing?.finding,'有改善，但还没达到原目标');
assert.equal(readable.briefing?.limitation,'证据不完整','material limits stay in the reader view');
assert.equal(readable.technical_summary,'详细统计与原始记录');
const oldBrief=buildResearchFocus([pipeline],{run_id:'another-run',briefing:{finding:'旧轮次已经成功'},technical_summary:'旧记录'},{});
assert.equal(oldBrief.briefing,undefined,'old-round briefing never masquerades as current findings');
assert.equal(oldBrief.technical_summary,'');
