import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadArisProjectRegistrations } from '../../../packages/adapters/src/arisReader.ts';
import { FeishuNotifier } from '../../../packages/adapters/src/feishuNotifier.ts';
import { ApprovalCoordinator, type ApprovalCandidate, type ApprovalRequest } from '../../../packages/core/src/approvalCoordinator.ts';
import type { ResearchWorkbench } from '../../../packages/core/src/researchWorkbench.ts';

/** Workbench-owned DSH sessions only; existing BRI schedulers are not involved. */
export function connectApprovalReviews(workbench: ResearchWorkbench, repoRoot: string, registryFile: string, config: { codexModel?: string; codexThinkingOptionId?: string; reviewTimeoutMs?: number }): void {
  const feishuFile = join(repoRoot, 'var/feishu.local.json');
  const notifier = new FeishuNotifier({ configFile: feishuFile, dashboardUrl: 'http://127.0.0.1:8791/' });
  const notificationReady = (): boolean => {
    try { const c = JSON.parse(readFileSync(feishuFile, 'utf8')); return !!(c.appId && c.appSecret && c.receiveId && ['chat_id', 'open_id', 'email'].includes(c.receiveIdType)); }
    catch { return false; }
  };
  const candidate = async (projectId: string, sessionId: string): Promise<ApprovalCandidate> => {
    const project = workbench.project(projectId);
    const detail = await workbench.session(projectId, sessionId);
    const control = workbench.control(project);
    const directions = (control?.userDirections ?? []).filter(direction => direction.sessionId === sessionId);
    return {
      projectId, projectName: project.name || project.id, goal: project.goal || '', constraints: project.constraints || '',
      session: { ...detail.session, cwd: detail.session.cwd || '' },
      approvals: ((detail.approvals ?? []) as ApprovalRequest[]).filter(request => request.kind !== 'question'),
      userMessages: directions.map(direction => direction.text),
      authorizationVersion: directions.at(-1)?.at || '',
    };
  };
  const coordinator = new ApprovalCoordinator({ file: join(repoRoot, 'var/approval-reviews.json'),
    additionalProviders: ['codex'], codexModel: config.codexModel, reviewTimeoutMs: config.reviewTimeoutMs ?? 120_000,
    // The bridge itself includes queue time in its 45-second bound.
    operationTimeoutMs: 50_000,
    port: {
      async listCandidates() {
        const rows: ApprovalCandidate[] = [];
        for (const project of loadArisProjectRegistrations(registryFile, repoRoot)) {
          if (!workbench.control(project)) continue;
          for (const session of await workbench.sessions(project.id)) {
            const loop = workbench.collaborationStatus?.(project.id);
            const ownedCodex = session.provider === 'codex' && !!loop && [loop.executorSessionId, loop.reviewerSessionId].includes(session.id);
            if ((!ownedCodex && session.provider !== 'dsh-pi') || session.title.startsWith('BRI approval review ') || session.status !== 'waiting_input') continue;
            rows.push(await candidate(project.id, session.id));
          }
        }
        return rows;
      },
      createReviewer: input => workbench.createSession(input.projectId, { provider: input.provider, model: input.model,
        ...(input.provider === 'codex' && config.codexThinkingOptionId ? { thinkingOptionId: config.codexThinkingOptionId } : {}),
        reviewKey: input.reviewKey, prompt: input.prompt, role: 'reviewer', workflow: 'free' }),
      async findReviewer(projectId, reviewKey) { return (await workbench.sessions(projectId)).find(session => session.title === reviewKey) ?? null; },
      async inspectReviewer(projectId, sessionId) {
        const detail = await workbench.session(projectId, sessionId);
        return { status: detail.session.status, messages: detail.messages, approvals: detail.approvals as Array<{id: string}> };
      },
      readPending: candidate,
      allowOnce: (projectId, sessionId, approvalId, optionId) => workbench.approve(projectId, sessionId, approvalId, optionId),
      notifyHuman: notice => notifier.send(notice),
      humanNotificationReady: notificationReady,
    },
  });
  workbench.approvalReviews = (projectId, sessionId) => coordinator.reviews(projectId, sessionId);
  workbench.reviewApprovals = () => coordinator.tick();
  workbench.approvalReviewStatus = () => ({ enabled: true, notificationConfigured: notificationReady(), error: coordinator.lastError });
}
