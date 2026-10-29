import { readerBriefingInstruction } from './readerBriefing.ts';
import type { RecordedDecision } from '../../adapters/src/researchFocus.ts';
import type { CollaborationRun } from './collaborationLoop.ts';
import { updateProjectBudget, type ProjectBudget, type NativeUsage, type Delegation, type CollaborationScope } from './projectBudget.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { ArisReader, loadArisProjectRegistrations, type ArisProjectRegistration } from '../../adapters/src/arisReader.ts';
import { readProjectWorkspace, readSkillCatalog } from '../../adapters/src/arisWorkspace.ts';

export interface LiveSession {
  id: string; provider: string; title: string; status: string; cwd?: string;
  model?: string; updatedAt?: string | null; lastMessageAt?: string | null; role?: string;
  parentId?: string;
  delegation?: Delegation;
  usage?: NativeUsage;
  thinkingOptionId?: string | null; configuredThinkingOptionId?: string | null;
  configuredModel?: string | null; runtimeModel?: string | null;
  modeId?: string | null; permissionPreset?: string | null;
}
export interface RuntimeModel {
  id: string; name: string;
  thinkingOptions?: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>;
  defaultThinkingOptionId?: string;
  available?: boolean; unavailableReason?: string;
}
export interface ResearchRuntime {
  providers(): Promise<Array<{ id: string; name: string; available: boolean; error?: string }>>;
  models(provider: string): Promise<RuntimeModel[]>;
  listSessions(cwd?: string): Promise<LiveSession[]>;
  createSession(input: { cwd: string; provider: string; model?: string; thinkingOptionId?: string; permissionPreset?: 'auto' | 'danger-full-access'; modeId?: 'full-access' | 'auto'; prompt?: string; title?: string }): Promise<LiveSession>;
  updateSession?(id: string, input: { cwd: string; model?: string | null; thinkingOptionId?: string | null; permissionPreset?: 'auto' | 'danger-full-access'; modeId?: 'full-access' | 'auto' }): Promise<{ ok: boolean; session: LiveSession; notice?: string }>;
  inspectSession(id: string): Promise<{ activity?: Array<{ id: string; tool: string; summary: string; status?: string; target?: string; description?: string; error?: string; at?: string }>; activeTurn?: unknown; session: LiveSession; messages: Array<{ id: string; role: string; text: string; at?: string | null }>; approvals?: unknown[] }>;
  sendMessage(id: string, message: string, context?: { collaboration?: CollaborationScope }): Promise<{ accepted: boolean; status?: string; error?:string }>;
  setCollaborationScope?(id: string, scope: CollaborationScope | null): Promise<unknown>;
  listDescendants?(parentSessionId: string): Promise<LiveSession[]>;
  interruptDescendants?(parentSessionId: string): Promise<unknown>;
  interruptSession(id: string): Promise<{ ok: boolean; confirmed?: boolean; status?: string }>;
  respondApproval(id: string, approvalId: string, optionId: string): Promise<{ ok: boolean }>;
  respondQuestion?(id: string, approvalId: string, answers: Record<string, { selected: string[]; text?: string }>, cancel?: boolean): Promise<{ ok: boolean }>;
}
interface Binding { id: string; role: string; workflow: string; title: string; provider: string }
interface Control {
  budget?: ProjectBudget;
  accessMode?: 'full' | 'review';
  scope?: string;
  workflow: string; createdAt: string; updatedAt: string; sessions: Binding[];
  mode?: 'free' | 'skill' | 'pipeline';
  error?: string; reviewError?: string;
  userDirections?: Array<{ at: string; text: string; sessionId?: string }>;
  continuation?: {state:'running'|'idle'|'blocked'|'completed';reason?:string;updatedAt:string;affectedStages:string[];sessionId:string};
  recordedDecisions?: RecordedDecision[];
  questionReplies?: Array<{ sessionId: string; requestId: string; title: string; description: string; answer: string; at: string }>;
  launch?: { state: 'starting' | 'ready' | 'unknown'; title: string; role: string; workflow: string; provider: string; startedAt: string };
}
export class WorkbenchError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode; }
}
export interface WorkbenchOptions {
  repoRoot: string; registryFile: string; runtime: ResearchRuntime; projectBase?: string; arisRoot?: string;
  modelAvailability?: (provider: string, models: RuntimeModel[]) => RuntimeModel[];
  dshAutoReview?: boolean;
  reviewerSelection?: {model?:string;thinkingOptionId?:string};
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
function text(value: unknown, name: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new WorkbenchError(`${name} 必填且不能超过 ${max} 个字符`);
  return value.trim();
}
function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, file);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function sameResearchDirectory(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const canonical = (path: string): string => {
    const normalized = path.replace(/^\/mnt\/([a-z])(?=\/)/i, (_, drive) => `${drive}:`).replaceAll('\\', '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(normalized) ? win32.normalize(normalized).toLowerCase() : resolve(normalized);
  };
  return canonical(a) === canonical(b);
}

/** Project registration and live session binding. ARIS owns all scientific stage state. */
export class ResearchWorkbench {
  readonly options: WorkbenchOptions;
  readonly arisRoot: string;
  private locks = new Set<string>();
  private decisionLocks = new Set<string>();
  private directDispatches = new Map<string,AbortController>();
  private sessionCache: { at: number; sessions: LiveSession[] } | null = null;
  private sessionRequest: Promise<LiveSession[]> | null = null;
  collaborationStatus?: (id: string) => CollaborationRun | null;
  startCollaboration?: (id: string, input: Record<string, unknown>) => Promise<CollaborationRun>;
  steerCollaboration?: (id: string, message: unknown, options?:{auditFirst?:boolean}) => Promise<CollaborationRun>;
  pauseCollaboration?: (id: string) => Promise<CollaborationRun | null>;
  tickCollaborations?: () => Promise<void>;
  approvalReviews?: (projectId: string, sessionId: string) => unknown[];
  reviewApprovals?: () => Promise<void>;
  approvalReviewStatus?: () => { enabled: boolean; notificationConfigured: boolean; error: string | null };
  constructor(options: WorkbenchOptions) {
    this.options = options;
    this.arisRoot = resolve(options.arisRoot ?? join(options.repoRoot, 'upstream/aris'));
  }
  project(id: string): ArisProjectRegistration {
    const project = loadArisProjectRegistrations(this.options.registryFile, this.options.repoRoot).find(p => p.id === id);
    if (!project) throw new WorkbenchError('该项目没有登记可操作的研究目录', 404);
    return project;
  }
  setCompleted(id: string, completed: unknown): { completedAt: string | null } {
    if (typeof completed !== 'boolean') throw new WorkbenchError('请指定是否完成项目');
    this.project(id);
    const file = resolve(this.options.repoRoot, this.options.registryFile);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const entries = Array.isArray(config) ? config : config.projects;
    const entry = entries.find((item: { id: string }) => item.id === id);
    if (!entry) throw new WorkbenchError('项目不存在', 404);
    // Keep registration metadata and ARIS phase/verdict records unchanged.
    const completedAt = completed ? this.project(id).completed_at || new Date().toISOString() : null;
    if ((entry.completed_at ?? null) !== completedAt) {
      if (completedAt) entry.completed_at = completedAt;
      else delete entry.completed_at;
      atomicJson(file, config);
    }
    return { completedAt };
  }
  private controlFile(project: ArisProjectRegistration, create = false): string {
    const root = realpathSync(project.root);
    const dir = join(root, '.bri');
    if (create && !existsSync(dir)) mkdirSync(dir);
    if (existsSync(dir) && !inside(root, realpathSync(dir))) throw new WorkbenchError('项目控制目录不能指向项目之外');
    const file = join(dir, 'workbench.json');
    if (existsSync(file) && (!inside(root, realpathSync(file)) || statSync(file).size > 2 * 1024 * 1024)) throw new WorkbenchError('项目控制记录不可读取');
    return file;
  }
  control(project: ArisProjectRegistration): Control | null {
    const file = this.controlFile(project);
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Control;
    if (!raw || !Array.isArray(raw.sessions)) throw new WorkbenchError('项目会话登记格式无效');
    return raw;
  }
  private writeControl(project: ArisProjectRegistration, control: Control, policyChange = false): void {
    const latest = this.control(project);
    if (!policyChange && latest?.accessMode) { control.accessMode=latest.accessMode; control.scope=latest.scope; }
    if (!policyChange && latest?.budget) control.budget = latest.budget;
    const latestDirections = latest?.userDirections ?? [];
    const directions = [...latestDirections, ...(control.userDirections ?? [])];
    if (directions.length) control.userDirections = directions.filter((item, index) => directions.findIndex(other => other.at === item.at && other.text === item.text && other.sessionId === item.sessionId) === index).sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
    const replies = [...(latest?.questionReplies ?? []), ...(control.questionReplies ?? [])];
    if (replies.length) control.questionReplies = replies.filter((item, index) => replies.findIndex(other => other.sessionId === item.sessionId && other.requestId === item.requestId) === index).sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
    const decisions=[...(latest?.recordedDecisions??[]),...(control.recordedDecisions??[])];
    if(decisions.length)control.recordedDecisions=decisions.filter((d,i)=>decisions.findLastIndex(other=>other.questionId===d.questionId&&other.runId===d.runId)===i);
    if(latest?.continuation && (!control.continuation || latest.continuation.updatedAt>control.continuation.updatedAt))control.continuation=latest.continuation;
    control.updatedAt = new Date().toISOString();
    atomicJson(this.controlFile(project, true), control);
  }
  private initialControl(workflow: string): Control {
    const now = new Date().toISOString();
    return { workflow, mode: workflow === 'free' ? 'free' : workflow === 'research-pipeline' ? 'pipeline' : 'skill', createdAt: now, updatedAt: now, sessions: [] };
  }
  private skill(id: string) {
    if (id === 'free') return { id, title: '自由协作', name: '自由协作', steps: [] };
    const skill = readSkillCatalog(this.arisRoot).find(s => s.id === id);
    if (!skill) throw new WorkbenchError('ARIS 技能不存在');
    return skill;
  }
  async providers() {
    try { return { connected: true, providers: await this.options.runtime.providers() }; }
    catch (error) { return { connected: false, providers: [], error: errorText(error) }; }
  }
  async models(provider: string) {
    const models = await this.options.runtime.models(text(provider, '执行者', 100));
    return { models: this.options.modelAvailability?.(provider, models) ?? models };
  }
  private async selection(provider: string, input: Record<string, unknown>) {
    const model = input.model ? text(input.model, '模型', 200) : undefined;
    const thinkingOptionId = input.thinkingOptionId ? text(input.thinkingOptionId, '思考强度', 100) : undefined;
    if (model) {
      const option = (await this.models(provider)).models.find(item => item.id === model);
      if (!option) throw new WorkbenchError('执行端没有提供这个模型，请刷新模型列表');
      if (option.available === false) throw new WorkbenchError(option.unavailableReason || '此模型缺少所需配置', 409);
      if (thinkingOptionId && !option.thinkingOptions?.some(item => item.id === thinkingOptionId)) throw new WorkbenchError('此模型不支持所选思考强度');
    } else if (thinkingOptionId) throw new WorkbenchError('请先选择模型，再设置思考强度');
    return { model, thinkingOptionId };
  }
  private invalidate(): void { this.sessionCache = null; }
  private async allSessions(): Promise<LiveSession[]> {
    if (this.sessionCache && Date.now() - this.sessionCache.at < 4_000) return this.sessionCache.sessions;
    if (!this.sessionRequest) {
      this.sessionRequest = this.options.runtime.listSessions().then(sessions => {
        this.sessionCache = { at: Date.now(), sessions }; return sessions;
      }).finally(() => { this.sessionRequest = null; });
    }
    return this.sessionRequest;
  }
  async sessions(id: string): Promise<LiveSession[]> {
    const project = this.project(id);
    const control = this.control(project);
    if (!control) return [];
    const sessions = (await this.allSessions()).filter(s => sameResearchDirectory(s.cwd, project.root));
    // A create timeout may still have created a remote session. Reconcile by the
    // unique title and project path before allowing another launch.
    if (control.launch && control.launch.state !== 'ready') {
      const pending = control.launch;
      const match = sessions.find(s => s.title === pending.title && s.provider === pending.provider);
      if (match) {
        if (!control.sessions.some(s => s.id === match.id)) control.sessions.push({ id: match.id, title: match.title, provider: match.provider, role: pending.role, workflow: pending.workflow });
        control.launch = { ...pending, state: 'ready' }; delete control.error; this.writeControl(project, control);
      }
    }
    return sessions.map(session => ({ ...session, role: control.sessions.find(s => s.id === session.id)?.role ?? (session.delegation ? 'subagent' : session.role ?? 'executor') }));
  }
  executionScope(id: string): string {
    const project = this.project(id), control = this.control(project);
    const reporting=`\n${readerBriefingInstruction}\n研究、小组件、单项技能都使用同一说明格式。若由后台派发执行/审核动作，在最终回执返回 briefing，后台负责更新看板；直接执行 ARIS 技能时，将同一 briefing 连同简短 summary、当前 run_id 写入 .aris/progress.json，详细日志写 technical_summary。不要用测试通过或审核通过替代用户目标达成。`;
    return `项目目录：${project.root}\n原始项目目标：${project.goal}\n已回答的用户决定（仅作范围与方向依据）：${JSON.stringify(control?.recordedDecisions?.map(d=>({question:d.title,answer:d.answer}))??[])}\n项目已授权的执行范围：${control?.scope || project.constraints || '项目内读写、实现、测试与返修；不读取凭据、不修改项目外文件或宿主配置、不增加费用。'}\n${control?.accessMode === 'full' ? '用户已授权本项目使用完全访问模式，范围内自行执行和修复，不逐条请求工具许可。完全访问是执行能力，不扩大上面的任务授权。' : '按现有工具权限审核执行。'}工具或命令失败、路径错误应自行改用符合范围的方法继续；需要新增范围、费用或研究方向取舍时使用原生问答。共享ARIS技能和工具只读。${reporting}`;
  }
  async prepareSessionAccess(id: string, sessionId: string): Promise<void> {
    const detail = await this.ownedSession(id, sessionId), project = this.project(id), control = this.control(project);
    if (detail.session.title.startsWith('BRI approval review ') || !control?.accessMode || !this.options.runtime.updateSession) return;
    const settings = detail.session.provider === 'dsh-pi' ? { permissionPreset: control.accessMode === 'full' ? 'danger-full-access' as const : 'auto' as const }
      : detail.session.provider === 'codex' ? { modeId: control.accessMode === 'full' ? 'full-access' as const : 'auto' as const } : null;
    if (!settings || ('permissionPreset' in settings && detail.session.permissionPreset === settings.permissionPreset) || ('modeId' in settings && detail.session.modeId === settings.modeId)) return;
    if (detail.activeTurn || detail.approvals?.length || !['idle','completed','stopped','interrupted','failed','error','canceled'].includes(detail.session.status)) throw new WorkbenchError('新权限将在当前回合结束后应用',409);
    await this.options.runtime.updateSession(sessionId,{cwd:project.root,...settings}); this.invalidate();
  }
  private async sendDirect(id: string, sessionId: string, message: string) {
    if(this.directDispatches.has(sessionId))throw new WorkbenchError('此会话正在发送任务，请等待结果',409);
    const dispatch=new AbortController();this.directDispatches.set(sessionId,dispatch);
    try{
    const control=this.control(this.project(id));
    if (!this.options.runtime.setCollaborationScope) {
      if (control?.budget && Object.keys(control.budget).length) throw new WorkbenchError('此执行后台尚不支持预算；请升级原生后台后再执行', 503);
      return await this.options.runtime.sendMessage(sessionId,message);
    }
    const stopped=await this.stopDirectFamily(id,sessionId,15000);
    if(!stopped.confirmed)throw new WorkbenchError(stopped.error||'旧方向的父子任务尚未确认停止；新消息未发送，内容保留',409);
    if(dispatch.signal.aborted)throw new WorkbenchError('用户已停止任务；新消息未发送，内容保留',409);
    const scope:CollaborationScope={collaborationId:`direct-${randomUUID()}`,actionId:randomUUID(),revision:1,task:message,createdAt:Date.now(),active:true,...control?.budget};
    await this.options.runtime.setCollaborationScope(sessionId,scope);
    if(dispatch.signal.aborted){await this.options.runtime.setCollaborationScope(sessionId,null);throw new WorkbenchError('用户已停止任务；新消息未发送，内容保留',409);}
    return await this.options.runtime.sendMessage(sessionId,message,{collaboration:scope});
    }finally{if(this.directDispatches.get(sessionId)===dispatch)this.directDispatches.delete(sessionId);}
  }
  async setAccess(id: string, input: Record<string, unknown>) {
    if (!['full','review'].includes(String(input.accessMode))) throw new WorkbenchError('请选择项目自主执行或逐项复核');
    const scope = text(input.scope,'项目范围');
    const project = this.project(id), control = this.control(project);
    if (!control) throw new WorkbenchError('项目尚未建立工作台',409);
    control.accessMode = input.accessMode as 'full'|'review'; control.scope=scope; this.writeControl(project,control,true);
    const applied: string[] = [], pending: string[] = [];
    for (const session of (await this.sessions(id)).filter(s=>!s.title.startsWith('BRI approval review '))) {
      try { await this.prepareSessionAccess(id,session.id); applied.push(session.id); } catch { pending.push(session.id); }
    }
    return {accessMode:control.accessMode,scope,applied,pending};
  }
  setBudget(id: string, input: Record<string, unknown>): {budget: ProjectBudget} {
    const project = this.project(id), control = this.control(project);
    if (!control) throw new WorkbenchError('项目尚未建立工作台', 409);
    try { control.budget = updateProjectBudget(control.budget, input.budget); }
    catch (error) { throw new WorkbenchError(errorText(error)); }
    this.writeControl(project, control, true);
    return {budget: control.budget};
  }
  automationTask(id: string, task: string): string {
    const project = this.project(id), control = this.control(project);
    if (!control || control.workflow === 'free') return task;
    return this.prompt(project, control.workflow, 'executor', task, control, true);
  }
  async workspace(id: string) {
    const project = this.project(id);
    const content = readProjectWorkspace(project, this.arisRoot);
    let sessions: LiveSession[] = [];
    let connectionError: string | undefined;
    try { sessions = await this.sessions(id); } catch (error) { connectionError = errorText(error); }
    const control = this.control(project);
    const figures = content.figures.map(figure => ({ ...figure, url: `/api/workbench/projects/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(figure.path)}` }));
    const workflows = [...content.workflows];
    if (control && control.workflow !== 'free' && workflows.length === 0) {
      const skill = this.skill(control.workflow);
      workflows.push({ id: `selected:${skill.id}`, skillId: skill.id, name: skill.title || skill.name, status: 'pending', runId: null, updatedAt: control.createdAt, steps: [], summary: '已选择此流程，等待执行者写入 ARIS 阶段记录。' } as any);
    }
    return { ...content, iterationStages: this.iterationStages(id), continuation: this.continuation(id), focus: new ArisReader([project]).overview(id,{summary:true}).focus, collaboration: this.collaborationStatus?.(id) ?? null, workflows, figures, sessions, control: control ? { ...control, error: connectionError ?? control.error } : undefined, ...(connectionError ? { error: connectionError } : {}) };
  }
  private register(project: ArisProjectRegistration): void {
    const file = resolve(this.options.repoRoot, this.options.registryFile);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const projects = Array.isArray(config) ? config : config.projects;
    if (!Array.isArray(projects)) throw new WorkbenchError('项目注册表格式无效');
    if (projects.some(p => p.id === project.id)) throw new WorkbenchError('项目标识已存在', 409);
    projects.push({ ...project, root: relative(dirname(file), project.root).replaceAll('\\', '/') });
    atomicJson(file, config);
  }
  private projectBrief(project: ArisProjectRegistration, workflow: string, provider: string, model?: string): string {
    if (workflow === 'free') return `# ${project.name}\n\n## 本次任务\n${project.goal}\n\n## 协作方式\n自由协作。执行者：${provider}${model ? ` / ${model}` : ''}。通过项目对话继续、调整和拆分任务；可按需让其他 coding agent 实现或审核，也可只调用一个 ARIS 技能。无需启动完整科研流程或生成论文。\n\n## 范围与约束\n${project.constraints || '按用户任务访问必要的文件与目录，交付结果优先保存在本项目。删除文件、修改系统权限或增加费用等操作按授权范围交由审核链判断。'}\n\n## 交付\n保留实际代码、文件和验证结果。图表可登记 .aris/figures.json 供工作台预览；仅当实际使用 ARIS 多阶段流程时才写其原生阶段状态。\n`;
    return `# ${project.name}\n\n## 研究目标\n${project.goal}\n\n## 执行与审核\n执行者：${provider}${model ? ` / ${model}` : ''}。独立审核：Codex。ARIS 技能：${workflow}。\n\n## 范围与资源\n${project.constraints || '在本项目目录中推进研究；需要新增付费、远端资源或扩大研究范围时明确提出，等待用户决定。'}\n\n## 交付与沟通\n保留可追溯的原始资料、实验代码、图表与结论。完成条件以目标和用户后续对话为准。通过 ARIS 原生记录区分执行完成和独立审核通过；不能自行将 done 当成 accepted。更新 .aris/progress.json 的摘要、下一步、卡点与待用户决定的问题。图表登记 .aris/figures.json，标明主图或补充图，保留源文件。\n`;
  }
  private prompt(project: ArisProjectRegistration, workflow: string, role: string, extra: string | undefined, control: Control, managed = false): string {
    const runId = `workbench-${randomUUID().slice(0, 12)}`;
    const reviewer = control.sessions.find(s => s.role === 'reviewer');
    if (workflow === 'free') return [
      `你在项目目录 ${project.root} 中${role === 'reviewer' ? '独立审核' : '执行具体任务'}。项目：${project.name || project.id}。${extra ? '项目背景（不是要求重做的任务）' : '本次任务'}：${project.goal || ''}`,
      `这是自由协作工作区，不默认启动完整研究或论文流程。先阅读 PROJECT_BRIEF.md（若有），根据用户的具体指令实施、验证并交付。约束：${project.constraints || '按用户明确任务访问必要位置；项目目录用于保留成果，不限制已授权的外部读取。涉及删除、系统权限或新增费用时交由审核链判断。'}`,
      `用户可以在本会话中继续调整任务，或手动将成果交给本项目的其他 agent。需要 ARIS 能力时只调用必要技能；技能目录 ${join(this.arisRoot, 'skills')}（只读），不为了使用 ARIS 而增加额外流程。`,
      '对用户已明确授权的同一操作和范围，不要反复发起确认问答。工具权限交由宿主权限机制和审核链处理；需要用户选择目标、偏好、资源或解决真实歧义时，使用原生问答工具并给出具体题目、范围和选项。',
      '生成图片或图表后可登记 .aris/figures.json：{"figures":[{"path":"figures/example.svg","title":"标题","role":"main"}]}，图表文件必须真实存在。普通组件/代码任务无需建立 ARIS run 或论文阶段。',
      '任务有实质进展、卡点或需要用户决定时，简要更新 .aris/progress.json：{summary,next_step,updated_at,blockers:[{id,title,detail,status}],questions:[{id,title,detail,status}]}。只记录真实进展，questions 只列需要用户决定的事项；完成的事项移除或标 resolved。',
      role === 'reviewer' ? '作为审核者，先检查真实代码与测试，说明可复现问题与改进建议；未经用户指定不替执行者直接大改。' : '',
      extra ? `本轮只执行以下具体要求；先检查已有成果，不重复项目初始任务：\n${extra}` : '',
    ].filter(Boolean).join('\n\n');
    return [
      `在研究目录 ${project.root} 中工作。目标：${project.goal || project.name}。执行角色：${role === 'reviewer' ? '独立审核者，依据真实产物给出评审，不替执行者自评通过' : '研究执行者'}。`,
      managed ? '宿主协调规则：本轮使用工作台管理的执行→独立Codex审核→返修。读取并采用所选ARIS技能的研究方法、证据与交付要求；技能中的另开审核会话、codex exec、直接调用Codex MCP和内部多轮返修由工作台替代，不在执行会话内重复启动。所有需委派的子任务仅用BRI create_agent/get_agent/wait_agent，不另起未登记后台agent。只提交当前阶段真实成果及后台要求的最终JSON回执；不可自行标记accepted。真正受阻时返回outcome=blocked及原因，不因缺审核工具反复启动替代会话。' : '',
      `先阅读本目录 RESEARCH_BRIEF.md（若有），保留所有已有成果，用户在本会话中的新指示用于调整本项目。约束：${project.constraints || '只在本项目范围内工作；额外资源、成本与方向取舍需要用户决定。'}`,
      `本次执行 ARIS /${workflow}。技能原文：${join(this.arisRoot, 'skills', workflow, 'SKILL.md')}。共享技能与工具只读；ARIS_REPO=${this.arisRoot}，工具目录=${join(this.arisRoot, 'tools')}。按真实技能定义执行并读取它引用的必要文件；不要只给计划后停下。`,
      `若该技能有多阶段流程，使用 ARIS run_state.py 原生工具，独立 run_id=${runId}；不要改写其他仍在运行的流程。已有已验收且不受变更影响的步骤不重复。done 仅执行完成，accepted 必须有独立评审或该技能的确定性验证依据。`,
      `持续更新 .aris/progress.json：{run_id,executor,reviewer:"Codex",summary,next_step,updated_at,blockers:[{id,title,detail,status}],questions:[{id,title,detail,status}]}。questions 只写确需用户决定的范围/资源/方向取舍，普通任务故障写 blockers。`,
      `图片和图表保存到项目内，生成时更新 .aris/figures.json：{"figures":[{"path":"figures/figure-1.png","title":"标题","stage":"实际ARIS阶段id","role":"main"}]}。role 可为 main/supplementary/unclassified；保留可编辑源文件。图表文件和清单应随实际产出更新，不预填不存在的图片。`,
      managed ? '独立审核将由工作台在执行交付并确认子会话停止后自动派发给绑定Codex；不要向该审核会话调用send_agent_prompt，不再发起技能内部审核循环。保留原始数据、代码和阶段产物，阶段done只表示交付。' : `当前为直接执行，未启动工作台自动审核闭环。${reviewer ? `已绑定独立 Codex 审核会话 id=${reviewer.id}，用户可在工作台将产物交给它或开启自动协作。` : '需要独立审核时请在工作台连接审核者并开启自动协作。'}交付后说明尚待独立审核，不可自评accepted。技能中的另开Codex CLI、直接调用审核MCP及内部返修循环不在本次直接执行中启动；BRI子会话工具仅用于登记的子任务，不可用它给绑定审核者发送消息。`,
      role === 'reviewer' ? '你是独立审核会话：优先只读检查，提供证据、问题与修改建议；不要擅自扩大执行任务。' : '',
      extra ? `用户对本轮的具体要求（在既有授权范围内优先遵循）：\n${extra}` : '',
    ].filter(Boolean).join('\n\n');
  }
  async createProject(input: Record<string, unknown>) {
    const name = text(input.name, '项目名称', 120);
    const goal = text(input.goal, '研究目标');
    const provider = text(input.provider, '执行者', 100);
    const { model, thinkingOptionId } = await this.selection(provider, input);
    const workflow = input.workflow ? text(input.workflow, '任务方式', 100) : 'free';
    this.skill(workflow);
    let budget: ProjectBudget | undefined;
    if (input.budget !== undefined) {
      try { budget = updateProjectBudget({}, input.budget); } catch (error) { throw new WorkbenchError(errorText(error)); }
    }
    if (input.autoCollaborate === true && !this.startCollaboration) throw new WorkbenchError('自动协作服务尚未配置', 503);
    const providers = await this.options.runtime.providers();
    if (!providers.some(p => p.id === provider && p.available)) throw new WorkbenchError('所选执行者当前不可用', 503);
    const base = resolve(this.options.projectBase ?? join(this.options.repoRoot, 'research-projects'));
    mkdirSync(base, { recursive: true });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'research';
    const id = `${slug}-${randomUUID().slice(0, 8)}`;
    const root = join(base, id);
    mkdirSync(root);
    mkdirSync(join(root, '.aris')); mkdirSync(join(root, '.bri'));
    // Canonical helper lookup is project-local; the shared helpers remain unchanged.
    try { symlinkSync(join(this.arisRoot, 'tools'), join(root, '.aris/tools'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* Prompt contains the absolute fallback. */ }
    const project: ArisProjectRegistration = { id, name, goal, root, constraints: typeof input.constraints === 'string' ? input.constraints.slice(0, 20_000) : '', executor: provider, reviewer: 'Codex', supervisor: `${provider} / ARIS + Codex reviewer` };
    writeFileSync(join(root, workflow === 'free' ? 'PROJECT_BRIEF.md' : 'RESEARCH_BRIEF.md'), this.projectBrief(project, workflow, provider, model), 'utf8');
    const accessMode = input.accessMode === 'review' ? 'review' : 'full';
    this.writeControl(project, { ...this.initialControl(workflow), ...(budget ? {budget} : {}), accessMode, scope: project.constraints || '在本项目内自主读写、测试、修复和生成成果；可查公开资料。不得读取凭据、修改宿主配置或其他项目、增加费用。超出范围或需改变研究目标时再向用户提问。' });
    this.register(project);
    const publicProject = { ...project, source: 'aris', updated_at: new Date().toISOString(), plan_version: 0 };
    if (input.autoCollaborate === true) {
      try {
        const collaboration = await this.startCollaboration!(id, { task: goal, provider, model, thinkingOptionId });
        return { project: publicProject, collaboration, session: (await this.session(id, collaboration.executorSessionId)).session };
      } catch (error) {
        const control = this.control(project)!; control.error = errorText(error); this.writeControl(project, control);
        return { project: publicProject, error: `项目已创建，自动协作尚未启动：${errorText(error)}` };
      }
    }
    // An idle reviewer establishes a genuinely separate conversation without
    // spending a review turn before there is an artifact to assess.
    if (workflow === 'research-pipeline' && providers.some(p => p.id === 'codex' && p.available)) {
      try { await this.createSession(id, { provider: 'codex', workflow, role: 'reviewer', idle: true }); }
      catch (error) { const control = this.control(project)!; control.reviewError = errorText(error); this.writeControl(project, control); }
    }
    try {
      const session = await this.createSession(id, { provider, model, thinkingOptionId, workflow, role: 'executor' });
      return { project: publicProject, session };
    } catch (error) {
      const control = this.control(project)!; control.error = errorText(error); this.writeControl(project, control);
      return { project: publicProject, error: `项目已创建，执行者尚未确认启动：${errorText(error)}` };
    }
  }
  async createSession(id: string, input: Record<string, unknown>): Promise<LiveSession> {
    if (this.locks.has(id)) throw new WorkbenchError('本项目正在创建会话，请等待结果', 409);
    this.locks.add(id);
    try {
      const project = this.project(id);
      const provider = text(input.provider, '执行者', 100);
      const selection = await this.selection(provider, input);
      const role = input.role === 'reviewer' ? 'reviewer' : 'executor';
      const workflow = input.workflow ? text(input.workflow, '任务方式', 100) : 'free';
      const skill = this.skill(workflow);
      let control = this.control(project) ?? this.initialControl(workflow);
      if (control.launch && control.launch.state !== 'ready') {
        this.invalidate(); await this.sessions(id); control = this.control(project)!;
        if (control.launch && control.launch.state !== 'ready') throw new WorkbenchError('上一次创建结果尚未确认；请先核对该项目已有会话，避免重复启动', 409);
      }
      const reviewKey = typeof input.reviewKey === 'string' ? text(input.reviewKey, '审核标识', 150) : undefined;
      const title = reviewKey || `${role === 'reviewer' ? '审核' : skill.title || workflow} · ${project.name || id} · ${randomUUID().slice(0, 6)}`;
      control.launch = { state: 'starting', title, role, workflow, provider, startedAt: new Date().toISOString() };
      delete control.error; this.writeControl(project, control);
      try {
        const initialPrompt = input.idle === true ? undefined : reviewKey && role === 'reviewer' ? text(input.prompt, '审核任务', 60_000) : this.executionScope(id) + '\n\n' + this.prompt(project, workflow, role, typeof input.prompt === 'string' ? input.prompt.slice(0, 40_000) : undefined, control);
        const scopedDirect = !!initialPrompt && !reviewKey && (!!this.options.runtime.setCollaborationScope || !!control.budget && Object.keys(control.budget).length>0);
        const session = await this.options.runtime.createSession({ cwd: project.root, provider,
          ...selection, title,
          ...(provider === 'dsh-pi' && !reviewKey && (control.accessMode === 'full' || this.options.dshAutoReview) ? { permissionPreset: control.accessMode === 'full' ? 'danger-full-access' as const : 'auto' as const } : {}),
          ...(provider === 'codex' && !reviewKey && control.accessMode === 'full' ? { modeId: 'full-access' as const } : {}),
          prompt: scopedDirect ? undefined : initialPrompt,
        });
        if (!session.id || !sameResearchDirectory(session.cwd, project.root)) throw new WorkbenchError('执行端返回的会话目录不匹配，未绑定到项目', 502);
        control.sessions.push({ id: session.id, role, workflow, provider, title: session.title });
        control.launch.state = 'ready'; this.writeControl(project, control); this.invalidate();
        if(scopedDirect){const result=await this.sendDirect(id,session.id,initialPrompt!);if(!result.accepted)throw new WorkbenchError('执行端未接收任务');session.status=result.status||'running';}
        return { ...session, role };
      } catch (error) {
        // The session may be valid while its first budgeted send was rejected.
        if(control.launch?.state==='ready'){control.error=errorText(error);this.writeControl(project,control);throw error;}
        const preflight = ['UNSUPPORTED_MODE', 'INVALID_MODE', 'INVALID_MODEL', 'INVALID_THINKING_OPTION', 'PROVIDER_ERROR'].includes(String((error as {code?: string})?.code));
        control.launch.state = preflight ? 'ready' : 'unknown';
        control.error = `${preflight ? '尚未创建会话' : '会话创建未确认'}：${errorText(error)}`; this.writeControl(project, control); this.invalidate(); throw error;
      }
    } finally { this.locks.delete(id); }
  }
  private async ownedSession(id: string, sessionId: string) {
    const project = this.project(id);
    if (!this.control(project)) throw new WorkbenchError('此项目尚未建立工作台会话', 409);
    text(sessionId, '会话 ID', 200);
    const metadata = (await this.allSessions()).find(s => s.id === sessionId);
    if (!metadata || !sameResearchDirectory(metadata.cwd, project.root)) throw new WorkbenchError('该会话不属于当前项目', 403);
    const detail = await this.options.runtime.inspectSession(sessionId);
    if (!sameResearchDirectory(detail.session.cwd, project.root)) throw new WorkbenchError('该会话不属于当前项目', 403);
    return detail;
  }
  async session(id: string, sessionId: string) {
    const detail = await this.ownedSession(id, sessionId);
    return { ...detail, approvalReviews: this.approvalReviews?.(id, sessionId) ?? [], approvalReviewStatus: this.approvalReviewStatus?.() };
  }
  async attention(id: string) {
    const sessions = (await this.sessions(id)).filter(session => !session.title.startsWith('BRI approval review '));
    const observations = await Promise.all(sessions.map(async session => {
      try {
        const detail = await this.session(id, session.id);
        return { ...detail, session: {...detail.session,role:session.role}, messages: detail.messages.filter(message=>message.text.trim()).slice(-12) };
      } catch (error) { return { session, error: errorText(error), approvals: [], messages: [] }; }
    }));
    const pending = observations.filter(detail=>detail.error || detail.approvals?.length || ['waiting_input','waiting'].includes(detail.session.status));
    const recent = sessions.flatMap(session => (this.approvalReviews?.(id, session.id) ?? []).map(review => ({ session, review })));
    for (const item of this.control(this.project(id))?.questionReplies ?? []) {
      const session = sessions.find(session => session.id === item.sessionId);
      if (session) recent.push({ session, review: { approvalId: item.requestId, state: 'answered', request: {title:item.title,description:item.description}, reason:item.answer, updatedAt:Date.parse(item.at), reviewers:[] } });
    }
    return { pending, recent, observations, observedAt: new Date().toISOString() };
  }
  async answerRecordedQuestion(id: string, input: Record<string, unknown>) {
    const questionId = text(input.questionId, '问题 ID', 200);
    const sessionId = text(input.sessionId, '会话 ID', 200);
    const answer = text(input.answer, '你的决定', 16000);
    const runId = input.runId === null ? null : text(input.runId, '研究轮次', 200);
    const project = this.project(id);
    await this.ownedSession(id, sessionId);
    if ((await this.sessions(id)).find(s => s.id === sessionId)?.role === 'reviewer') throw new WorkbenchError('项目决定应发送给执行会话');
    const key = JSON.stringify([id, runId, questionId]);
    if (this.decisionLocks.has(key)) throw new WorkbenchError('这项决定正在发送，请等待结果', 409);
    this.decisionLocks.add(key);
    try {
      const previous = this.control(project)?.recordedDecisions?.find(d => d.runId === runId && d.questionId === questionId);
      if (previous) {
        if(previous.answer !== answer) throw new WorkbenchError('这项问题已回答；如需改变决定，请在对话中发送新的方向',409);
        return { accepted: true, decision: previous, duplicate: true };
      }
      const focus = new ArisReader([project]).overview(id,{summary:true}).focus;
      if (focus.pipeline_run_id !== runId) throw new WorkbenchError('研究轮次已变化，请刷新后查看当前问题', 409);
      const question = focus.questions.find(q => q.id === questionId);
      if (!question) throw new WorkbenchError('该问题已结束或不再等待回答，请刷新', 409);
      const message = `关于项目待决事项「${question.title}」（${questionId}）\n我的决定：${answer}\n请按此继续执行，并更新对应问题的状态为 answered；不得再次等待同一答复。如需新的决定，请创建新的问题 ID。`;
      const result = await this.send(id, sessionId, message);
      if (!result.accepted) throw new WorkbenchError('执行端未接收答复；问题仍保留在待处理中', 502);
      // Receipt means the human has answered, not that the research work is done.
      // Read again after awaiting delivery so concurrent answers retain both records.
      const control = this.control(project)!;
      const decision: RecordedDecision = {questionId, runId, title: question.title, detail: question.detail, source: question.source, answer, sessionId, at: new Date().toISOString(), state: 'sent'};
      const currentLoop=this.collaborationStatus?.(id);
      const runPrefix=currentLoop&&['collab','followup'].find(prefix=>runId?.startsWith(`${prefix}-${currentLoop.id}-r`));
      if(currentLoop&&runPrefix)decision.appliesToRuns=[`${runPrefix}-${currentLoop.id}-r${currentLoop.revision}`];
      control.recordedDecisions = [...(control.recordedDecisions ?? []), decision];
      this.writeControl(project, control);
      return { accepted: true, decision };
    } finally { this.decisionLocks.delete(key); }
  }
  async attentionCounts() {
    const rows = await Promise.all(loadArisProjectRegistrations(this.options.registryFile, this.options.repoRoot).filter(p => !p.completed_at).map(async project => {
      const questions = new ArisReader([project]).overview(project.id,{summary:true}).focus.questions.length;
      if (!this.control(project)) return [project.id, {human: questions, automatic: 0}];
      try {
        // Sidebar counts need pending requests, not full histories from every project.
        const waiting = (await this.sessions(project.id)).filter(s => ['waiting_input','waiting'].includes(s.status) && !s.title.startsWith('BRI approval review '));
        const pending = await Promise.all(waiting.map(s=>this.session(project.id,s.id)));
        let human = questions, automatic = 0;
        for (const row of pending) for (const request of row.approvals ?? []) {
          const approval = request as {id:string;kind?:string};
          const review = (this.approvalReviews?.(project.id, row.session.id) ?? []).find((r:any) => r.approvalId === approval.id) as {state:string} | undefined;
          if (approval.kind === 'question' || !this.approvalReviewStatus?.().enabled || row.session.provider !== 'dsh-pi' || ['human_required','unknown'].includes(review?.state || '')) human++;
          else automatic++;
        }
        return [project.id, {human, automatic}];
      } catch { return [project.id, {human:questions, automatic:0, error:'实时待办暂不可用'}]; }
    }));
    return {projects: Object.fromEntries(rows)};
  }
  async answerQuestion(id: string, sessionId: string, approvalId: string, answers: Record<string, { selected: string[]; text?: string }>, cancel?: boolean) {
    const detail = await this.ownedSession(id, sessionId);
    text(approvalId, '问题 ID', 200);
    if (!this.options.runtime.respondQuestion) throw new WorkbenchError('执行端暂不支持在看板回答问题', 503);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || (cancel !== undefined && typeof cancel !== 'boolean')) throw new WorkbenchError('问答格式不正确');
    const result = await this.options.runtime.respondQuestion(sessionId, approvalId, answers, cancel);
    if (result.ok) {
      const pending = (detail.approvals ?? []).find((item: any) => item.id === approvalId) as {title?:string;description?:string} | undefined;
      const safe = (value: string) => value.replace(/((?:password|token|api[_-]?key|authorization)["'\s]*[:=]["'\s]*)([^\s,"'}]+)/gi, '$1[redacted]').slice(0, 16000);
      const project = this.project(id); const control = this.control(project)!;
      control.questionReplies = [...(control.questionReplies ?? []), {sessionId,requestId:approvalId,title:(pending?.title || 'Agent 提问').slice(0,600),description:safe(pending?.description || ''),answer:cancel ? '用户取消了本次问答。' : safe(Object.values(answers).map(answer => [...answer.selected, answer.text || ''].filter(Boolean).join('；')).join('\n')),at:new Date().toISOString()}];
      this.writeControl(project, control);
    }
    this.invalidate();
    return result;
  }
  async configure(id: string, sessionId: string, input: Record<string, unknown>) {
    const run = this.collaborationStatus?.(id);
    if (run && !['accepted', 'audited', 'paused', 'budget_exhausted', 'needs_attention'].includes(run.state) && [run.executorSessionId, run.reviewerSessionId].includes(sessionId)) throw new WorkbenchError('请先暂停自动协作，再更换模型', 409);
    const detail = await this.ownedSession(id, sessionId);
    if (!['idle', 'completed', 'stopped', 'interrupted', 'failed', 'error', 'canceled'].includes(detail.session.status) || detail.approvals?.length) throw new WorkbenchError('请先结束当前回合并处理待决请求，再修改模型设置', 409);
    if (!this.options.runtime.updateSession) throw new WorkbenchError('执行端暂不支持修改会话模型', 503);
    if (!Object.hasOwn(input, 'model') && !Object.hasOwn(input, 'thinkingOptionId')) throw new WorkbenchError('请选择要更新的模型或思考强度');
    const model = Object.hasOwn(input, 'model') ? input.model : detail.session.configuredModel ?? detail.session.model;
    const selection = await this.selection(detail.session.provider, { model, thinkingOptionId: input.thinkingOptionId });
    const result = await this.options.runtime.updateSession(sessionId, { cwd: this.project(id).root,
      ...(Object.hasOwn(input, 'model') ? { model: selection.model ?? null } : {}),
      ...(Object.hasOwn(input, 'thinkingOptionId') ? { thinkingOptionId: selection.thinkingOptionId ?? null } : {}),
    });
    this.invalidate(); return result;
  }
  recordDirection(id: string, content: string, sessionId: string): void {
    const project = this.project(id); const control = this.control(project)!;
    control.userDirections = [...(control.userDirections ?? []), { at: new Date().toISOString(), text: content, sessionId }].slice(-12);
    this.writeControl(project, control);
  }
  continuation(id:string) {
    const saved=this.control(this.project(id))?.continuation;
    if(!saved)return undefined;
    const run=this.collaborationStatus?.(id);
    if(!run)return saved;
    const state=['accepted','audited'].includes(run.state)?'completed':run.state==='paused'?'idle':['needs_attention','budget_exhausted'].includes(run.state)?'blocked':'running';
    return {...saved,state,activeStage:run.state==='planning'?'iteration-audit':run.state==='reviewing'&&saved.affectedStages.includes('auto-review-loop')?'auto-review-loop':saved.affectedStages[0],reason:run.error||run.reason||(run.state==='planning'?'Codex 正在审计现有成果并制定迭代计划；执行尚未开始。':run.state==='reviewing'?'Codex 正在独立审核；有问题会自动退回。':run.state==='synchronizing'?'执行与审核正在确认最新方向。':saved.reason||'按最新要求继续推进。'),updatedAt:new Date(run.updatedAt).toISOString()};
  }
  recordContinuation(id:string,sessionId:string,message:string,affectedStages?:string[]) {
    const project=this.project(id),control=this.control(project)!;
    const focus=new ArisReader([project]).overview(id,{summary:true}).focus;
    const active=focus.stages.filter(s=>!['accepted','skipped'].includes(s.status));
    control.continuation={state:'running',reason:message.slice(0,500),updatedAt:new Date().toISOString(),sessionId,
      affectedStages:affectedStages??(active.length?active.map(s=>s.id):focus.stages.filter(s=>s.status!=='skipped').map(s=>s.id))};
    this.writeControl(project,control);
  }
  iterationStages(id: string) {
    // Start with the most complete recorded sequence; a partial follow-up must
    // not make earlier stages disappear from the restart choices.
    const workflows = readProjectWorkspace(this.project(id), this.arisRoot).workflows;
    const stages = new Map<string, {id:string;name:string;status:string}>();
    for (const workflow of [...workflows].sort((a,b)=>b.steps.length-a.steps.length)) {
      for (const step of workflow.steps) if (!stages.has(step.id)) {
        const latest=workflows.flatMap(w=>w.steps).find(s=>s.id===step.id)!;
        stages.set(step.id, {id:step.id,name:step.name,status:latest.status});
      }
    }
    return [...stages.values()];
  }
  async send(id: string, sessionId: string, message: unknown, iteration?: unknown, auditFirst?:unknown) {
    if(auditFirst!==undefined&&typeof auditFirst!=='boolean')throw new WorkbenchError('审计规划选项必须为布尔值');
    let content = text(auditFirst===true&&(!message||typeof message==='string'&&!message.trim())?'继续迭代：请审计现有成果与原始项目目标的差距，提出范围内最值得做的改进及可验证计划。':message, '消息', 40_000);
    await this.ownedSession(id, sessionId);
    const run = this.collaborationStatus?.(id);
    const control=this.control(this.project(id))!;
    let affected: string[] | undefined;
    if (iteration !== undefined && iteration !== '') {
      const stages=this.iterationStages(id);
      if (typeof iteration!=='string' || !/^(all|(?:from|only):.+)$/.test(iteration)) throw new WorkbenchError('请选择有效的重做范围');
      const index=stages.findIndex(s=>s.id===iteration.slice(iteration.indexOf(':')+1));
      if (iteration!=='all' && index<0) throw new WorkbenchError('该阶段不属于本项目');
      const flows=readProjectWorkspace(this.project(id),this.arisRoot).workflows.sort((a,b)=>b.steps.length-a.steps.length);
      const main=flows.filter(w=>w.skillId===control.workflow);
      const sequence=iteration==='all' ? (main[0]??flows[0])?.steps??[] : (flows.find(w=>w.steps.some(s=>s.id===stages[index].id))?.steps??[]);
      const selected=iteration==='all' ? sequence : iteration.startsWith('only:') ? [stages[index]] : sequence.slice(sequence.findIndex(s=>s.id===stages[index].id));
      // Unrelated helper flows remain selectable, but are not downstream of a
      // research stage merely because their records are in the same project.
      affected=selected.filter((s,i)=>iteration!=='all'&&i===0 || stages.find(latest=>latest.id===s.id)?.status!=='skipped').map(s=>s.id);
      if (!affected.length) throw new WorkbenchError('本项目尚无可重做的阶段');
      const canCoordinate=run ? [run.executorSessionId,run.reviewerSessionId].includes(sessionId) : control.sessions.some(s=>s.id===sessionId&&s.role!=='reviewer') && control.sessions.some(s=>s.role==='reviewer'&&s.provider==='codex');
      if (!canCoordinate || !this.startCollaboration) throw new WorkbenchError('请在项目绑定的执行或审核会话中重做',409);
      const scope=iteration==='all'?'从头重新研究（保留已跳过的可选阶段）':iteration.startsWith('only:')?`只重做「${stages[index].name}」`:`从「${stages[index].name}」起重新推进后续阶段`;
      content=`本轮范围：${scope}。受影响阶段：${affected.join('、')}。\n用户要求：${content}\n保留前轮成果与验收记录，为本轮使用新的 ARIS 记录。不覆盖旧结论；遵守已有数据、资源和用户决定约束。先检查已有产物和证据，再针对上述要求重做，由绑定 Codex 独立审核并自动返修。`;
    }
    if (run && [run.executorSessionId, run.reviewerSessionId].includes(sessionId)) {
      // A stopped round keeps its own elapsed time, usage and receipts. Start
      // a fresh round with the same conversations; in-flight changes still sync.
      this.recordContinuation(id,sessionId,content,affected);
      const planning=(auditFirst as boolean|undefined) ?? (!!affected||run.auditFirst===true||['accepted','audited','budget_exhausted'].includes(run.state));
      const updated = ['accepted','audited','budget_exhausted','paused','needs_attention'].includes(run.state)
        ? await this.startCollaboration!(id,{reuseExisting:true,executorSessionId:run.executorSessionId,reviewerSessionId:run.reviewerSessionId,task:content,auditFirst:planning})
        : await this.steerCollaboration!(id, content,{auditFirst:planning});
      this.setCompleted(id,false);
      return { accepted: true, status: updated.state };
    }
    if((control.mode==='pipeline'||affected||auditFirst===true) && control.sessions.find(s=>s.id===sessionId)?.role!=='reviewer' && this.startCollaboration){
      const reviewer=control.sessions.find(s=>s.role==='reviewer'&&s.provider==='codex'&&!s.title.startsWith('BRI approval review '));
      if(reviewer){
        this.recordContinuation(id,sessionId,content,affected);
        const updated=await this.startCollaboration(id,{reuseExisting:true,executorSessionId:sessionId,reviewerSessionId:reviewer.id,auditFirst:auditFirst??true,task:`继续本项目任务。保留原有成果与未受影响的验收。本轮增量要求：\n${content}\n阅读 .bri/workbench.json 中已回答的决定，不再重复提问。若旧流程已完成而新要求改变研究工作，另建后续 ARIS run，记录受影响阶段的重新推进，不篡改旧验收。当前闭环要求先交付可审核的阶段成果，再由绑定 Codex 独立核验，必要时自动返修。`});
        this.setCompleted(id,false);
        return {accepted:true,status:updated.state};
      }
    }
    if(auditFirst===true)throw new WorkbenchError('请先连接一个独立 Codex 审核会话，再启动审计规划',409);
    this.recordDirection(id, content, sessionId);
    await this.prepareSessionAccess(id, sessionId);
    const result = await this.sendDirect(id, sessionId, this.executionScope(id) + '\n\n用户消息：\n' + content); this.invalidate(); return result;
  }
  /** User task cancellation includes delegated work; orchestration uses interrupt() below. */
  async stopTask(id: string, sessionId: string) {
    let detail=await this.ownedSession(id,sessionId);
    const seen=new Set<string>();
    while(detail.session.delegation){if(seen.has(detail.session.id))throw new WorkbenchError('子任务关联无效',409);seen.add(detail.session.id);detail=await this.ownedSession(id,detail.session.delegation.parentSessionId);}
    const parentId=detail.session.id,run=this.collaborationStatus?.(id);
    this.directDispatches.get(parentId)?.abort();
    if(run&&[run.executorSessionId,run.reviewerSessionId].includes(parentId)){
      if(!this.pauseCollaboration)throw new WorkbenchError('自动协作暂停服务尚未配置',503);
      const stopped=await this.pauseCollaboration(id);this.invalidate();
      return {ok:true,confirmed:stopped?.state==='paused',status:stopped?.state??'unknown',sessionId:parentId};
    }
    return this.stopDirectFamily(id,parentId);
  }
  private async stopDirectFamily(id:string,parentId:string,waitMs=0){
    const runtime=this.options.runtime,project=this.project(id);
    await runtime.setCollaborationScope?.(parentId,null);
    const children=await runtime.listDescendants?.(parentId)??[];
    for(const child of children)if(!sameResearchDirectory(child.cwd,project.root))throw new WorkbenchError('子会话不属于当前项目',403);
    const receipts=await Promise.allSettled([runtime.interruptSession(parentId),runtime.interruptDescendants?runtime.interruptDescendants(parentId):Promise.all(children.map(child=>runtime.interruptSession(child.id)))]);
    const idleStates=new Set(['idle','completed','succeeded','stopped','interrupted','canceled','failed','error']);
    const observe=async()=>{
      const currentChildren=await runtime.listDescendants?.(parentId)??[];
      for(const child of currentChildren)if(!sameResearchDirectory(child.cwd,project.root))throw new WorkbenchError('子会话不属于当前项目',403);
      const observations=await Promise.allSettled([parentId,...currentChildren.map(child=>child.id)].map(childId=>runtime.inspectSession(childId)));
      return observations.every(result=>result.status==='fulfilled'&&idleStates.has(result.value.session.status)&&!result.value.activeTurn&&!result.value.approvals?.length);
    };
    const deadline=Date.now()+waitMs;let confirmed=await observe();
    while(!confirmed&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));confirmed=await observe();}
    this.invalidate();
    const failures=receipts.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>errorText(result.reason));
    return {ok:receipts.every(result=>result.status==='fulfilled'),confirmed,status:confirmed?'interrupted':'stopping',sessionId:parentId,...(failures.length?{error:failures.join('; ')}:{})};
  }
  async interrupt(id: string, sessionId: string) {
    await this.ownedSession(id, sessionId);
    const result = await this.options.runtime.interruptSession(sessionId); this.invalidate(); return result;
  }
  async approve(id: string, sessionId: string, approvalId: string, optionId: string) {
    await this.ownedSession(id, sessionId);
    return this.options.runtime.respondApproval(sessionId, text(approvalId, '审批ID', 200), text(optionId, '审批选项', 200));
  }
}
