import { spawn } from 'node:child_process';

/**
 * 只用系统 OpenSSH 与参数数组，不经过本机 shell 拼接。
 * 远端命令串由我们自己按已校验的路径组装。
 */

export interface SshResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface SshOptions {
  timeoutMs?: number;
  stdinData?: string;
}

export type Transport = (command: string, args: string[], options: SshOptions) => Promise<SshResult>;

export function ssh(host: string, remoteCommand: string, options: SshOptions = {}): Promise<SshResult> {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', host, remoteCommand];
  return transport('ssh', args, options);
}

export function scp(host: string, localPath: string, remotePath: string): Promise<SshResult> {
  return transport('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', localPath, `${host}:${remotePath}`], {});
}

/** 测试注入远端替身；生产路径仍走系统 OpenSSH。 */
export function setTransport(next: Transport | null): void {
  transport = next ?? spawnTransport;
}

function spawnTransport(command: string, args: string[], options: SshOptions): Promise<SshResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(chunks), stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\nlocal timeout after ${options.timeoutMs ?? 0} ms`;
      finish(124);
    }, options.timeoutMs ?? 120_000);
    timer.unref();

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (error) => {
      stderr += error.message;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
    if (options.stdinData !== undefined) {
      child.stdin.end(options.stdinData);
    } else {
      child.stdin.end();
    }
  });
}

let transport: Transport = spawnTransport;

/** 生成 POSIX shell 单引号安全字面量。用于 run.conf，不用于 prompt 内容。 */
export function shellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
