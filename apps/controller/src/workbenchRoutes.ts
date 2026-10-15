import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import { ResearchWorkbench, WorkbenchError } from '../../../packages/core/src/researchWorkbench.ts';
import { readProjectArtifact, readSkillCatalog, readSkillDetail } from '../../../packages/adapters/src/arisWorkspace.ts';
import { exportProjectResults, ProjectExportError } from '../../../packages/adapters/src/projectExport.ts';

/** Local interactive routes are separate from the protected historical BRI API. */
export function allowWorkbenchWrite(req: Pick<FastifyRequest, 'headers' | 'method'>): boolean {
  const host = String(req.headers.host ?? '');
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { const url = new URL(origin); if (url.host !== host || !['http:', 'https:'].includes(url.protocol)) return false; }
    catch { return false; }
  }
  return req.headers['x-bri-workbench'] === '1' && String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

export function registerWorkbenchRoutes(app: FastifyInstance, workbench: ResearchWorkbench | null): void {
  const requireWorkbench = (): ResearchWorkbench => {
    if (!workbench) throw new WorkbenchError('工作台执行服务尚未配置，请检查本机配置', 503);
    return workbench;
  };
  const handle = (fn: (req: any, reply: FastifyReply) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(req.headers.host ?? ''))) return reply.code(403).send({ error: '工作台仅接受本机地址访问' });
    if (!['GET', 'HEAD'].includes(req.method) && !allowWorkbenchWrite(req)) return reply.code(403).send({ error: '仅接受本地工作台页面发起的操作' });
    try { return await fn(req, reply); }
    catch (error) {
      const status = error instanceof WorkbenchError ? error.statusCode : 502;
      return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  app.get('/api/workbench/providers', handle(async () => requireWorkbench().providers()));
  app.get('/api/workbench/approval-status', handle(() => requireWorkbench().approvalReviewStatus?.() ?? { enabled: false, notificationConfigured: false, error: null }));
  app.get('/api/workbench/providers/:provider/models', handle(async req => requireWorkbench().models(req.params.provider)));
  app.get('/api/workbench/attention-counts', handle(() => requireWorkbench().attentionCounts()));
  app.post('/api/workbench/projects/:projectId/decisions', handle(req => requireWorkbench().answerRecordedQuestion(req.params.projectId, req.body ?? {})));
  app.get('/api/workbench/skills', handle(() => ({ skills: readSkillCatalog(requireWorkbench().arisRoot) })));
  app.get('/api/workbench/skills/:skillId', handle((req, reply) => {
    const skill = readSkillDetail(requireWorkbench().arisRoot, req.params.skillId);
    return skill ? { skill: { ...skill, content: skill.body } } : reply.code(404).send({ error: '技能不存在' });
  }));
  app.post('/api/workbench/projects', handle(async (req, reply) => reply.code(201).send(await requireWorkbench().createProject(req.body ?? {}))));
  app.get('/api/workbench/projects/:projectId', handle(req => requireWorkbench().workspace(req.params.projectId)));
  app.post('/api/workbench/projects/:projectId/collaboration/start', handle(req => requireWorkbench().startCollaboration?.(req.params.projectId, req.body ?? {}) ?? Promise.reject(new WorkbenchError('自动协作未配置', 503))));
  app.post('/api/workbench/projects/:projectId/collaboration/steer', handle(req => requireWorkbench().steerCollaboration?.(req.params.projectId, req.body?.message, {auditFirst:req.body?.auditFirst}) ?? Promise.reject(new WorkbenchError('自动协作未配置', 503))));
  app.post('/api/workbench/projects/:projectId/collaboration/pause', handle(req => requireWorkbench().pauseCollaboration?.(req.params.projectId) ?? Promise.reject(new WorkbenchError('自动协作未配置', 503))));
  app.post('/api/workbench/projects/:projectId/access', handle(req => requireWorkbench().setAccess(req.params.projectId, req.body ?? {})));
  app.post('/api/workbench/projects/:projectId/budget', handle(req => requireWorkbench().setBudget(req.params.projectId, req.body ?? {})));
  app.patch('/api/workbench/projects/:projectId/budget', handle(req => requireWorkbench().setBudget(req.params.projectId, req.body ?? {})));
  app.get('/api/workbench/projects/:projectId/attention', handle(req => requireWorkbench().attention(req.params.projectId)));
  app.post('/api/workbench/projects/:projectId/completion', handle(req => requireWorkbench().setCompleted(req.params.projectId, req.body?.completed)));
  app.post('/api/workbench/projects/:projectId/export', handle(async (req, reply) => {
    const project = requireWorkbench().project(req.params.projectId);
    try {
      const result = await exportProjectResults({ ...project, name: project.name || project.id });
      const filename = encodeURIComponent(result.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="research-results.zip"; filename*=UTF-8''${filename}`)
        .type('application/zip').send(result.bytes);
    } catch (error) {
      if (error instanceof ProjectExportError) throw new WorkbenchError(error.message, error.code === 'LIMIT_EXCEEDED' ? 413 : error.code === 'INVALID_INPUT' ? 400 : 409);
      throw error;
    }
  }));
  app.post('/api/workbench/projects/:projectId/sessions', handle(async req => ({ session: await requireWorkbench().createSession(req.params.projectId, req.body ?? {}) })));
  app.get('/api/workbench/projects/:projectId/sessions/:sessionId', handle(req => requireWorkbench().session(req.params.projectId, req.params.sessionId)));
  app.post('/api/workbench/projects/:projectId/sessions/:sessionId/messages', handle(req => requireWorkbench().send(req.params.projectId, req.params.sessionId, req.body?.message, req.body?.iteration,req.body?.auditFirst)));
  app.post('/api/workbench/projects/:projectId/sessions/:sessionId/config', handle(req => requireWorkbench().configure(req.params.projectId, req.params.sessionId, req.body ?? {})));
  app.post('/api/workbench/projects/:projectId/sessions/:sessionId/interrupt', handle(req => requireWorkbench().stopTask(req.params.projectId, req.params.sessionId)));
  app.post('/api/workbench/projects/:projectId/sessions/:sessionId/approvals/:approvalId', handle(req => requireWorkbench().approve(req.params.projectId, req.params.sessionId, req.params.approvalId, req.body?.optionId)));
  app.post('/api/workbench/projects/:projectId/sessions/:sessionId/questions/:approvalId', handle(req => requireWorkbench().answerQuestion(req.params.projectId, req.params.sessionId, req.params.approvalId, req.body?.answers ?? {}, req.body?.cancel)));
  app.get('/api/workbench/projects/:projectId/artifact', handle((req, reply) => {
    const project = requireWorkbench().project(req.params.projectId);
    if (typeof req.query.path !== 'string') return reply.code(400).send({ error: '缺少产物路径' });
    const artifact = readProjectArtifact({ root: project.root, path: req.query.path });
    if (!artifact) return reply.code(404).send({ error: '产物不存在、不可预览或不属于当前项目' });
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', `${artifact.disposition}; filename*=UTF-8''${encodeURIComponent(basename(artifact.path))}`);
    if (artifact.contentSecurityPolicy) reply.header('content-security-policy', artifact.contentSecurityPolicy);
    return reply.type(artifact.mime).send(artifact.bytes);
  }));
}
