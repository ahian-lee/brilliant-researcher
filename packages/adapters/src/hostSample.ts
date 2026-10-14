import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../../core/src/db.ts';
import { ssh } from './ssh.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_SCRIPT = join(HERE, '..', '..', '..', 'runner', 'host-sample.sh');

export interface SampleTarget {
  alias: string;
  baseDir: string;
}

/** 上传采集脚本（内容变化时覆盖），之后每次只执行一条远端命令。 */
export async function ensureSampleScript(target: SampleTarget): Promise<void> {
  if (!existsSync(SAMPLE_SCRIPT)) throw new Error(`缺少 ${SAMPLE_SCRIPT}`);
  const want = readFileSync(SAMPLE_SCRIPT, 'utf8');
  const current = await ssh(target.alias, `cat ${target.baseDir}/host-sample.sh 2>/dev/null`, { timeoutMs: 30_000 });
  if (current.stdout.toString() === want) return;
  const put = await ssh(target.alias, `mkdir -p ${target.baseDir} && cat > ${target.baseDir}/host-sample.sh`, {
    stdinData: want,
    timeoutMs: 30_000,
  });
  if (put.code !== 0) throw new Error(`上传 host-sample.sh 失败：${put.stderr.trim()}`);
}

export interface SampleRow {
  host: string;
  sampled_at: string;
  reachable: number;
  cpu_pct: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  gpu_util: number | null;
  gpu_mem_used: number | null;
  gpu_mem_total: number | null;
  running_tasks: string;
  raw: string;
}

/** 采集失败也登记一行：失联时页面显示最后观测值 + 失联状态，而不是继续亮绿灯。 */
export async function sampleHost(target: SampleTarget): Promise<SampleRow> {
  const res = await ssh(target.alias, `bash ${target.baseDir}/host-sample.sh`, { timeoutMs: 45_000 });
  if (res.code !== 0) {
    return {
      host: target.alias,
      sampled_at: nowIso(),
      reachable: 0,
      cpu_pct: null,
      mem_used: null,
      mem_total: null,
      disk_used: null,
      disk_total: null,
      gpu_util: null,
      gpu_mem_used: null,
      gpu_mem_total: null,
      running_tasks: 'unreachable',
      raw: res.stderr.trim().slice(0, 500),
    };
  }
  const text = res.stdout.toString();
  const kv = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    kv.set(key, [...(kv.get(key) ?? []), value]);
  }
  const num = (key: string): number | null => {
    const raw = (kv.get(key) ?? [])[0];
    if (raw === undefined || raw.trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  // 多卡：利用率取最大值，显存求和；细节保留在 raw 里供展开查看。
  const gpus = (kv.get('GPU') ?? []).map((g) => g.split(',').map(Number));
  const gpuUtil = gpus.length ? Math.max(...gpus.map((g) => g[1] ?? 0)) : null;
  const gpuUsed = gpus.length ? gpus.reduce((s, g) => s + (g[2] ?? 0), 0) : null;
  const gpuTotal = gpus.length ? gpus.reduce((s, g) => s + (g[3] ?? 0), 0) : null;

  return {
    host: target.alias,
    sampled_at: (kv.get('TS') ?? [nowIso()])[0],
    reachable: 1,
    cpu_pct: num('CPU'),
    mem_used: num('MEM_USED_MB'),
    mem_total: num('MEM_TOTAL_MB'),
    disk_used: num('DISK_USED_GB'),
    disk_total: num('DISK_TOTAL_GB'),
    gpu_util: gpuUtil,
    gpu_mem_used: gpuUsed,
    gpu_mem_total: gpuTotal,
    running_tasks: (kv.get('RUNNING') ?? ['0'])[0],
    raw: text.trim().slice(0, 2000),
  };
}

export function storeSample(db: DatabaseSync, row: SampleRow): void {
  db.prepare(
    'INSERT OR REPLACE INTO host_sample (host, sampled_at, reachable, cpu_pct, mem_used, mem_total, disk_used, disk_total, gpu_util, gpu_mem_used, gpu_mem_total, running_tasks, raw) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    row.host, row.sampled_at, row.reachable, row.cpu_pct, row.mem_used, row.mem_total, row.disk_used,
    row.disk_total, row.gpu_util, row.gpu_mem_used, row.gpu_mem_total, row.running_tasks, row.raw,
  );
}
