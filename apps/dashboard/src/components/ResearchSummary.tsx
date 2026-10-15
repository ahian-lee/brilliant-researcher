import { useI18n } from '../i18n';
import type { ProjectContinuation, ProjectFocus } from '../types';

/** Conclusions, remaining goal gap, and next step lead; evidence stays expandable. */
export function ResearchSummary({focus,goal,continuation}:{focus?:ProjectFocus;goal?:string;continuation?:ProjectContinuation}):JSX.Element {
  const {t:tr}=useI18n();
  const summary=focus?.summary && focus.summary!=='尚无 ARIS 阶段记录。'?focus.summary:'';
  const brief=focus?.briefing;
  const finding=brief?.finding||summary||goal||'';
  const technical=focus?.technical_summary||(summary!==finding?summary:'');
  const liveReason=continuation?.state!=='completed'?continuation?.reason:'';
  const nextStep=brief?.next_step||focus?.next_step;
  return <div className="wb-reader-summary">
    <strong className="wb-summary-lead-label">{tr('得到了什么')}</strong>
    <p className="wb-project-instruction">{finding?finding.length>360?`${finding.slice(0,360)}…`:finding:tr('尚未记录项目摘要。')}</p>
    {finding.length>360?<details><summary>{tr('查看完整结论')}</summary><p>{finding}</p></details>:null}
    {focus?.briefing_status?<p className="wb-briefing-source">{focus.briefing_status==='reviewed'?tr('这份说明已由 Codex 核对'):focus.briefing_status==='draft'?tr('本轮说明 · 尚未完成完整核对'):focus.briefing_status==='needs_revision'?tr('审核者已指出需修改的地方'):tr('本轮尚未返回简明说明，执行与审核记录仍可查看')}</p>:null}
    {brief?.meaning||nextStep?<dl className="wb-briefing-grid">
      {brief?.meaning?<div><dt>{tr('离目标还有多远')}</dt><dd>{brief.meaning}</dd></div>:null}
      {nextStep?<div><dt>{tr('建议下一步')}</dt><dd>{nextStep}</dd></div>:null}
    </dl>:null}
    {brief?.limitation?<p className="wb-briefing-limit"><strong>{tr('结果的限制：')}</strong>{brief.limitation}</p>:null}
    {liveReason?<p className="wb-continuation-reason"><strong>{continuation?.state==='blocked'?tr('当前卡点'):continuation?.state==='idle'?tr('等待继续'):tr('当前调整')}：</strong>{liveReason}</p>:null}
    {brief?.question||brief?.approach||technical||continuation?.reason?<details className="wb-summary-evidence"><summary>{tr('展开技术记录与审核原文')}
    </summary>{brief?.question||brief?.approach?<section><h3>{tr('在做什么')}</h3><p>{brief.question}</p><p>{brief.approach}</p></section>:null}{technical?<section><h3>{tr('原始研究记录')}</h3><p>{technical}</p></section>:null}{continuation?.reason?<section><h3>{continuation.state==='completed'?tr('独立审核结论'):tr('本轮调整记录')}</h3><p>{continuation.reason}</p></section>:null}</details>:null}
  </div>;
}
