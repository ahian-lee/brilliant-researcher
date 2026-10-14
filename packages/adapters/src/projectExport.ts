import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';

export interface ProjectExportLimits { maxFileBytes: number; maxTotalBytes: number; maxFiles: number }
export interface ProjectExport {
  bytes: Buffer; filename: string; fileCount: number; totalBytes: number;
  excludedCount: number; exportedAt: string;
}
export class ProjectExportError extends Error {
  code: 'LIMIT_EXCEEDED' | 'UNSAFE_PATH' | 'READ_FAILED' | 'INVALID_INPUT';
  constructor(code: ProjectExportError['code'], message: string) {
    super(message); this.name = 'ProjectExportError'; this.code = code;
  }
}
const MAX: ProjectExportLimits = { maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxFiles: 10000 };
const compress = promisify(deflateRaw);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'bower_components', 'vendor', '__pycache__', 'venv', 'env', 'cache', 'caches', 'tmp', 'temp', 'coverage', 'sessions', 'session', 'conversations', 'transcripts', 'credentials', 'secrets', 'checkpoints']);
const EXTENSIONS = new Set(('.md .mdx .txt .rst .adoc .pdf .doc .docx .odt .rtf .tex .bib .ppt .pptx .odp ' +
  '.png .jpg .jpeg .gif .webp .svg .eps .ps .tif .tiff .bmp .ico ' +
  '.json .jsonl .csv .tsv .xlsx .xls .ods .xml .yaml .yml .toml .ini .cfg .ipynb ' +
  '.npy .npz .parquet .arrow .feather .h5 .hdf5 .hdf .mat .nc .dat .cif .pdb .xyz .mol .sdf .smi .fasta .fa .fastq .fits ' +
  '.py .r .rmd .qmd .jl .js .mjs .cjs .jsx .ts .tsx .html .htm .css .scss .less .vue .svelte ' +
  '.c .cc .cpp .cxx .h .hpp .rs .go .java .kt .swift .m .f .f90 .sql .sh .bash .ps1 .bat .cmd .lua .pl .rb .ipynb').split(/\s+/));
const NAMED_FILES = new Set(['readme', 'license', 'licence', 'copying', 'makefile', 'dockerfile', 'cmakelists.txt', 'requirements.txt']);

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function excluded(name: string, directory: boolean, parent: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') && !(parent === '' && lower === '.aris' && directory)) return true;
  if (parent === '.aris' && lower === 'tools') return true;
  if (directory && EXCLUDED_DIRECTORIES.has(lower)) return true;
  // Exclude agent configuration and raw conversation files even outside hidden folders.
  if (/^(?:agents|claude|gemini)\.md$/i.test(name)) return true;
  if (/^pi(?:-.*)?-events\.jsonl$/i.test(name)) return true;
  if (/(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?|api[._-]?keys?|auth|sessions?|conversations?|transcripts?|chat[._-]?logs?|history)(?:[._-]|$)/i.test(name)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(name) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)) return true;
  if (/^(?:config|settings)(?:[._-].*)?\.(?:toml|ini|cfg|json|yaml|yml)$/i.test(name) || /^(?:service[._-]?account|kubeconfig)(?:\.|$)/i.test(name)) return true;
  return false;
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function fail(message: string): never { throw new ProjectExportError('LIMIT_EXCEEDED', message); }
function portable(path: string): string { return path.split(sep).join('/'); }

