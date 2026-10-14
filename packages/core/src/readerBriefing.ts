import type { CollaborationRun } from './collaborationLoop.ts';

/** Presentation data carried by existing execution/review receipts, not an acceptance gate. */
export interface ReaderBriefing {
  question:string; approach:string; finding:string; meaning:string; limitation:string; next_step:string;
}
export type BriefingStatus='draft'|'reviewed'|'needs_revision'|'unavailable';
export const briefingExample:ReaderBriefing={
  question:'用户原本要解决的问题，不能换成审核者要检查什么',approach:'项目采用的方法或实现思路，不写读取文件、跑测试等审核操作',
  finding:'项目的核心结果、关键数值或功能变化，不能只写测试通过；数字出现时解释含义',meaning:'这些结果离用户原始目标还有多远，哪些仍未完成',
  limitation:'会影响判断的限制或尚未验证的部分；不能用测试通过替代效果证明',next_step:'建议接下来做什么；区分已执行与建议',
};
export function readReaderBriefing(value:unknown):ReaderBriefing|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const row=value as Record<string,unknown>;
  const result=Object.fromEntries(Object.keys(briefingExample).map(key=>[key,typeof row[key]==='string'?(row[key] as string).trim():''])) as unknown as ReaderBriefing;
  return Object.values(result).some(Boolean)?result:undefined;
}
export const readerBriefingInstruction='面向用户的说明统一放在 briefing 对象中：question（用户原问题）、approach（项目方法）、finding（项目核心结果）、meaning（离用户原始目标的差距）、limitation（实质限制）、next_step（下一步）。这是一份项目成果说明，不是执行者或审核者的工作日志：研究任务要说发现，分析任务要说具体结果，组件任务要说实现了哪些行为，不能只写“读取了文件并通过测试”。每项用一两句普通中文；简单任务相应简写，不添加研究步骤。解释首次出现的术语与数字含义，示例标明是示意，不编造实测。meaning 必须区分本轮交付/测试/审核通过和用户目标达成；limitation 保留会影响判断的限制。命令、文件路径、版本号、修复日志放 artifacts/tests/checks 或详细报告，不堆进简明说明。';

/** Only this revision and this execution round may supply the current report. */
export function collaborationReaderReport(run:CollaborationRun){
  const execution=run.actions.find(a=>a.id===run.lastExecutionId&&a.revision===run.revision&&a.round===run.round&&a.status==='replied'&&a.reply?.kind==='execute');
  const review=execution&&run.actions.find(a=>a.id===run.lastReviewId&&a.revision===run.revision&&a.round===execution.round&&a.status==='replied'&&a.reply?.kind==='review');
  const executionReply=execution?.reply?.kind==='execute'?execution.reply:undefined;
  const reviewReply=review?.reply?.kind==='review'?review.reply:undefined;
  const reviewBrief=readReaderBriefing(reviewReply?.briefing), executionBrief=readReaderBriefing(executionReply?.briefing);
  const completeReview=reviewBrief&&Object.values(reviewBrief).every(Boolean);
  // Partial reviewer output cannot erase a stated limitation or turn the
  // executor's unexamined text into a fully reviewed explanation.
  const briefing=completeReview?reviewBrief:executionBrief??reviewBrief;
  const status:BriefingStatus=completeReview?(reviewReply!.verdict==='accept'?'reviewed':'needs_revision'):briefing?'draft':'unavailable';
  const short=(value:string|undefined)=>value&&value.length<=300?value:undefined;
  const plan=run.actions.find(a=>a.id===run.lastPlanId&&a.revision===run.revision&&a.status==='replied')?.reply;
  const planReply=plan?.kind==='plan'?plan:undefined;
  const fallback=run.state==='planning'?'Codex 正在审计现有成果并提出下一轮计划；执行尚未开始。':run.state==='audited'?`Codex 审计结束，本轮无需新增执行。${planReply?.summary??''}`:run.state==='accepted'?'这一轮的交付已通过审核。原始执行和审核记录可展开查看。':run.state==='reviewing'?'执行者已交付本轮成果，Codex 正在独立审核。':run.state==='paused'?'本轮已暂停。':run.state==='budget_exhausted'?'本轮已达到执行预算，需要调整后才能继续。':run.state==='needs_attention'?'本轮遇到需要处理的问题，具体原因见当前卡点。':'正在按最新要求推进本轮任务。';
  return {
    briefing,
    briefing_status:status,
    briefing_source:{collaborationId:run.id,revision:run.revision,actionId:(completeReview||!executionBrief&&reviewBrief?review:execution)?.id??null},
    summary:short(briefing?.finding)??short(reviewReply?.feedback)??short(executionReply?.summary)??fallback,
    next_step:briefing?.next_step??(run.state==='planning'?'等待 Codex 的真实审计计划；授权范围内自动进入执行。':run.state==='audited'?'查看审计建议；可以补充新的要求，不重复执行已完成工作。':planReply?.decision==='needs_input'?planReply.summary:run.state==='accepted'?'查看成果与尚未解决的问题，可继续提出修改要求。':run.state==='reviewing'?'等待独立审核，发现问题将自动退回修改。':'按最新要求继续推进。'),
    technical_summary:[executionReply?`执行者原文：\n${executionReply.summary}`:'',reviewReply?`审核者原文：\n${reviewReply.feedback}`:''].filter(Boolean).join('\n\n'),
  };
}
