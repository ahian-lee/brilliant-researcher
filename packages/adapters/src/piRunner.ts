import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, noteChange } from '../../core/src/db.ts';
import { insertEvent, readOffset, saveOffset, setRunStatus, transact } from '../../core/src/repo.ts';
import { RUN_TRANSITIONS } from '../../core/src/types.ts';
import type { RunStatus } from '../../core/src/types.ts';
import { parseStdoutLine } from './piEvents.ts';
import { shellValue, scp, ssh } from './ssh.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH_SCRIPT = join(HERE, '..', '..', '..', 'runner', 'pi-launch.sh');

export interface HostConfig {
  /** 系统 OpenSSH 别名 */
  alias: string;
  /** 远端 run 目录根 */
  baseDir: string;
  /** Pi wrapper 绝对路径 */
  wrapper: string;
  /** Node 22+ 绝对路径（远端非登录 shell 里 node 不在 PATH） */
  nodeBin: string;
}

export interface LaunchSpec {
  runId: string;
  /** 远端工作目录 */
  cwd: string;
  brief: string;
  tools?: string;
  model?: string;
  /** 显式推理档位；不传则由 wrapper 沿用 Pi 自身设置，记录时如实留空 */
  thinking?: string;
  name?: string;
  timeoutMs?: number;
}

export interface RunSnapshot {
  runId: string;
  host: string;
  outPath: string;
  errPath: string;
  pid: number | null;
  status: RunStatus;
}

function runDirOf(cfg: HostConfig, runId: string): string {
  return `${cfg.baseDir}/${runId}`;
}

/** 上传执行包装；内容一致时跳过。 */
export async function ensureHostLayout(cfg: HostConfig): Promise<void> {
  const probe = await ssh(cfg.alias, `test -f ${cfg.baseDir}/pi-launch.sh && echo HAVE || echo MISS`, { timeoutMs: 30_000 });
  const want = readFileSync(LAUNCH_SCRIPT, 'utf8');
  const current = await ssh(cfg.alias, `cat ${cfg.baseDir}/pi-launch.sh 2>/dev/null`, { timeoutMs: 30_000 });
  if (probe.stdout.toString().includes('HAVE') && current.stdout.toString() === want) {
    await ssh(cfg.alias, `mkdir -p ${cfg.baseDir}`, { timeoutMs: 30_000 });
    return;
  }
  await ssh(cfg.alias, `mkdir -p ${cfg.baseDir}`, { timeoutMs: 30_000 });
  const put = await scp(cfg.alias, LAUNCH_SCRIPT, `${cfg.baseDir}/pi-launch.sh`);
  if (put.code !== 0) throw new Error(`上传 pi-launch.sh 失败：${put.stderr.trim()}`);
  const chmod = await ssh(cfg.alias, `chmod +x ${cfg.baseDir}/pi-launch.sh`, { timeoutMs: 30_000 });
  if (chmod.code !== 0) throw new Error(`chmod 失败：${chmod.stderr.trim()}`);
}

/**
 * 启动一次运行：prompt 与 run.conf 通过 stdin 落盘（内容不进命令串），
 * 再 setsid 派生独立会话，SSH 断开不影响执行身份。
 */
