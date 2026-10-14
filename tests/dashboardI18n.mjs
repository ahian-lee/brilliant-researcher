import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.join(root, 'apps/dashboard');
const server = await createServer({ root: dashboard, server: { middlewareMode: true, hmr: {server: createHttpServer()} }, appType: 'custom' });
let networkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { networkRequests++; throw new Error('SSR i18n checks must not make network or model requests'); };
try {
  const { I18nProvider, LanguageSwitcher, translate, translations, LANGUAGE_STORAGE_KEY } = await server.ssrLoadModule('/src/i18n.tsx');
  const { NewResearchDialog, ModelFields } = await server.ssrLoadModule('/src/components/NewResearchDialog.tsx');
  const { ProjectOverview } = await server.ssrLoadModule('/src/components/ProjectOverview.tsx');
  const { ProjectActions } = await server.ssrLoadModule('/src/components/ProjectActions.tsx');
  const { ProjectAttention } = await server.ssrLoadModule('/src/components/ProjectAttention.tsx');
  const { ProjectScope } = await server.ssrLoadModule('/src/components/ProjectScope.tsx');
  const { ChatPanel } = await server.ssrLoadModule('/src/components/ChatPanel.tsx');
  const { Figures, WorkflowCard, SkillLibrary } = await server.ssrLoadModule('/src/pages/WorkbenchPage.tsx');
  const { Badge, statusMeta, stageLabel } = await server.ssrLoadModule('/src/status.tsx');
  const { durationSince, ago } = await server.ssrLoadModule('/src/format.ts');
  const noop = () => {};
  const raw = '用户原文：概览 / 图表 / 模型，不得翻译';
  const attention = { data: { pending: [], recent: [], observations: [] }, loading: false, error: null, lastOkAt: '2026-10-14T00:00:00Z' };
  const focus = { summary: raw, stages: [{id:'literature',label:raw,status:'accepted'}, {id:'plan',label:raw,status:'done'}], blockers: [], questions: [], answeredQuestions: [], updated_at: '2026-10-14T00:00:00Z' };
  const run = {
    id:'test-run',state:'planning',revision:2,round:1,revisionsUsed:0,maxRevisions:3,executorSessionId:'execute',reviewerSessionId:'review',directions:[],events:[],
    actions:[{id:'plan',revision:2,status:'replied',reply:{kind:'plan',revision:2,decision:'execute',summary:raw,recommendations:[raw],steps:[raw],audit:[raw],acceptanceCriteria:[raw]}}],
  };
  const sessions = [{id:'execute',title:raw,provider:'dsh-pi',role:'executor',status:'idle'}, {id:'review',title:raw,provider:'codex',role:'reviewer',status:'idle'}];
  const render = (language, component, props = {}) => renderToStaticMarkup(React.createElement(I18nProvider,{initialLanguage:language},React.createElement(component,props)));
  for (const language of ['en','zh']) {
    const dialog = render(language,NewResearchDialog,{onClose:noop,onCreated:noop});
    assert.ok(dialog.includes('id="research-name"') && dialog.includes('id="new-research-provider"'));
    assert.ok(dialog.includes(language==='en'?'Project name':'项目名称'));
    assert.ok(dialog.includes(language==='en'?'Create and start':'创建并开始'));
    assert.ok(dialog.includes(language==='en'?'Full research workflow':'完整研究流程'));
    assert.ok(dialog.includes('class="language-switcher"') && dialog.includes('>EN</button>') && dialog.includes('>中文</button>'), 'Modal must expose its own language control without bypassing the backdrop');
    const model = render(language,ModelFields,{provider:'codex',value:{model:'',thinkingOptionId:''},onChange:noop,onValidityChange:noop,idPrefix:'test-model'});
    assert.ok(model.includes(language==='en'?'Reasoning level':'思考档位'));
    const overview = render(language,ProjectOverview,{project:{id:'test',name:raw,goal:raw},focus,sessions,attention,now:0,collaboration:run,onOpenSession:noop,onOpenRequests:noop,onRefresh:noop});
    assert.ok(overview.includes(raw), 'Research content must remain verbatim');
    assert.ok(overview.includes(language==='en'?'What agents are doing':'Agent 正在做什么'));
    assert.ok(overview.includes(language==='en'?'Codex audit and plan':'Codex 的审计与计划'));
    assert.ok(overview.includes(language==='en'?'Improvement suggestions':'改进建议'));
    assert.ok(overview.includes(language==='en'?'Accepted 1 / 2':'当前已验收 1 / 2'));
    assert.ok(overview.includes('aria-valuenow="50"'));
    const actions = render(language,ProjectActions,{projectId:'test',hasRunningSessions:false,onChanged:noop});
    assert.ok(actions.includes(language==='en'?'Export results':'导出成果'));
    assert.ok(actions.includes(language==='en'?'Mark completed':'标记已完成'));
    const requests = render(language,ProjectAttention,{projectId:'test',sessions,questions:[],onOpenSession:noop,state:attention,onRefresh:noop,runId:null});
    assert.ok(requests.includes(language==='en'?'No requests await your answer':'当前没有等待你回答'));
    const scope = render(language,ProjectScope,{projectId:'test',scope:raw,accessMode:'full',onChanged:noop});
    assert.ok(scope.includes(raw));
    assert.ok(scope.includes(language==='en'?'Authorized project scope':'项目授权范围'));
    const chat = render(language,ChatPanel,{projectId:'test',sessions,selectedId:'',onSelect:noop,onStarted:noop,onCollapse:noop,questions:[],attention,focus,requestOpen:0,onOpenSession:noop});
    assert.ok(chat.includes(language==='en'?'Project conversation':'项目对话'));
    assert.ok(chat.includes('id="chat-session"'));
    const workflows = render(language,WorkflowCard,{workflow:{id:'workflow',name:'完整研究流程',skillId:'research-pipeline',status:'running',steps:[{id:'implementation',name:'实现与验证',status:'done'}],summary:raw},projectId:'test',figures:[],onSelectRun:noop,onSelectSkill:noop,onIterate:noop});
    assert.ok(workflows.includes(language==='en'?'Implementation and validation':'实现与验证'));
    assert.ok(workflows.includes(raw));
    const skills = render(language,SkillLibrary,{skills:[{id:'research-lit',name:'research-lit',title:'文献调研',description:raw,group:'Workflow Orchestrators',workflow:true}],selected:'',onSelect:noop});
    assert.ok(skills.includes(language==='en'?'Literature research':'文献调研'));
    assert.ok(skills.includes(language==='en'?'Workflow Orchestrators':'工作流编排'));
    assert.ok(skills.includes('value="全部"'), 'Language selection must not change filter values');
    assert.ok(skills.includes(raw), 'Skill source description stays verbatim');
    const gallery = render(language,Figures,{projectId:'test',figures:[{path:'figures/用户图表.png',title:raw,role:'main'}]});
    assert.ok(gallery.includes(language==='en'?'Main figures':'主图'));
    assert.ok(gallery.includes(raw) && gallery.includes('figures/用户图表.png'));
    const switcher = render(language,LanguageSwitcher);
    assert.ok(switcher.includes('EN') && switcher.includes('中文'));
    assert.ok(switcher.includes(language==='en'?'Interface language':'界面语言'));
    assert.ok(render(language,Badge,{meta:{label:'执行已结束',tone:'muted'}}).includes(language==='en'?'Execution ended':'执行已结束'));
    // Pure helpers share the current application locale; done is never acceptance.
    assert.equal(statusMeta('completed').label,language==='en'?'Execution ended':'执行已结束');
    assert.equal(stageLabel('plan'),language==='en'?'Plan':'方案');
    assert.equal(durationSince('2026-10-14T00:00:00Z','2026-10-14T00:01:05Z',0),language==='en'?'1m 05s':'1 分 05 秒');
    assert.equal(ago('2026-10-14T00:00:00Z',Date.parse('2026-10-14T00:00:10Z')),language==='en'?'10s ago':'10 秒前');
  }
  assert.equal(LANGUAGE_STORAGE_KEY,'bri-researcher:language');
  assert.equal(translate('未验收',{},'en'),'Not accepted');
  assert.equal(translate('实现与验收',{},'en'),'Implementation and acceptance');
  assert.equal(translate('当前 {0} 个阶段已验收，共 {1} 个阶段',{0:1,1:2},'en'),'1 stages accepted out of 2');
  assert.equal(translate(raw,{},'en'),raw);
  // Every literal translation key in the dashboard has an English dictionary entry.
  const files = [];
  const collect = dir => {for(const item of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())collect(file);else if(/\.tsx?$/.test(file))files.push(file);}};
  collect(path.join(dashboard,'src'));
  const missing = new Set(); let keysChecked = 0;
  for (const file of files) {
    const source = ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    const visit = node => {
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['tr','t'].includes(node.expression.text)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){
        const key=node.arguments[0].text; keysChecked++;
        if(/[\u3400-\u9fff]/.test(key)&&!Object.hasOwn(translations,key))missing.add(key);
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
  assert.deepEqual([...missing],[],`Missing English entries: ${[...missing].join(', ')}`);
  assert.ok(keysChecked>700);
  assert.equal(networkRequests,0);
  console.log(`PASS: bilingual core component SSR, verbatim research content, acceptance distinction, ${keysChecked} translation calls, zero network/model requests`);
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