// ZIP requires CRC-32 for interoperability; no additional integrity manifests are generated.
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
interface ZipEntry { name: string; bytes: Buffer; modified: Date }
async function zip(entries: ZipEntry[]): Promise<Buffer> {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0; let centralSize = 0;
  if (entries.length > 65535) fail('ZIP 文件数超过 65535；不支持 ZIP64。');
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 65535) fail(`ZIP 路径过长：${entry.name}`);
    const packed = await compress(entry.bytes); const crc = crc32(entry.bytes);
    const date = entry.modified; const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28); directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, packed); central.push(directory, name);
    offset += header.length + name.length + packed.length; centralSize += directory.length + name.length;
    if (offset + centralSize + 22 >= 0xffffffff) fail('ZIP 大小超过 4 GiB；不支持 ZIP64。');
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Only call with a trusted, registered project; callers must never accept a root from a download request. */
export async function exportProjectResults(project: { id: string; root: string; name: string; goal?: string }, options: { now?: Date; limits?: Partial<ProjectExportLimits> } = {}): Promise<ProjectExport> {
  const now = options.now ?? new Date();
  if (!project.id || !project.root || !project.name || !Number.isFinite(now.getTime())) throw new ProjectExportError('INVALID_INPUT', '项目信息或导出时间无效。');
  const limits = { ...MAX, ...options.limits };
  for (const key of Object.keys(MAX) as Array<keyof ProjectExportLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > MAX[key]) throw new ProjectExportError('INVALID_INPUT', `导出限额 ${key} 无效。`);
  }
  const exportedAt = now.toISOString(); const entries: ZipEntry[] = [];
  const observed: Array<{ path: string; stat: Stats }> = []; let totalBytes = 0; let excludedCount = 0; let scanned = 0;
  try {
    const root = await realpath(resolve(project.root));
    if (!(await lstat(root)).isDirectory()) throw new ProjectExportError('INVALID_INPUT', '项目目录不存在。');
    const pending = [''];
    while (pending.length) {
      const parent = pending.pop()!; const directory = join(root, parent);
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !within(root, await realpath(directory))) throw new ProjectExportError('UNSAFE_PATH', `项目目录发生变化：${portable(parent)}`);
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (++scanned > 100000) fail('项目超过 100000 个待检查目录项，请先整理缓存或缩小项目范围。');
        if (/[\\:\x00-\x1f\x7f]/.test(child.name)) throw new ProjectExportError('UNSAFE_PATH', '项目含有无法安全写入跨平台 ZIP 的文件名。');
        if (excluded(child.name, child.isDirectory(), portable(parent)) || child.isSymbolicLink()) { excludedCount++; continue; }
        const rel = join(parent, child.name); const path = join(root, rel); const stat = await lstat(path);
        if (stat.isSymbolicLink()) { excludedCount++; continue; }
        const actual = await realpath(path);
        if (!within(root, actual)) throw new ProjectExportError('UNSAFE_PATH', `项目路径越界：${portable(rel)}`);
        // Some Windows reparse points are not reported by Dirent; require canonical containment too.
        if (stat.isDirectory()) { pending.push(rel); continue; }
        if (!stat.isFile() || !(EXTENSIONS.has(extname(child.name).toLowerCase()) || NAMED_FILES.has(child.name.toLowerCase()))) { excludedCount++; continue; }
        if (stat.size > limits.maxFileBytes) fail(`文件 ${portable(rel)} 超过单文件限额 ${limits.maxFileBytes} 字节。`);
        if (entries.length >= limits.maxFiles) fail(`成果文件数超过 ${limits.maxFiles}。`);
        if (totalBytes + stat.size > limits.maxTotalBytes) fail(`成果总大小超过 ${limits.maxTotalBytes} 字节。`);
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes: Buffer;
        try {
          if (!same(stat, await handle.stat()) || !within(root, await realpath(path))) throw new ProjectExportError('UNSAFE_PATH', `文件在读取前发生变化：${portable(rel)}`);
          const buffer = Buffer.alloc(stat.size + 1); let count = 0;
          while (count < buffer.length) {
            const read = await handle.read(buffer, count, buffer.length - count, count);
            if (!read.bytesRead) break;
            count += read.bytesRead;
          }
          if (count !== stat.size || !same(stat, await handle.stat()) || !same(stat, await lstat(path))) throw new ProjectExportError('READ_FAILED', `文件在导出时发生变化，请重试：${portable(rel)}`);
          bytes = buffer.subarray(0, count);
        } finally { await handle.close(); }
        entries.push({ name: portable(rel), bytes, modified: stat.mtime }); observed.push({ path, stat }); totalBytes += bytes.length;
      }
      if (!same(directoryStat, await lstat(directory))) throw new ProjectExportError('READ_FAILED', `目录在导出时发生变化，请重试：${portable(parent) || '.'}`);
      observed.push({ path: directory, stat: directoryStat });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const fileCount = entries.length;
    let readmeName = 'EXPORT_README.md'; let suffix = 1;
    while (entries.some(entry => entry.name.toLowerCase() === readmeName.toLowerCase())) readmeName = `EXPORT_README-${++suffix}.md`;
    const readme = `# 研究成果导出\n\n项目：${project.name}\n项目编号：${project.id}\n研究目标：${project.goal || '未填写'}\n导出时间（UTC）：${exportedAt}\n\n包含 ${fileCount} 个成果文件，共 ${totalBytes} 字节（另附本说明）。保留项目内相对路径；包含常见研究文档、图表、表格、科学数据、源代码，以及 .aris 中的进展、图表和流程记录。\n\n排除：符号链接及目录联接、隐藏配置（.aris 除外）、.bri、.git、.env*、凭据及私钥、会话及原始聊天日志、代理配置、依赖目录、缓存、虚拟环境、临时文件、模型检查点、.aris/tools 共享工具挂载，以及未识别的文件扩展名。共跳过 ${excludedCount} 个文件或目录项；排除目录下的文件不逐项计数。未复制项目目录外的文件。\n\n限额：单文件 ${limits.maxFileBytes} 字节，总成果 ${limits.maxTotalBytes} 字节，${limits.maxFiles} 个成果文件；超过限额或读取失败时整个导出失败，不会生成部分成果包。使用标准 UTF-8 ZIP，不支持 ZIP64。\n\n## 成果文件\n\n${entries.map(entry => `- ${entry.name.replace(/[\r\n]/g, ' ')} (${entry.bytes.length} 字节)`).join('\n') || '暂无可导出的成果文件。'}\n`;
    entries.push({ name: readmeName, bytes: Buffer.from(readme), modified: now });
    const bytes = await zip(entries);
    // Compression can take time; changes anywhere already read invalidate this export.
    for (const item of observed) {
      if (!same(item.stat, await lstat(item.path)) || !within(root, await realpath(item.path))) throw new ProjectExportError('READ_FAILED', '项目文件在导出时发生变化，请重试。');
    }
    const stem = (project.name || project.id).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'research';
    return { bytes, filename: `${stem}-results-${exportedAt.slice(0, 10)}.zip`, fileCount, totalBytes, excludedCount, exportedAt };
  } catch (error) {
    if (error instanceof ProjectExportError) throw error;
    throw new ProjectExportError('READ_FAILED', '无法完整读取项目成果，请检查文件权限并重试。');
  }
}
