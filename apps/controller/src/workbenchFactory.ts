import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { NativeRuntimeClient } from '../../../packages/adapters/src/nativeRuntime.ts';
import { ResearchWorkbench, type RuntimeModel } from '../../../packages/core/src/researchWorkbench.ts';
import { readDshReadiness, annotateDshModels } from '../../../packages/adapters/src/dshReadiness.ts';
import { connectCollaborations } from './workbenchCollaboration.ts';
import { connectApprovalReviews } from './workbenchApprovals.ts';

export function createWorkbench(repoRoot: string, registryFile: string): ResearchWorkbench | null {
  if (process.env.BRI_WORKBENCH_ENABLED !== '1' || !registryFile) return null;
  const file = resolve(process.env.BRI_WORKBENCH_CONFIG || join(repoRoot, 'var/workbench.local.json'));
  if (!existsSync(file)) return null;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const parseYaml = config.dsh?.packageRoot ? createRequire(import.meta.url)(join(config.dsh.packageRoot, 'yaml')).parse : null;
  const workbench = new ResearchWorkbench({ repoRoot, registryFile,
    dshAutoReview: config.dshAutoReview === true,
    reviewerSelection: config.reviewer || {},
    ...(parseYaml && config.dsh?.home ? { modelAvailability: (provider: string, models: RuntimeModel[]) => provider === 'dsh-pi' ? annotateDshModels(models, readDshReadiness({
      profilePatchPath: join(config.dsh.home, 'profiles', config.dsh.profile || 'bri-native', 'cordis.patch.yml'),
      credentialStorePath: join(config.dsh.home, '.credentials.yaml'),
      homeEnvPath: join(config.dsh.home, '.env'), parseYaml,
      // A controller environment is not evidence of a running DSH host's env.
    })) : models } : {}),
    ...(config.projectBase ? { projectBase: resolve(repoRoot, config.projectBase) } : {}),
    runtime: new NativeRuntimeClient(config.nativeUrl || 'http://127.0.0.1:8793'),
  });
  if (config.approvalReview?.enabled === true) {
    try { connectApprovalReviews(workbench, repoRoot, registryFile, config.approvalReview); }
    catch { workbench.approvalReviewStatus = () => ({ enabled: false, notificationConfigured: false, error: '自动审核记录无法读取；原审批保留，未自动放行。' }); }
  }
  connectCollaborations(workbench);
  return workbench;
}