export async function startRun(
  db: DatabaseSync,
  cfg: HostConfig,
  spec: LaunchSpec,
): Promise<{ ok: boolean; pgid?: number; reconciled?: boolean; error?: string }> {
  const dir = runDirOf(cfg, spec.runId);
  const mkdir = await ssh(cfg.alias, `mkdir -p ${shellValue(dir)}`, { timeoutMs: 30_000 });
  if (mkdir.code !== 0) return { ok: false, error: `创建 run 目录失败：${mkdir.stderr.trim()}` };

  const prompt = await ssh(cfg.alias, `cat > ${dir}/prompt.txt`, { stdinData: spec.brief, timeoutMs: 30_000 });
  if (prompt.code !== 0) return { ok: false, error: `写入 prompt.txt 失败：${prompt.stderr.trim()}` };

  const conf = [
    `NODE_BIN=${shellValue(cfg.nodeBin)}`,
    `WRAPPER=${shellValue(cfg.wrapper)}`,
    `WORKDIR=${shellValue(spec.cwd)}`,
    `TIMEOUT_MS=${String(spec.timeoutMs ?? 1_800_000)}`,
    `PI_TOOLS=${shellValue(spec.tools ?? '')}`,
    `PI_MODEL=${shellValue(spec.model ?? '')}`,
    `PI_THINKING=${shellValue(spec.thinking ?? '')}`,
    `PI_NAME=${shellValue(spec.name ?? spec.runId)}`,
  ].join('\n');
  const confPut = await ssh(cfg.alias, `cat > ${dir}/run.conf`, { stdinData: `${conf}\n`, timeoutMs: 30_000 });
  if (confPut.code !== 0) return { ok: false, error: `写入 run.conf 失败：${confPut.stderr.trim()}` };

  // 后台任务的 $! 即 setsid 后的新组长，组长 pid == pgid。
  const launch = await ssh(
    cfg.alias,
    `setsid nohup bash ${cfg.baseDir}/pi-launch.sh ${dir} > ${dir}/launch.log 2>&1 < /dev/null & echo $!`,
    { timeoutMs: 45_000 },
  );
  let pgid = Number(launch.stdout.toString().trim());
  let reconciled = false;
  if (launch.code !== 0 || !Number.isInteger(pgid) || pgid <= 0) {
    // 应答丢失不等于没启动：先按远端自记的 pgid 核对，避免盲目重跑。
    const check = await ssh(cfg.alias, `cat ${dir}/pgid 2>/dev/null`, { timeoutMs: 25_000 });
    const found = Number(check.stdout.toString().trim());
    if (check.code !== 0 || !Number.isInteger(found) || found <= 0) {
      return { ok: false, error: `启动失败：${(launch.stderr || launch.stdout).toString().trim()}` };
    }
    pgid = found;
    reconciled = true;
  }
  await ssh(cfg.alias, `echo 'PGID=${pgid}' >> ${dir}/meta`, { timeoutMs: 30_000 });
  db.prepare('UPDATE run SET out_path=?, err_path=? WHERE id=?').run(`${dir}/out`, `${dir}/err`, spec.runId);

  setRunStatus(db, spec.runId, 'starting', {
    pid: pgid,
    exitReason: reconciled ? `pgid=${pgid} 启动应答丢失，按远端 pgid 核对` : `pgid=${pgid}`,
  });
  return { ok: true, pgid, reconciled };
}

type AliveState = 'alive' | 'dead' | 'unreachable';

/** 三态：只有成功执行的远端检查才能确认死亡；SSH 自身失败是「无法观测」。 */
async function aliveCheck(cfg: HostConfig, pgid: number): Promise<AliveState> {
  const res = await ssh(cfg.alias, `kill -0 -${pgid} 2>/dev/null && echo ALIVE || echo DEAD`, { timeoutMs: 25_000 });
  if (res.code !== 0) return 'unreachable';
  return res.stdout.toString().includes('ALIVE') ? 'alive' : 'dead';
}

/** 从已消费字节偏移续读 out 文件；未写完的尾行不提交偏移。 */
async function readNewBytes(cfg: HostConfig, outPath: string, fromByte: number): Promise<{ text: string; bytes: number } | null> {
  const res = await ssh(cfg.alias, `tail -c +${fromByte + 1} ${outPath} 2>/dev/null`, { timeoutMs: 60_000 });
  if (res.code !== 0) return null;
  const buf = res.stdout;
  if (buf.length === 0) return { text: '', bytes: 0 };
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return { text: '', bytes: 0 };
  const complete = buf.subarray(0, lastNewline + 1);
  return { text: complete.toString('utf8'), bytes: complete.length };
}

export interface PollOutcome {
  status: RunStatus;
  newEvents: number;
  detail: string;
}

