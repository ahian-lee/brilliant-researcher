import { useI18n } from '../i18n';
import type { ProjectContinuation, ProjectFocus } from '../types';

/** Reader-facing conclusions; native stage and review records remain separate. */
export function ResearchSummary({focus,goal,continuation}:{focus?:ProjectFocus;goal?:string;continuation?:ProjectContinuation}):JSX.Element {
  const { t: tr } = useI18n();
  const summary=focus?.summary && focus.summary!=='尚无 ARIS 阶段记录。' ? focus.summary : '';
  const long=summary.length>360;
  const brief=focus?.briefing;
  const findingIsLead=!!brief?.finding && brief.finding.trim()===summary.trim() && !long;
  const technical=focus?.technical_summary || (long?summary:'');
  const liveReason=continuation?.state!=='completed' ? continuation?.reason : '';
  return <div className="wb-reader-summary">
    {findingIsLead ? <strong className="wb-summary-lead-label">{tr("得到了什么")}</strong> : null}
    <p className="wb-project-instruction">{long ? goal || tr("本轮尚未整理简明结论，可展开下方原始记录查看。") : summary || goal || tr("尚未记录项目摘要。")}</p>
    {focus?.briefing_status ? <p className="wb-briefing-source">{focus.briefing_status==='reviewed'?tr("这份说明已由 Codex 核对"):focus.briefing_status==='draft'?tr("本轮说明 · 尚未完成完整核对"):focus.briefing_status==='needs_revision'?tr("审核者已指出需修改的地方"):tr("本轮尚未返回简明说明，执行与审核记录仍可查看")}</p> : null}
    {brief ? <>
      <dl className="wb-briefing-grid">
        {brief.question || brief.approach ? <div><dt>{tr("在做什么")}</dt><dd>{brief.question}{brief.approach ? <p>{brief.approach}</p> : null}</dd></div> : null}
        {brief.finding && !findingIsLead ? <div><dt>{tr("得到了什么")}</dt><dd>{brief.finding}</dd></div> : null}
        {brief.meaning ? <div><dt>{tr("离目标还有多远")}</dt><dd>{brief.meaning}</dd></div> : null}
        {brief.next_step ? <div><dt>{tr("建议下一步")}</dt><dd>{brief.next_step}</dd></div> : null}
      </dl>
      {brief.limitation ? <p className="wb-briefing-limit"><strong>{tr("结果的限制：")}</strong>{brief.limitation}</p> : null}
    </> : !liveReason && focus?.next_step ? <p><strong>{tr("接下来：")}</strong>{focus.next_step}</p> : null}
    {liveReason ? <p className="wb-continuation-reason"><strong>{continuation?.state==='blocked'?tr("当前卡点"):continuation?.state==='idle'?tr("等待继续"):tr("当前调整")}：</strong>{liveReason}</p> : null}
    {technical || continuation?.reason ? <details className="wb-summary-evidence"><summary>{tr("展开技术记录与审核原文")}</summary>{technical ? <section><h3>{tr("原始研究记录")}</h3><p>{technical}</p></section> : null}{continuation?.reason ? <section><h3>{continuation.state==='completed'?tr("独立审核结论"):tr("本轮调整记录")}</h3><p>{continuation.reason}</p></section> : null}</details> : null}
  </div>;
}
