import { translate as tr } from './i18n';
const PAD = (n: number): string => (n < 10 ? `0${n}` : String(n));

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value) && !/Z|[+-]\d{2}:?\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function clockMs(ms: number): string {
  const d = new Date(ms);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}:${PAD(d.getSeconds())}`;
}

export function clock(value: string | null | undefined): string {
  const d = toDate(value);
  return d ? clockMs(d.getTime()) : '--:--:--';
}

export function dateTime(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return tr('无时间');
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${clock(value)}`;
}

export function dayTime(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return tr('无时间');
  return `${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${clock(value)}`;
}

function seconds(of: number): string {
  const s = Math.max(0, Math.floor(of));
  if (s < 60) return tr('{0} 秒',{0:s});
  const m = Math.floor(s / 60);
  if (m < 60) return tr('{0} 分 {1} 秒',{0:m,1:PAD(s%60)});
  return tr('{0} 小时 {1} 分',{0:Math.floor(m/60),1:PAD(m%60)});
}

export function durationSince(start: string | null | undefined, end: string | null | undefined, now: number): string {
  const from = toDate(start);
  if (!from) return tr('未开始');
  const to = toDate(end) ?? new Date(now);
  return seconds((to.getTime() - from.getTime()) / 1000);
}

export function ago(value: string | null | undefined, now: number): string {
  const d = toDate(value);
  if (!d) return tr('未知');
  const elapsed = Math.max(0, (now - d.getTime()) / 1000);
  if (elapsed >= 86_400) return tr('{0} 天前',{0:Math.floor(elapsed/86_400)});
  return tr('{0}前',{0:seconds(elapsed)});
}

export function percent(used: number | null | undefined, total: number | null | undefined): number | null {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function num(value: number | null | undefined, digits = 0): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return tr('无数据');
  return value.toFixed(digits);
}

export function ratioText(
  used: number | null | undefined,
  total: number | null | undefined,
  unit: string,
): string {
  if (typeof used !== 'number' || typeof total !== 'number') return tr('无数据');
  return `${used.toFixed(0)} / ${total.toFixed(0)} ${unit}`;
}

export function clipText(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
