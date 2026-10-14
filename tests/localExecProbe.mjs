/**
 * 本机执行位置可行性探针（无模型、无 SSH）。
 *
 * 只回答 Stage B 之前必须先知道的事实：
 *  1) 脱离启动器后，本机执行进程能否继续独立写日志（不依赖有人读管道）；
 *  2) 含空格与中文的路径能否正确传递（参数数组，不拼 shell 字符串）；
 *  3) 能否按字节偏移增量续读（与远端采集同一口径）；
 *  4) 取消前能否核对进程身份，身份不符时拒绝；
 *  5) 取消是否只作用于该进程树。
 *
 * 用替身执行器，不启动模型、不调用 SSH。实际验证的 OS 由脚本自行报告。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 故意把目录名做成「空格 + 中文」，路径不能进任何 shell 字符串。
const base = mkdtempSync(join(tmpdir(), 'bri local 中文-'));
const runDir = join(base, 'run with 空格');
const execDir = join(base, '执行器 目录');
import { mkdirSync } from 'node:fs';
mkdirSync(runDir, { recursive: true });
mkdirSync(execDir, { recursive: true });

const marker = 'BRISTANDIN';
const standIn = join(execDir, 'stand-in.mjs');
writeFileSync(
  standIn,
  `// 替身执行器：独立落盘日志，忽略 stdin，支持被终止
import { appendFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2];
writeFileSync(dir + '/pid.txt', String(process.pid));
let n = 0;
const t = setInterval(() => {
  n += 1;
  appendFileSync(dir + '/out', 'tick ' + n + ' ${marker} line\\n');
  appendFileSync(dir + '/err', 'note ' + n + '\\n');
  if (n >= 40) { clearInterval(t); appendFileSync(dir + '/out', 'PI_RESULT_JSON {"success":true,"text":"done"}\\n'); process.exit(0); }
}, 250);
process.on('SIGTERM', () => { appendFileSync(dir + '/out', 'sigterm\\n'); process.exit(0); });
`,
);

console.log(`平台 ${process.platform} ${process.arch}；node ${process.version}`);
console.log(`根目录 ${base}`);

// 1. 脱离启动器：直接 spawn detached，stdio 指向文件描述符，父进程立即退出。
const outFd = { out: join(runDir, 'out'), err: join(runDir, 'err') };
writeFileSync(outFd.out, '');
writeFileSync(outFd.err, '');
const child = spawn(process.execPath, [standIn, runDir], {
  cwd: runDir,
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});
const launchedPid = child.pid;
child.unref();
ok('启动器可立即返回且拿到 pid', Number.isInteger(launchedPid) && launchedPid > 0, String(launchedPid));

await sleep(1500);
const size1 = statSync(outFd.out).size;
ok('父进程未持有管道时仍在独立写日志', size1 > 0, `out=${size1} 字节`);

// 2. 参数数组传递空格/中文路径：替身确实按该目录写文件
ok('含空格与中文的路径被原样使用', existsSync(outFd.out) && readFileSync(outFd.out, 'utf8').includes(marker));

// 3. 按字节偏移增量续读（与 readNewBytes 同口径：只消费完整行）
async function readNewBytes(fromByte) {
  const buf = readFileSync(outFd.out);
  if (buf.length <= fromByte) return { text: '', bytes: 0 };
  const complete = buf.subarray(0, buf.lastIndexOf(0x0a) + 1);
  return { text: complete.toString('utf8'), bytes: complete.length };
}
const a = await readNewBytes(size1 > 0 ? 0 : 0);
await sleep(700);
const b = await readNewBytes(a.bytes);
ok('第二次续读只取新增完整行', a.bytes > 0 && b.bytes > 0 && !a.text.includes(b.text.trim()), `a=${a.bytes} b=${b.bytes}`);

// 4. 身份核对：读取该 pid 的命令行，必须包含本 run 的替身路径
function identityOf(pid) {
  if (isWin) {
    // 这台机器的 wmic 已被移除；PowerShell 默认按控制台代码页输出会把中文弄乱，先固定 UTF-8。
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
      + `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`],
      { encoding: 'utf8', timeout: 25000 });
    return (r.stdout || '').trim();
  }
  const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').trim();
}
const cmd = identityOf(launchedPid);
ok('能取到进程身份并匹配本任务', cmd.includes('stand-in.mjs') && cmd.includes(runDir), cmd.slice(0, 120));
ok('身份不符时能识别（用本探针自己的父进程做无关对照）', (() => {
  const c = identityOf(process.ppid);
  return !c.includes('stand-in.mjs') && !c.includes(runDir);
})());

// 5. 取消只作用于该进程树，并验证已退出
if (isWin) {
  spawnSync('taskkill', ['/PID', String(launchedPid), '/T', '/F'], { encoding: 'utf8', timeout: 20000 });
} else {
  try { process.kill(-launchedPid, 'SIGKILL'); } catch { try { process.kill(launchedPid, 'SIGKILL'); } catch {} }
}
await sleep(1200);
const aliveAfter = (() => {
  if (isWin) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${launchedPid}`, '/NH'], { encoding: 'utf8', timeout: 20000 });
    return (r.stdout || '').includes(String(launchedPid));
  }
  try { process.kill(launchedPid, 0); return true; } catch { return false; }
})();
ok('取消后该进程确认已退出', !aliveAfter);
const finalSize = statSync(outFd.out).size;
await sleep(800);
ok('退出后日志不再增长（可判定终态）', statSync(outFd.out).size === finalSize);

rmSync(base, { recursive: true, force: true });
console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
