import { readFileSync } from 'node:fs';
import type { SshOptions, SshResult, Transport } from '../packages/adapters/src/ssh.ts';

/**
 * 内存远端替身：只实现 piRunner 实际发出的那几条命令，用来复现
 * 「启动应答丢失、网络中断、写入失败、退出信息迟到」等在真实主机上难以稳定构造的场景。
 *
 * 约定：测试里写进 out 文件的内容保持 ASCII，因为采集层按**字节**偏移续读。
 */
export class FakeRemote {
  files = new Map<string, string>();
  procs = new Map<number, boolean>();
  ctlMessages: string[] = [];
  calls: string[] = [];
  sshDown = false;
  /** 命中这些子串的写操作返回失败。 */
  failWrites = new Set<string>();
  /** 下一次启动：远端真的起来了，但应答丢失。 */
  loseLaunchResponse = false;
  private nextPid = 100_000;

  transport(): Transport {
    return async (command: string, args: string[], options: SshOptions): Promise<SshResult> =>
      this.handle(command, args, options);
  }

  /** 模拟远端进程向 out 追加输出。 */
  appendOut(dir: string, lines: string[]): string {
    const text = lines.map((l) => `${l}\n`).join('');
    this.files.set(`${dir}/out`, (this.files.get(`${dir}/out`) ?? '') + text);
    return text;
  }

  outPath(dir: string): string {
    return this.files.get(`${dir}/out`) ?? '';
  }

  private ok(stdout: string): SshResult {
    return { code: 0, stdout: Buffer.from(stdout, 'utf8'), stderr: '' };
  }

  private fail(stderr: string): SshResult {
    return { code: 1, stdout: Buffer.alloc(0), stderr };
  }

  private handle(command: string, args: string[], options: SshOptions): SshResult {
    if (command === 'scp') {
      const local = args[args.length - 2];
      const remote = args[args.length - 1].split(':').slice(1).join(':');
      this.files.set(remote, readFileSync(local, 'utf8'));
      return this.ok('');
    }
    const cmd = args[args.length - 1];
    this.calls.push(cmd);
    if (this.sshDown) {
      return { code: 255, stdout: Buffer.alloc(0), stderr: 'ssh: connect to host port 22: Connection timed out' };
    }

    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^test -f (\S+) && echo HAVE/))) return this.ok(this.files.has(m[1]) ? 'HAVE\n' : 'MISS\n');
    if ((m = cmd.match(/^mkdir -p (\S+)$/))) {
      if (this.failWrites.has(m[1]) || this.failWrites.has('mkdir')) return this.fail('mkdir: cannot create directory: No space left on device');
      this.files.set(`${m[1]}/.dir`, '');
      return this.ok('');
    }
    if ((m = cmd.match(/^cat > (\S+)$/))) {
      if (this.failWrites.has(m[1]) || this.failWrites.has('write')) return this.fail('write failed: disk full');
      this.files.set(m[1], options.stdinData ?? '');
      return this.ok('');
    }
    if ((m = cmd.match(/^cat (\S+) 2>\/dev\/null$/))) {
      const v = this.files.get(m[1]);
      return v === undefined ? this.fail('No such file') : this.ok(v);
    }
    if ((m = cmd.match(/^echo 'PGID=(\d+)' >> (\S+)$/))) {
      this.files.set(`${m[2]}/meta`, `PGID=${m[1]}\n`);
      return this.ok('');
    }
    if ((m = cmd.match(/^tail -c \+(\d+) (\S+) 2>\/dev\/null$/))) {
      const text = this.files.get(m[2]) ?? '';
      return this.ok(text.slice(Math.max(0, Number(m[1]) - 1)));
    }
    if ((m = cmd.match(/^tail -(\d+) (\S+) 2>\/dev\/null$/))) {
      const lines = (this.files.get(m[2]) ?? '').split('\n');
      return this.ok(lines.slice(-Number(m[1])).join('\n'));
    }
    if ((m = cmd.match(/^cat (\S+) (\S+) 2>\/dev\/null \| tail -5$/))) {
      return this.ok(`${this.files.get(m[1]) ?? ''}${this.files.get(m[2]) ?? ''}`);
    }
    if ((m = cmd.match(/^kill -0 -(\d+)/))) {
      return this.ok(this.procs.get(Number(m[1])) ? 'ALIVE\n' : 'DEAD\n');
    }
    if ((m = cmd.match(/^kill -(?:TERM|KILL) -(\d+)/))) {
      this.procs.set(Number(m[1]), false);
      return this.ok('');
    }
    if ((m = cmd.match(/^test -p (\S+) && timeout 5 printf '%s\\n' '(.*)' >> \S+ && echo SENT/))) {
      this.ctlMessages.push(m[2]);
      return this.ok('SENT\n');
    }
    if ((m = cmd.match(/^setsid nohup bash (\S+)\/pi-launch\.sh (\S+) .* & echo \$!$/))) {
      const dir = m[2];
      const pgid = this.nextPid++;
      this.procs.set(pgid, true);
      this.files.set(`${dir}/pgid`, `${pgid}\n`);
      this.files.set(`${dir}/out`, '');
      this.files.set(`${dir}/err`, '');
      if (this.loseLaunchResponse) {
        this.loseLaunchResponse = false;
        return { code: 255, stdout: Buffer.alloc(0), stderr: 'Connection to host closed by remote host.' };
      }
      return this.ok(`${pgid}\n`);
    }
    if (cmd === 'echo PING') return this.ok('PING\n');
    if (cmd.startsWith('chmod +x')) return this.ok('');
    if (cmd.startsWith('cat ') && cmd.includes('/host-sample.sh')) return this.ok('');
    return this.fail(`FakeRemote: 未实现的命令 ${cmd}`);
  }
}
