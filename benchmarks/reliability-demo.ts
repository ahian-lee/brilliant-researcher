import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CollaborationLoop as Loop, CollaborationInspection, CollaborationScope } from '../packages/core/src/collaborationLoop.ts';
const { CollaborationLoop } = await import(process.env.BRI_EVAL_CONTROLLER
  ? pathToFileURL(resolve(process.env.BRI_EVAL_CONTROLLER)).href
  : new URL('../packages/core/src/collaborationLoop.ts', import.meta.url).href) as { CollaborationLoop: typeof Loop };

const faults = ['precommit', 'lost-ack', '503-after-commit', 'process-restart', 'stale-revision'] as const;
const strategies = ['retry-once', 'conservative-stop', 'bri'] as const;
type Fault = typeof faults[number];
type Strategy = typeof strategies[number];
type Identity = { kind: 'execute' | 'plan' | 'review' | 'sync'; actionId: string; revision: number };
const task = 'Synthetic task: apply one unit to the SQLite ledger and verify the result.';
const replacement = 'Cancel the uncommitted old write. Verify that the ledger is unchanged.';
const script = fileURLToPath(import.meta.url);

type Choice = 'report' | 'write' | 'hold';
type ObservedChoices = { planner: Choice; executor: Choice };
const [mode, folder, input] = process.argv.slice(2);
const live: ObservedChoices | undefined = mode === '--live-503'
  ? JSON.parse(readFileSync(input, 'utf8'))
  : undefined;
if (live) {
  for (const value of [live.planner, live.executor]) {
    assert(['report', 'write', 'hold'].includes(value), 'Unrecognized observed model choice');
  }
}

class Ledger {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    this.db = new DatabaseSync(join(directory, 'ledger.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS effects (revision INTEGER NOT NULL)');
  }
  write(revision: number) {
    this.db.prepare('INSERT INTO effects(revision) VALUES(?)').run(revision);
  }
  revisions(): number[] {
    return this.db.prepare('SELECT revision FROM effects ORDER BY rowid').all().map(row => Number(row.revision));
  }
}

function reply(identity: Identity, data: object) {
  return { id: 'final-' + identity.actionId, role: 'assistant', final: true,
    text: JSON.stringify({ ...identity, ...data }) };
}

class FixturePort {
  readonly observations = new Map<string, CollaborationInspection>([
    ['executor', { provider: 'dsh-pi', status: 'idle', messages: [] }],
    ['reviewer', { provider: 'codex', status: 'idle', messages: [] }],
  ]);
  readonly sends: Identity[] = [];
  inspections = 0;
  interrupts = 0;
  revocations = 0;
  directory: string;
  ledger: Ledger;
  fault: Fault;
  constructor(directory: string, ledger: Ledger, fault: Fault) {
    this.directory = directory;
    this.ledger = ledger;
    this.fault = fault;
  }
  async inspect(id: string) {
    this.inspections++;
    return structuredClone(this.observations.get(id)!);
  }
  async interrupt(id: string) {
    this.interrupts++;
    this.observations.get(id)!.status = 'idle';
    return { ok: true };
  }
  async revoke() {
    this.revocations++;
  }
  emit(id: string, identity: Identity, data: object, idle = true) {
    const session = this.observations.get(id)!;
    session.messages.push(reply(identity, data));
    if (idle) {
      session.status = 'idle';
      delete session.error;
    }
  }
  finish(identity: Identity) {
    writeFileSync(join(this.directory, 'result.json'), JSON.stringify(this.ledger.revisions()));
    this.emit('executor', identity, { summary: 'Fixture execution finished.', artifacts: ['result.json'], tests: ['Read durable ledger.'] });
  }
  async send(id: string, prompt: string, scope?: CollaborationScope) {
    assert(scope);
    const run = JSON.parse(readFileSync(join(this.directory, '.bri', 'collaboration.json'), 'utf8')).runs.at(-1);
    const action = run.actions.find((row: Identity & {id: string}) => row.id === scope.actionId);
    assert(action && action.revision === scope.revision);
    const kind = action.kind as Identity['kind'];
    const identity = { kind, actionId: scope.actionId, revision: scope.revision };
    this.sends.push(identity);
    const session = this.observations.get(id)!;
    session.status = 'running';
    if (kind !== 'execute') return { accepted: true };
    if (scope.revision === 2) {
      this.finish(identity);
      return { accepted: true };
    }
    if (this.sends.length === 1) {
      if (this.fault === 'stale-revision') return { accepted: true };
      if (this.fault !== 'precommit') this.ledger.write(1);
      if (this.fault === 'lost-ack') {
        session.status = 'idle';
        throw Error('Fixture lost transport acknowledgement after SQLite commit');
      }
      if (this.fault === 'process-restart') {
        this.finish(identity);
        writeFileSync(join(this.directory, 'native-receipt.json'), JSON.stringify(session.messages.at(-1)));
        this.ledger.db.close();
        process.exit(77);
      }
      session.status = 'error';
      session.error = this.fault === 'precommit' ? 'Tool rejected before SQLite commit' : 'HTTP 503 upstream failure after SQLite commit';
      return { accepted: true };
    }
    assert(prompt.includes('本动作是失败后有界接续'), 'Continuation must carry the controller instruction');
    const choice = live?.executor ?? (this.ledger.revisions().length === 0 ? 'write' : 'report');
    if (choice === 'hold') {
      this.emit('executor', identity, { outcome: 'blocked', summary: 'Executor chose to hold.',
        reason: 'The observed model withheld the action.', artifacts: [], tests: [] });
      return { accepted: true };
    }
    if (choice === 'write') this.ledger.write(scope.revision);
    this.finish(identity);
    return { accepted: true };
  }
}

