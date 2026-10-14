import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { readAgentSessions } from '../packages/adapters/src/agentSessions.ts';

type ZstdApi = {
  zstdCompressSync?: (input: string | Uint8Array) => Uint8Array;
};

const temporaryRoot = mkdtempSync(join(tmpdir(), 'bri-agent-sessions-'));

function exportFile(root: string, data: unknown): string {
  const file = join(root, '.bri', 'agent-sessions.json');
  mkdirSync(join(root, '.bri'), { recursive: true });
  writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

function dshSessionFile(home: string, rootKey: string, id: string, records: unknown[]): string {
  const directory = join(home, 'sessions', rootKey, id);
  mkdirSync(directory, { recursive: true });
  const compress = (zlib as unknown as ZstdApi).zstdCompressSync;
  assert.equal(typeof compress, 'function');
  const bytes = records.map((record) => compress!(JSON.stringify(record) + '\n'));
  const file = join(directory, 'session.v4.jsonl.zstd');
  writeFileSync(file, Buffer.concat(bytes.map((value) => Buffer.from(value))));
  return file;
}

try {
  const unconfigured = readAgentSessions({ id: 'project-a', root: temporaryRoot });
  assert.deepEqual(unconfigured.sessions, []);
  assert.equal(unconfigured.source.status, 'not-configured');

  const exportRoot = join(temporaryRoot, 'export-project');
  mkdirSync(exportRoot, { recursive: true });
  const generatedAt = new Date().toISOString();
  exportFile(exportRoot, {
    version: 1,
    project_id: 'export-project',
    root: exportRoot,
    generated_at: generatedAt,
    sessions: [
      {
        id: 'session-fresh',
        agent: 'DSH',
        title: 'Fresh project session',
        status: 'running',
        activity: '正在检查项目文件',
        updated_at: generatedAt,
        cwd: exportRoot,
      },
      {
        id: 'session-other-project',
        agent: 'DSH',
        title: 'Must stay private',
        status: 'running',
        activity: 'other project activity',
        updated_at: generatedAt,
        cwd: join(temporaryRoot, 'another-project'),
      },
      {
        id: 'session-waiting',
        agent: 'Codex',
        title: 'Needs a decision',
        status: 'waiting_input',
        activity: 'awaiting user input',
        updated_at: generatedAt,
        root: exportRoot,
        url: 'javascript:alert(1)',
      },
      {
        id: 'session-complete',
        agent: 'Pi',
        title: 'Finished',
        status: 'succeeded',
        activity: 'complete',
        updated_at: generatedAt,
        root: exportRoot,
        url: 'codex://threads/thread_123?view=review',
      },
    ],
  });
  const exported = readAgentSessions({
    id: 'export-project',
    root: exportRoot,
    session_source: { kind: 'project-export' },
  });
  assert.equal(exported.source.status, 'ready');
  assert.equal(exported.sessions.length, 3, 'rows from another project must not cross the registration boundary');
  assert.equal(exported.sessions[0]?.status, 'running');
  assert.equal(exported.source.excluded_count, 1);
  const waiting = exported.sessions.find((session) => session.id === 'session-waiting');
  const completed = exported.sessions.find((session) => session.id === 'session-complete');
  assert.equal(waiting?.status, 'waiting');
  assert.equal(waiting?.url, undefined, 'unsafe protocols must be omitted');
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.url, 'codex://threads/thread_123?view=review');

  const oldRoot = join(temporaryRoot, 'old-export-project');
  mkdirSync(oldRoot, { recursive: true });
  exportFile(oldRoot, {
    version: 1,
    root: oldRoot,
    generated_at: '2000-01-01T00:00:00.000Z',
    sessions: [{
      id: 'old-running',
      title: 'Old snapshot',
      status: 'running',
      activity: 'last recorded activity',
      updated_at: '2000-01-01T00:00:00.000Z',
      root: oldRoot,
    }],
  });
  const stale = readAgentSessions({
    id: 'old-export-project',
    root: oldRoot,
    session_source: { kind: 'project-export' },
  });
  assert.equal(stale.sessions[0]?.status, 'stale', 'a persisted old running value must not be presented as online');

  const escape = readAgentSessions({
    id: 'export-project',
    root: exportRoot,
    session_source: { kind: 'project-export', path: '../outside.json' },
  });
  assert.equal(escape.source.status, 'error');
  assert.match(escape.error ?? '', /位于 registration\.root 之内/);

  const zstd = zlib as unknown as ZstdApi;
  if (typeof zstd.zstdCompressSync === 'function') {
    const dshHome = join(temporaryRoot, 'dsh-home');
    const dshSessions = join(dshHome, 'sessions');
    mkdirSync(dshSessions, { recursive: true });
    const projectDirKey = '--D-example-workspace--';
    dshSessionFile(dshHome, projectDirKey, 'session-good', [
      {
        type: 'session', version: 4, id: 'session-good', createdAt: 1_800_000_000_000,
        cwd: 'D:\\example-workspace', isSeeded: false, delegationDepth: 0, agentPreset: 'coding',
      },
      { type: 'session/title', seq: 1, time: 1_800_000_000_100, data: { title: 'Synthetic DSH session' } },
      { type: 'turn/start', seq: 2, time: 1_800_000_000_200, data: { turn: 1 } },
      { type: 'tool/call', seq: 3, time: 1_800_000_000_300, data: { toolName: 'read_file' } },
      { type: 'turn/end', seq: 4, time: 1_800_000_000_400, data: { turn: 1 } },
    ]);
    dshSessionFile(dshHome, projectDirKey, 'session-open-turn', [
      {
        type: 'session', version: 4, id: 'session-open-turn', createdAt: 1_800_000_000_000,
        cwd: '/mnt/d/example-workspace', isSeeded: false, delegationDepth: 0,
      },
      { type: 'user/message', seq: 1, time: 1_800_000_000_100, data: { content: [] } },
      { type: 'turn/start', seq: 2, time: 1_800_000_000_200, data: { turn: 1 } },
    ]);
    dshSessionFile(dshHome, projectDirKey, 'session-assistant', [
      {
        type: 'session', version: 4, id: 'session-assistant', createdAt: 1_800_000_000_000,
        cwd: 'D:\\example-workspace', isSeeded: false, delegationDepth: 0,
      },
      {
        type: 'assistant/message', seq: 1, time: 1_800_000_000_500,
        data: {
          message: { content: [{ type: 'text', text: 'Visible summary only' }] },
          stream: [{ type: 'reasoning', text: 'private thought must not be used' }],
        },
      },
    ]);
    dshSessionFile(dshHome, projectDirKey, 'session-other-root', [
      {
        type: 'session', version: 4, id: 'session-other-root', createdAt: 1_800_000_000_000,
        cwd: 'D:\\other-project', isSeeded: false, delegationDepth: 0,
      },
      { type: 'turn/start', seq: 1, time: 1_800_000_000_100, data: { turn: 1 } },
    ]);

    const dsh = readAgentSessions({
      id: 'briresearcher',
      root: 'D:\\example-workspace\\',
      executor: 'DSH',
      session_source: { kind: 'dsh-local', home: dshHome },
    });
    assert.equal(dsh.source.status, 'ready');
    assert.equal(dsh.sessions.length, 3, 'only exact DSH cwd matches may be returned');
    const idle = dsh.sessions.find((session) => session.id === 'session-good');
    const unknown = dsh.sessions.find((session) => session.id === 'session-open-turn');
    const assistant = dsh.sessions.find((session) => session.id === 'session-assistant');
    assert.equal(idle?.title, 'Synthetic DSH session');
    assert.equal(idle?.activity, '最近调用工具：read_file');
    assert.equal(idle?.status, 'idle');
    assert.equal(unknown?.status, 'unknown', 'an open durable turn is not proof the live Agent is running');
    assert.equal(assistant?.activity, '助手：Visible summary only');
    assert.equal(assistant?.activity.includes('private thought'), false);
    assert.equal(dsh.sessions.some((session) => session.id === 'session-other-root'), false);
  }
  console.log('agentSessions tests passed');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
