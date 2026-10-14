import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { annotateDshModels, readDshReadiness, type DshReadinessOptions } from '../packages/adapters/src/dshReadiness.ts';

const temp = mkdtempSync(join(tmpdir(), 'dsh-readiness-'));
const profilePatchPath = join(temp, 'profile.json');
const credentialStorePath = join(temp, 'credentials.json');
const projectEnvPath = join(temp, 'project.env'); const homeEnvPath = join(temp, 'home.env');
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const options: DshReadinessOptions = { profilePatchPath, credentialStorePath, projectEnvPath, homeEnvPath,
  parseYaml: JSON.parse, launchEnvironment: { values: {}, verified: true } };
const state = (provider = 'ustc', overrides: Partial<DshReadinessOptions> = {}) => readDshReadiness({ ...options, ...overrides }).routes.find(route => route.provider === provider)!;
try {
  write(profilePatchPath, [{ id: 'llm-pi-ai', config: { providers: {
    ustc: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, ark: { apiKeyEnv: 'ARK_API_KEY' }, ambient: {},
  } } }, { insert: [{ id: 'auto-review', name: '@deepseek-ai/dsh-experimental-auto-review' }] }]);
  assert.equal(state().status, 'missing');
  assert.equal(state('ambient').status, 'unknown');
  assert.equal(state('ustc', { launchEnvironment: undefined }).status, 'unknown');
  assert.equal(state('ustc', { launchEnvironment: { values: { DEEPSEEK_API_KEY: 'fixture' }, verified: false } }).status, 'unknown');
  write(credentialStorePath, { version: 1, refs: { DEEPSEEK_API_KEY: 'fixture-private-value' }, records: { 'client-connection/browser-session': { kind: 'grant', payload: 'fixture-private-session' } } });
  assert.equal(state().source, 'file');
  assert.equal(state('ustc', { launchEnvironment: { values: { DEEPSEEK_API_KEY: 'fixture-env' }, verified: true } }).source, 'env');
  assert.equal(JSON.stringify(readDshReadiness(options)).includes('fixture-private'), false);
  writeFileSync(projectEnvPath, 'ARK_API_KEY="fixture-project"\n');
  writeFileSync(homeEnvPath, 'ARK_API_KEY=fixture-home\n');
  assert.equal(state('ark').source, 'project-env');
  writeFileSync(projectEnvPath, 'ARK_API_KEY=\n');
  assert.equal(state('ark').source, 'user-env');
  writeFileSync(homeEnvPath, 'ARK_API_KEY=\n');
  const missing = readDshReadiness(options);
  const annotated = annotateDshModels([{ id: 'ustc/model' }, { id: 'ark/model' }, { id: 'ambient/model' }], missing);
  assert.equal(annotated[0].available, undefined); // presence is not an inference success claim.
  assert.equal(annotated[1].available, false);
  assert.match(annotated[1].unavailableReason!, /ARK_API_KEY/);
  assert.equal(annotated[2].available, undefined);
  write(credentialStorePath, { version: 99, refs: { ARK_API_KEY: 'fixture' } });
  assert.equal(state('ark').status, 'unknown');
  write(credentialStorePath, { version: 1, refs: { ARK_API_KEY: '' } });
  assert.equal(state('ark').status, 'unknown');
  writeFileSync(credentialStorePath, '{bad-json');
  assert.equal(state('ark').status, 'unknown');
  writeFileSync(homeEnvPath, 'ARK_API_KEY="multiline\n');
  assert.equal(state('ark').status, 'unknown');
  assert.equal(readDshReadiness({ ...options, parseCredentialStore: () => { throw new Error('fixture parse failure'); } }).routes[0].status, 'unknown');
  writeFileSync(profilePatchPath, '{bad-json');
  assert.equal(readDshReadiness(options).routes.length, 0);
  assert.match(readDshReadiness(options).error!, /未知/);
  console.log('dshReadiness: PASS');
} finally { rmSync(temp, { recursive: true, force: true }); }
