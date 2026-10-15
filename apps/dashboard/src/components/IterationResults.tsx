import { useI18n } from '../i18n';
import { workbenchArtifactUrl } from '../workbenchApi';
import type { WorkbenchCollaborationRun } from '../workbenchTypes';

export function IterationResults({projectId,run}: {projectId:string;run?:WorkbenchCollaborationRun|null}): JSX.Element | null {
  const {t:tr}=useI18n();
  if(!run)return null;
  const execution=[...run.actions].reverse().find(action=>action.status==='replied'&&action.reply?.kind==='execute');
  if(execution?.reply?.kind!=='execute')return null;
  const review=[...run.actions].reverse().find(action=>action.status==='replied'&&action.revision===execution.revision&&action.round===execution.round&&action.reply?.kind==='review')?.reply;
  const current=execution.revision===run.revision;
  const blocked=execution.reply.outcome==='blocked';
  const artifactLink=(path:string,index:number)=><li key={`${index}:${path}`}><a href={workbenchArtifactUrl(projectId,path)} target="_blank" rel="noreferrer">{path} ↗</a></li>;
  return <section className="wb-iteration-results" aria-label={tr('本轮成果与审核')}>
    <div className="wb-section-heading"><strong>{current?tr('本轮成果'):tr('前轮成果，尚未按新方向重新验收')}</strong><span className="wb-muted">{tr('方向版本')} {execution.revision} · {tr('轮次')} {execution.round}</span></div>
    {execution.reply.artifacts.length?<ul className="wb-result-links">{execution.reply.artifacts.slice(0,4).map(artifactLink)}</ul>:<p className="wb-muted">{tr('尚无登记的成果文件')}</p>}
    {execution.reply.artifacts.length>4?<details><summary>{tr('查看其余成果文件 · {0}',{0:execution.reply.artifacts.length-4})}</summary><ul className="wb-result-links">{execution.reply.artifacts.slice(4).map(artifactLink)}</ul></details>:null}
    <p className="wb-result-review"><strong>{blocked?tr('执行受阻，保留已有成果'):review?.kind==='review'?(review.verdict==='accept'?tr('独立审核通过'):tr('独立审核要求修改')):tr('尚待独立审核')}</strong>{blocked?<> · {execution.reply.reason || execution.reply.summary}</>:review?.kind==='review'?<> · {review.feedback}</>:null}</p>
  </section>;
}