/** 采集一次增量：入库事件、推进偏移、按 wrapper 终态判定进程状态。 */
export async function pollRun(db: DatabaseSync, cfg: HostConfig, snap: RunSnapshot): Promise<PollOutcome> {
  // 已终态的 run 不再采集：结果已入库且偏移已推进，此时进程必然已退出，
  // 若按存活探测下结论会把 succeeded 改写成 failed（非法迁移）并丢失已验收的结果。
  if (RUN_TRANSITIONS[snap.status].length === 0) return { status: snap.status, newEvents: 0, detail: 'already_settled' };

  // 派发是两步：先建 queued 行，再由 startRun 在整段 ssh 序列末尾写入 pid。
  // 此窗口内 pid 为空：既无进程可观测，也无证据可判结局；更不能消费 out 里的结果——
  // queued→succeeded 非法，而偏移一旦推进，成功结果就再也读不回来，随后必被误判为失败。
  if (!snap.pid) return { status: snap.status, newEvents: 0, detail: 'not_launched_yet' };

  const dir = runDirOf(cfg, snap.runId);
  const cursor = readOffset(db, snap.runId);
  let chunk = await readNewBytes(cfg, `${dir}/out`, cursor.byteOffset);
  if (chunk === null) {
    // out 读不到有两种原因：连不上，或者文件还没生成。前者不能推断进程结局。
    const reachable = await ssh(cfg.alias, 'echo PING', { timeoutMs: 20_000 });
    if (reachable.code !== 0) return markUnreachable(db, snap, 0, 'ssh_unreachable');
    chunk = { text: '', bytes: 0 };
  }

  let newEvents = 0;
  let detail = 'no_new_output';
  let terminal: RunStatus | null = null;
  let exitCode: number | null = null;
  let seq = cursor.lastSeq;

  if (chunk.text) {
    const lines = chunk.text.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      seq += 1;
      const parsed = parseStdoutLine(line);
      if (parsed.kind === 'result' && parsed.result) {
        // 终态判定用 success/settled：exitCode 在正常收尾时也是 1。
        terminal = parsed.result.success ? 'succeeded' : 'failed';
        exitCode = parsed.result.exitCode;
        detail = parsed.result.error ?? 'pi_result_received';
        if (parsed.result.text) {
          const stored = insertEvent(db, {
            runId: snap.runId,
            seq,
            kind: 'final_report',
            summary: parsed.result.text,
            logRef: `${dir}/out#${seq}`,
          });
          if (stored) newEvents += 1;
        }
        continue;
      }
      if (parsed.kind === 'noise') continue;
      if (!parsed.summary) continue;
      if (insertEvent(db, { runId: snap.runId, seq, kind: parsed.eventType, summary: parsed.summary, logRef: `${dir}/out#${seq}` })) {
        newEvents += 1;
        detail = parsed.eventType;
      }
    }
  }

  if (terminal) {
    // 先落终态、再推进偏移：状态写入若失败，结果不会被消费掉，下次采集可重读（事件按 (run_id,seq) 去重）。
    if (snap.status !== terminal) setRunStatus(db, snap.runId, terminal, { exitCode, exitReason: detail });
    if (chunk.text) saveOffset(db, snap.runId, cursor.byteOffset + chunk.bytes, seq, true);
    await collectStderr(db, cfg, snap, dir);
    return { status: terminal, newEvents, detail };
  }
  if (chunk.text) saveOffset(db, snap.runId, cursor.byteOffset + chunk.bytes, seq, false);

  const state: AliveState = await aliveCheck(cfg, snap.pid);
  if (state === 'unreachable') return markUnreachable(db, snap, newEvents, 'ssh_unreachable');
  if (state === 'alive') {
    // 从无法观测中恢复：先回到 running，再按 starting→running 正常收敛。
    if (snap.status === 'unknown') setRunStatus(db, snap.runId, 'running', { exitReason: 'recovered' });
    if (snap.status === 'starting') setRunStatus(db, snap.runId, 'running');
    // 长时间无输出不等于卡死（训练阶段天然安静），只报进程存活。
    return { status: 'running', newEvents, detail };
  }

  const meta = await ssh(cfg.alias, `cat ${dir}/meta ${dir}/launch.log 2>/dev/null | tail -5`, { timeoutMs: 25_000 });
  if (meta.code !== 0) return markUnreachable(db, snap, newEvents, 'ssh_unreachable_at_reconcile');
  await collectStderr(db, cfg, snap, dir);
  const reason = `process_exited_without_result: ${meta.stdout.toString().replace(/\s+/g, ' ').slice(0, 200)}`;
  if (snap.status !== 'failed') setRunStatus(db, snap.runId, 'failed', { exitReason: reason });
  return { status: 'failed', newEvents, detail: reason };
}

function markUnreachable(db: DatabaseSync, snap: RunSnapshot, newEvents: number, detail: string): PollOutcome {
  if (snap.status === 'unknown') return { status: 'unknown', newEvents, detail };
  if (!RUN_TRANSITIONS[snap.status].includes('unknown')) {
    return { status: snap.status, newEvents, detail: `${detail}_not_observable_yet` };
  }
  // 状态与提醒同事务写入。首次断线只是「持续核对」事项，不立刻唤醒主管；
  // 是否升级为需要主管处理，由队列按 unknown 持续时长判定。
  transact(db, () => {
    setRunStatus(db, snap.runId, 'unknown', { exitReason: detail });
    noteChange(db, 'run_unreachable', snap.runId, `运行 ${snap.runId} 暂时无法观测（${detail}），保持追踪不判结局`, true);
  });
  return { status: 'unknown', newEvents, detail };
}

/** 失败或收尾时把 stderr 尾部作为诊断事件入库（诊断走 stderr，不与 stdout 事件混流）。 */
async function collectStderr(db: DatabaseSync, cfg: HostConfig, snap: RunSnapshot, dir: string): Promise<void> {
  const res = await ssh(cfg.alias, `tail -20 ${dir}/err 2>/dev/null`, { timeoutMs: 25_000 });
  const text = res.stdout.toString().trim();
  if (!text) return;
  const cursor = readOffset(db, snap.runId);
  let seq = cursor.lastSeq;
  for (const line of text.split('\n')) {
    const clean = line.replace(/^\[pi stderr\] /, '').trim();
    if (!clean) continue;
    seq += 1;
    insertEvent(db, { runId: snap.runId, seq, kind: 'stderr', summary: clean.slice(0, 500), logRef: `${dir}/err` });
  }
  saveOffset(db, snap.runId, cursor.byteOffset, seq, cursor.settled);
}