async function start(loop: Loop) {
  return loop.start({ task, executorSessionId: 'executor', reviewerSessionId: 'reviewer', maxDurationMs: 120_000, maxRevisions: 0 });
}

if (mode === '--restart-child') {
  const ledger = new Ledger(folder);
  if (input === 'bri') {
    await start(new CollaborationLoop({ projectRoot: folder,
      port: new FixturePort(folder, ledger, 'process-restart'), now: () => 1000 }));
  } else {
    ledger.write(1);
    writeFileSync(join(folder, 'native-receipt.json'), JSON.stringify({ revision: 1, committed: true }));
    ledger.db.close();
    process.exit(77);
  }
  throw Error('Restart child did not reach the process-exit boundary');
}

async function runCase(directory: string, fault: Fault, strategy: Strategy) {
  mkdirSync(directory);
  let sends = 0;
  if (fault === 'process-restart') {
    const child = spawnSync(process.execPath, [script, '--restart-child', directory, strategy],
      { encoding: 'utf8', timeout: 10_000 });
    writeFileSync(join(directory, 'child.json'), JSON.stringify({
      exit: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, error: child.error?.message,
    }));
    assert.equal(child.status, 77, child.stderr);
    sends++;
  }
  const ledger = new Ledger(directory);
  const port = new FixturePort(directory, ledger, fault);
  let state = 'stopped';
  let successClaim = false;
  let staleRepliesDiscarded = 0;
  let virtualWaitMs = 0;
  let incorrectActorClaims = 0;
  try {
    if (strategy !== 'bri') {
      if (fault !== 'process-restart') {
        sends++;
        if (fault === 'lost-ack' || fault === '503-after-commit') ledger.write(1);
      }
      if (strategy === 'retry-once') {
        sends++;
        ledger.write(1);
        successClaim = true;
        state = 'reported-success';
      }
    } else {
      let time = 1000;
      const loop = new CollaborationLoop({ projectRoot: directory, port, now: () => time });
      if (fault === 'process-restart') {
        const first = loop.status()!.actions[0];
        assert.equal(first.status, 'unknown');
        assert(first.sendUncertain);
        port.observations.get('executor')!.messages.push(JSON.parse(readFileSync(join(directory, 'native-receipt.json'), 'utf8')));
      } else {
        await start(loop);
      }
      if (fault === 'stale-revision') {
        const old = port.sends[0];
        await loop.steer(replacement, { auditFirst: false });
        const session = port.observations.get('executor')!;
        const currentStatus = session.status;
        port.emit('executor', old, { summary: 'Stale success claim.', artifacts: ['result.json'], tests: ['Old claim.'] }, false);
        assert.equal(session.status, currentStatus);
      }
      for (let step = 0; step < 16; step++) {
        await loop.tick();
        const run = loop.status()!;
        if (['accepted', 'needs_attention', 'budget_exhausted', 'audited'].includes(run.state)) break;
        const next = run.failureRecovery?.nextRetryAt;
        if (next && time < next) {
          virtualWaitMs += next - time;
          time = next;
        }
        for (const id of ['executor', 'reviewer']) {
          if (port.observations.get(id)!.status !== 'running') continue;
          const action = run.actions.filter(row => row.sessionId === id).at(-1)!;
          const identity = { actionId: action.id, revision: action.revision, kind: action.kind };
          if (action.kind === 'sync') port.emit(id, identity, { summary: 'Respect revised task scope.' });
          if (action.kind === 'plan') port.emit(id, identity, {
            summary: 'Inspected the durable ledger.', audit: ['Read SQLite.'],
            recommendations: ['Preserve prior writes.'],
            steps: [live ? 'Observed planner choice: ' + live.planner : ledger.revisions().length
              ? 'Report the existing effect without repeating it.' : 'Apply one write after confirmed precommit failure.'],
            acceptanceCriteria: ['One authorized write and matching artifact.'], decision: live?.planner === 'hold' ? 'needs_input' : 'proceed',
          });
          if (action.kind === 'review') {
            const actual = ledger.revisions();
            const expected = fault === 'stale-revision' ? [] : [1];
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')), actual);
            const correct = JSON.stringify(actual) === JSON.stringify(expected);
            if (!correct) incorrectActorClaims++;
            if (!live) assert(correct, 'Fixture execution must match the current scope');
            port.emit(id, identity, { verdict: correct ? 'accept' : 'revise',
              feedback: correct ? 'Verified SQLite and the scoped artifact.' : 'Observed a wrong or duplicate effect.',
              checks: ['Compared the SQLite ledger to current authorization.'] });
          }
        }
      }
      const final = loop.status()!;
      state = final.state;
      successClaim = state === 'accepted';
      staleRepliesDiscarded = final.events.filter(event => event.type === 'stale_reply_discarded').length;
      sends += port.sends.length;
      if (fault === 'lost-ack') assert.equal(final.actions[0].status, 'unknown');
      if (fault === 'stale-revision') assert(staleRepliesDiscarded > 0);
    }
    const revisions = ledger.revisions();
    const expectedWrites = fault === 'stale-revision' ? 0 : 1;
    const stateCorrect = JSON.stringify(revisions) === JSON.stringify(expectedWrites ? [1] : []);
    const expectedByStrategy = strategy === 'bri' ? expectedWrites
      : strategy === 'retry-once' ? (fault === 'precommit' || fault === 'stale-revision' ? 1 : 2)
      : (fault === 'precommit' || fault === 'stale-revision' ? 0 : 1);
    if (strategy !== 'bri') assert.equal(revisions.length, expectedByStrategy);
    return { fault, strategy, state, writes: revisions.length, duplicateEffects: Math.max(0, revisions.length - 1),
      staleWrites: fault === 'stale-revision' ? revisions.length : 0,
      correctRecovery: stateCorrect && successClaim, falseSuccess: successClaim && !stateCorrect,
      safeHold: !successClaim && revisions.length <= expectedWrites, staleRepliesDiscarded, sends,
      inspections: port.inspections, interrupts: port.interrupts, revocations: port.revocations, virtualWaitMs,
      incorrectActorClaims, ...(live ? { observedModelChoices: live, modelRequestsDuringReplay: 0 } : { modelCalls: 0, tokens: 0 }) };
  } finally {
    ledger.db.close();
  }
}

const output = resolve((live ? folder : mode) ?? mkdtempSync(join(tmpdir(), 'bri-reliability-')));
if (mode) mkdirSync(output);
const rows = [];
for (const fault of live ? ['503-after-commit'] as const : faults) for (const strategy of live ? ['bri'] as const : strategies) {
  try {
    rows.push(await runCase(join(output, fault + '-' + strategy), fault, strategy));
  } catch (error) {
    rows.push({ fault, strategy, error: String(error) });
    process.exitCode = 1;
  }
  writeFileSync(join(output, 'results.json'), JSON.stringify(rows, null, 2) + '\n');
}
console.log(JSON.stringify(rows, null, 2));
console.error('Artifacts: ' + output);
