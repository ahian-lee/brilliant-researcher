import { useI18n } from '../i18n';
import type { ReactNode } from 'react';
import type { Failure } from '../types';
import { clock } from '../format';

export function Card({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      <header className="card-head">
        <h2>{title}</h2>
        {aside ? <div className="card-aside">{aside}</div> : null}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Empty({ text, note }: { text: string; note?: string }): JSX.Element {
  return (
    <p className="empty">
      {text}
      {note ? <span className="empty-note">{note}</span> : null}
    </p>
  );
}

export function FetchFailure({ failure, stale }: { failure: Failure | null; stale: boolean }): JSX.Element | null {
  const { t: tr } = useI18n();
  if (!failure) return null;
  return (
    <div className="fail">
      <span className="fail-title">{tr("取数失败 ·")} {clock(failure.at)}</span>
      <span className="fail-msg">{failure.message}</span>
      {stale ? <span className="fail-note">{tr("下方为上次成功取到的数据，可能已过期")}</span> : null}
    </div>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  const { t: tr } = useI18n();
  return (
    <div className="field">
      <span className="field-label">{tr(label)}</span>
      <span className="field-value">{value}</span>
    </div>
  );
}

export function Meter({
  label,
  value,
  text,
  tone,
}: {
  label: string;
  value: number | null;
  text: string;
  tone?: 'warn' | 'bad';
}): JSX.Element {
  const { t: tr } = useI18n();
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{tr(label)}</span>
        <span className="meter-value">{text}</span>
      </div>
      <div className="meter-track">
        <div
          className={tone ? `meter-fill tone-${tone}` : 'meter-fill'}
          style={{ width: value === null ? '0%' : `${Math.min(100, value)}%` }}
        />
      </div>
      {value === null ? <span className="meter-missing">{tr("无数据")}</span> : null}
    </div>
  );
}