/** 排空取消窗口内迟到的输出；若终态结果到达，优先按结果收尾。 */
async function drainLateOutput(
  db: DatabaseSync,
  cfg: HostConfig,
  snap: RunSnapshot,
): Promise<{ terminal: RunStatus | null; exitCode: number | null }> {
  const cursor = readOffset(db, snap.runId);
  const chunk = await readNewBytes(cfg, `${runDirOf(cfg, snap.runId)}/out`, cursor.byteOffset);
  if (!chunk?.text) return { terminal: null, exitCode: null };
  let seq = cursor.lastSeq;
  let terminal: RunStatus | null = null;
  let exitCode: number | null = null;
  for (const line of chunk.text.split('\n').filter(Boolean)) {
    seq += 1;
    const parsed = parseStdoutLine(line);
    if (parsed.kind === 'result' && parsed.result) {
      terminal = parsed.result.success ? 'succeeded' : 'failed';
      exitCode = parsed.result.exitCode;
      if (parsed.result.text) {
        insertEvent(db, { runId: snap.runId, seq, kind: 'final_report', summary: parsed.result.text });
      }
      continue;
    }
    if (parsed.kind === 'event' && parsed.summary) {
      insertEvent(db, { runId: snap.runId, seq, kind: parsed.eventType, summary: parsed.summary });
    }
  }
  saveOffset(db, snap.runId, cursor.byteOffset + chunk.bytes, seq, terminal !== null);
  return { terminal, exitCode };
}

/**
 * 取消：作用域限定为本 run 的进程组；验证退出后才标记 canceled。
 * 后端不支持崩溃后透明续跑，因此只承诺「不重复启动 + 可验证终止」。
 */
export async function cancelRun(db: DatabaseSync, cfg: HostConfig, snap: RunSnapshot): Promise<{ ok: boolean; detail: string }> {
  if (!snap.pid) return { ok: false, detail: 'no_pgid_recorded' };
  await ssh(cfg.alias, `kill -TERM -${snap.pid} 2>/dev/null; true`, { timeoutMs: 25_000 });
  await new Promise((r) => setTimeout(r, 3000));

  let late = await drainLateOutput(db, cfg, snap);
  if (late.terminal) {
    if (snap.status !== late.terminal) setRunStatus(db, snap.runId, late.terminal, { exitCode: late.exitCode, exitReason: 'result_arrived_during_cancel' });
    return { ok: true, detail: `取消信号发出前结果已到达，按 ${late.terminal} 收尾` };
  }

  let state = await aliveCheck(cfg, snap.pid);
  if (state === 'alive') {
    await ssh(cfg.alias, `kill -KILL -${snap.pid} 2>/dev/null; true`, { timeoutMs: 25_000 });
    await new Promise((r) => setTimeout(r, 1500));
    state = await aliveCheck(cfg, snap.pid);
    late = await drainLateOutput(db, cfg, snap);
  }
  if (late.terminal) {
    if (snap.status !== late.terminal) setRunStatus(db, snap.runId, late.terminal, { exitCode: late.exitCode, exitReason: 'result_arrived_during_cancel' });
    return { ok: true, detail: `结果在终止过程中到达，按 ${late.terminal} 收尾` };
  }
  if (state !== 'dead') {
    return { ok: false, detail: state === 'unreachable' ? '无法观测该进程组，未确认取消' : `进程组 ${snap.pid} 仍在运行，未标记为已取消` };
  }

  if (RUN_TRANSITIONS[snap.status].includes('canceled')) {
    setRunStatus(db, snap.runId, 'canceled', { exitReason: 'canceled_by_supervisor' });
  }
  noteChange(db, 'run', snap.runId, `运行 ${snap.runId} 已取消并验证进程组退出`, false);
  return { ok: true, detail: 'canceled_verified' };
}

/** 运行期间通过 ctl 管道发送 RPC 控制命令。 */
export async function sendControl(cfg: HostConfig, runId: string, command: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const dir = runDirOf(cfg, runId);
  const json = JSON.stringify(command);
  const res = await ssh(cfg.alias, `test -p ${dir}/ctl && timeout 5 printf '%s\\n' ${shellValue(json)} >> ${dir}/ctl && echo SENT || echo NO_FIFO`, {
    timeoutMs: 25_000,
  });
  const ok = res.stdout.toString().includes('SENT');
  return { ok, detail: ok ? 'sent' : '该运行已无控制管道（wrapper 收尾后管道已删除），不支持会话恢复' };
}
