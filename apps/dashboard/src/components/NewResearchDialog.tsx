import { useI18n, catalogGroupKey, LanguageSwitcher } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { createWorkbenchProject, fetchWorkbenchModels, fetchWorkbenchProviders, fetchWorkbenchSkills } from '../workbenchApi';
import { useAsync } from '../hooks/useAsync';
import type { WorkbenchProjectCreated, WorkbenchProvider, WorkbenchSkill } from '../workbenchTypes';

export interface ModelSelection { model: string; thinkingOptionId: string }
export interface AgentSelection extends ModelSelection { provider: string; ready: boolean }

export function ModelFields({ provider, value, onChange, onValidityChange, disabled = false, idPrefix }: {
  provider: string; value: ModelSelection; onChange: (value: ModelSelection) => void;
  onValidityChange: (ready: boolean) => void; disabled?: boolean; idPrefix: string;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [retry, setRetry] = useState(0);
  const state = useAsync(() => provider ? fetchWorkbenchModels(provider) : Promise.resolve({ models: [] }), [provider, retry], { resetKey: provider });
  const change = useRef(onChange);
  const valid = useRef(onValidityChange);
  change.current = onChange; valid.current = onValidityChange;
  const models = state.data?.models ?? [];
  const selected = models.find((model) => model.id === value.model);
  const options = selected?.thinkingOptions ?? [];
  const defaultOption = options.find((option) => option.id === selected?.defaultThinkingOptionId) ?? options.find((option) => option.isDefault);
  const selectedOption = options.find((option) => option.id === value.thinkingOptionId);
  const error = state.error?.message || state.data?.error;
  const modelReady = !!provider && (!value.model || (!!selected && selected.available !== false && !error && !state.loading));
  useEffect(() => { valid.current(modelReady); }, [modelReady]);
  useEffect(() => {
    if (!state.data || error || state.loading) return;
    if (value.thinkingOptionId && !options.some((option) => option.id === value.thinkingOptionId)) {
      change.current({ model: value.model, thinkingOptionId: '' });
    }
  }, [state.data, state.loading, error, value.model, value.thinkingOptionId]);
  return <div className="wb-model-fields">
    <label htmlFor={`${idPrefix}-model`}>{tr("模型")}<select id={`${idPrefix}-model`} value={value.model} disabled={disabled || state.loading || !provider} onChange={(event) => {
      const model = models.find((item) => item.id === event.target.value);
      onChange({ model: event.target.value, thinkingOptionId: model?.thinkingOptions?.some((option) => option.id === value.thinkingOptionId) ? value.thinkingOptionId : '' });
    }}><option value="">{state.loading ? tr("正在读取模型…") : tr("使用执行端默认模型")}</option>{value.model && !selected ? <option value={value.model} disabled>{value.model}  {tr("· 未在当前列表中")}</option> : null}{models.map((model) => <option key={model.id} value={model.id} disabled={model.available === false}>{model.name}{model.available === false ? tr(" · 不可用{0}", { 0: model.unavailableReason ? `：${model.unavailableReason}` : '' }) : ''}</option>)}</select></label>
    <label htmlFor={`${idPrefix}-thinking`}>{tr("思考档位")}<select id={`${idPrefix}-thinking`} value={value.thinkingOptionId} disabled={disabled || state.loading || !provider || !options.length || selected?.available === false} onChange={(event) => onChange({ ...value, thinkingOptionId: event.target.value })}><option value="">{defaultOption ? tr("执行端默认（{0}）", { 0: defaultOption.label }) : tr("执行端默认")}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.isDefault || option.id === selected?.defaultThinkingOptionId ? tr(" · 默认") : ''}</option>)}</select></label>
    {selectedOption?.description ? <p className="wb-muted">{selectedOption.description}</p> : null}
    {selected?.available === false ? <p className="wb-error" role="alert">{selected.unavailableReason || tr("执行端报告此模型当前不可用。")}</p> : null}
    {selected && selected.available === undefined ? <p className="wb-muted">{selected.credentialStatus === 'present' ? tr("凭据已配置，调用结果以实际执行为准。") : tr("尚未核实此模型的完整认证状态。")}</p> : null}
    {selected && !options.length ? <p className="wb-muted">{tr("执行端未提供此模型的可选思考档位，将使用默认配置。")}</p> : null}
    {error ? <p className="wb-error" role="alert">{tr("模型列表读取失败：")}{tr(error)}{tr("。可使用执行端默认配置。")} <button type="button" className="wb-text-button" onClick={() => setRetry((n) => n + 1)} disabled={disabled || state.loading}>{tr("重试")}</button></p> : null}
    {models.some((model) => model.available === false) ? <details className="wb-unavailable-models"><summary>{tr("不可用模型（")}{models.filter((model) => model.available === false).length}）</summary>{models.filter((model) => model.available === false).map((model) => <p className="wb-muted" key={model.id}><strong>{model.name}</strong>：{model.unavailableReason || tr("执行端报告不可用")}</p>)}</details> : null}
  </div>;
}

export function AgentFields({ value, onChange, disabled = false, idPrefix }: {
  value: AgentSelection; onChange: (value: AgentSelection) => void; disabled?: boolean; idPrefix: string;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [providers, setProviders] = useState<WorkbenchProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    fetchWorkbenchProviders().then((result) => {
      if (!active) return;
      setProviders(result.providers ?? []);
      const provider = result.providers?.find((item) => item.id === 'dsh-pi' && item.available) ?? result.providers?.find((item) => item.available);
      setError(result.error || (!result.connected ? "Agent 服务尚未连接。" : ''));
      change.current({ provider: provider?.id ?? '', model: '', thinkingOptionId: '', ready: false });
    }).catch((err: unknown) => { if (active) { setError(String(err instanceof Error ? err.message : err)); change.current({ provider: '', model: '', thinkingOptionId: '', ready: false }); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  const providerReady = !loading && providers.some((provider) => provider.id === value.provider && provider.available);
  useEffect(() => {
    const ready = providerReady && modelReady;
    if (value.ready !== ready) change.current({ ...value, ready });
  }, [providerReady, modelReady, value]);
  const unavailable = providers.filter((provider) => !provider.available);
  return <div className="wb-agent-fields">
    <label htmlFor={`${idPrefix}-provider`}>Coding agent<select id={`${idPrefix}-provider`} value={value.provider} disabled={disabled || loading} onChange={(event) => { setModelReady(false); onChange({ provider: event.target.value, model: '', thinkingOptionId: '', ready: false }); }}><option value="">{loading ? tr("正在连接 agent…") : tr("选择可用 agent")}</option>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.name}{!provider.available ? tr(" · 不可用") : ''}</option>)}</select></label>
    <ModelFields key={value.provider} provider={value.provider} value={value} onChange={(selection) => onChange({ ...value, ...selection, ready: false })} onValidityChange={setModelReady} disabled={disabled} idPrefix={idPrefix} />
    {error ? <div className="wb-error" role="alert">{tr(error)} <button type="button" className="wb-text-button" onClick={() => setRetry((n) => n + 1)} disabled={disabled || loading}>{tr("重试连接")}</button></div> : null}
    {!loading && !providers.some((provider) => provider.available) ? <p className="wb-muted">{tr("当前没有可启动的 agent。请连接服务后重试。")}</p> : null}
    {unavailable.length ? <details className="wb-unavailable-providers"><summary>{tr("其他执行者未配置 / 不可用（")}{unavailable.length}）</summary><div>{unavailable.map((provider) => <details key={provider.id}><summary>{provider.name}</summary><p className="wb-muted">{provider.error || tr("当前执行者不可用。")}</p></details>)}</div></details> : null}
  </div>;
}

export function NewResearchDialog({ onClose, onCreated }: {
  onClose: () => void; onCreated: (project: WorkbenchProjectCreated, error?: string) => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [constraints, setConstraints] = useState(() => tr("在本项目内自主读写、测试、修复和生成成果；可查公开资料。不读取凭据、不修改宿主配置或其他项目、不增加费用。超出范围或改变研究目标时再提问。"));
  const [accessMode,setAccessMode]=useState<'full'|'review'>('full');
  const [mode, setMode] = useState<'free' | 'skill' | 'pipeline'>('free');
  const [autoCollaborate, setAutoCollaborate] = useState(true);
  const [skills, setSkills] = useState<WorkbenchSkill[]>([]);
  const [skillId, setSkillId] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState('');
  const [skillRetry, setSkillRetry] = useState(0);
  const [agent, setAgent] = useState<AgentSelection>({ provider: '', model: '', thinkingOptionId: '', ready: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    firstInput.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    if (mode !== 'skill') return;
    let active = true;
    setSkillLoading(true); setSkillError('');
    fetchWorkbenchSkills().then((result) => {
      if (!active) return;
      setSkills(result.skills ?? []); setSkillError(result.error || '');
    }).catch((err: unknown) => { if (active) setSkillError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (active) setSkillLoading(false); });
    return () => { active = false; };
  }, [mode, skillRetry]);
  const availableSkills = skills.filter((skill) => skill.id !== 'research-pipeline');
  const filteredSkills = availableSkills.filter((skill) => `${skill.title} ${tr(skill.title)} ${skill.name} ${skill.description}`.toLowerCase().includes(skillSearch.toLowerCase()));
  const selectedSkill = availableSkills.find((skill) => skill.id === skillId);
  const ready = agent.ready && (mode !== 'skill' || (!!selectedSkill && !skillLoading && !skillError));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting.current || !name.trim() || !goal.trim() || !ready) return;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      const result = await createWorkbenchProject({ name: name.trim(), goal: goal.trim(), provider: agent.provider, model: agent.model || undefined, thinkingOptionId: agent.thinkingOptionId || undefined, workflow: mode === 'free' ? 'free' : mode === 'pipeline' ? 'research-pipeline' : skillId, accessMode, autoCollaborate: mode === 'free' && autoCollaborate, constraints: constraints.trim() || undefined });
      if (result.project) onCreated(result.project, result.error);
      else setError(result.error || "服务未返回新项目，请检查连接后重试。");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <div className="wb-modal-backdrop" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key === 'Tab') {
      const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary'));
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <section className="wb-modal" role="dialog" aria-modal="true" aria-labelledby="new-research-title">
      <div className="wb-heading"><div><span className="wb-eyebrow">{tr("让 agent 一起推进工作")}</span><h2 id="new-research-title">{tr("新建项目")}</h2></div><LanguageSwitcher /><button type="button" className="wb-icon-button" aria-label={tr("关闭新建项目")} onClick={onClose} disabled={busy}>×</button></div>
      <p className="wb-muted">{tr("项目是持续协作的空间。可以实现一个组件、完成单项任务，也可以推进完整研究。")}</p>
      <form onSubmit={(event) => void submit(event)} className="wb-form">
        <label htmlFor="research-name">{tr("项目名称")}<input ref={firstInput} id="research-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required disabled={busy} placeholder={tr("例如：图表组件开发 / MOF 结构分析")} /></label>
        <label htmlFor="research-goal">{tr("本次任务 / 首条指令")}<textarea id="research-goal" value={goal} onChange={(event) => setGoal(event.target.value)} required disabled={busy} rows={4} placeholder={tr("先让 agent 做什么？之后可以继续对话，或邀请其他 agent 协作。")} /></label>
        <AgentFields idPrefix="new-research" value={agent} onChange={setAgent} disabled={busy} />
        <label htmlFor="project-mode">{tr("开始方式")}<select id="project-mode" value={mode} onChange={(event) => setMode(event.target.value as 'free' | 'skill' | 'pipeline')} disabled={busy}><option value="free">{tr("自由协作")}</option><option value="skill">{tr("ARIS 单项任务")}</option><option value="pipeline">{tr("完整研究流程")}</option></select></label>
        <p className="wb-mode-description wb-muted">{mode === 'free' ? tr("直接按首条指令工作，随时添加其他 agent 会话或使用 ARIS 技能。") : mode === 'skill' ? tr("选择一个真实 ARIS 技能，只围绕当前任务执行。") : tr("按 ARIS Research Pipeline 推进各研究阶段。")}</p>
        {mode === 'free' ? <label className="wb-auto-review"><input type="checkbox" checked={autoCollaborate} onChange={(event) => setAutoCollaborate(event.target.checked)} disabled={busy} /><span><strong>{tr("自动执行与 Codex 审核")}</strong><small>{tr("执行者交付后由独立 Codex 会话检查，按反馈自动返修。聊天调整方向会同步两方。")}</small></span></label> : null}
        {mode === 'skill' ? <div className="wb-form wb-task-picker"><label htmlFor="project-skill-search">{tr("搜索 ARIS 任务")}<input id="project-skill-search" type="search" value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} disabled={busy} placeholder={tr("搜索名称或用途")} /></label><label htmlFor="project-skill">{tr("ARIS 任务")}<select id="project-skill" value={skillId} onChange={(event) => setSkillId(event.target.value)} disabled={busy || skillLoading}><option value="">{skillLoading ? tr("正在读取任务…") : tr("选择一项任务")}</option>{selectedSkill && !filteredSkills.some((skill) => skill.id === skillId) ? <option value={selectedSkill.id}>{tr(selectedSkill.title || selectedSkill.name)}{tr("（已选择）")}</option> : null}{filteredSkills.map((skill) => <option key={skill.id} value={skill.id}>{tr(skill.title || skill.name)} · {tr(catalogGroupKey(skill.group))}</option>)}</select></label>{selectedSkill ? <p className="wb-muted">{selectedSkill.description}</p> : null}{!skillLoading && !filteredSkills.length && !skillError ? <p className="wb-muted">{tr("没有符合条件的任务。")}</p> : null}{skillError ? <p className="wb-error" role="alert">{tr("任务目录读取失败：")}{skillError} <button type="button" className="wb-text-button" onClick={() => setSkillRetry((value) => value + 1)} disabled={busy || skillLoading}>{tr("重试")}</button></p> : null}</div> : null}
        <label>{tr("执行权限")}<select value={accessMode} onChange={event=>setAccessMode(event.target.value as 'full'|'review')} disabled={busy}><option value="full">{tr("完全访问，按项目范围自主执行")}</option><option value="review">{tr("保留逐项权限复核")}</option></select></label><label htmlFor="research-constraints">{tr("项目范围与资源")}<textarea id="research-constraints" value={constraints} onChange={event=>setConstraints(event.target.value)} disabled={busy} rows={3} required /></label>

        {error ? <p className="wb-error" role="alert">{tr(error)}</p> : null}
        <div className="wb-form-footer"><button type="button" className="wb-button" onClick={onClose} disabled={busy}>{tr("取消")}</button><button type="submit" className="wb-button primary" disabled={busy || !ready || !name.trim() || !goal.trim()}>{busy ? tr("正在创建并启动…") : tr("创建并开始")}</button></div>
      </form>
    </section>
  </div>;
}
