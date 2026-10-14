import { useI18n } from '../i18n';
import type { Failure, HostListEntry, HostSample } from '../types';
import { clock, clockMs, dateTime, num, percent, ratioText } from '../format';
import { Card, Empty, FetchFailure, Meter } from './bits';

function meterTone(value: number | null): 'warn' | 'bad' | undefined {
  if (value === null) return undefined;
  if (value >= 90) return 'bad';
  if (value >= 75) return 'warn';
  return undefined;
}

function Unreachable({ at }: { at: string | null }): JSX.Element {
  const { t: tr } = useI18n();
  return (
    <div className="outage">
      <strong>{tr("连接中断，以下为最后观测值")}</strong>
      <span>{tr("最后采样")} {at ? dateTime(at) : tr("无时间")}  {tr("· 此后主机未被成功探测")}</span>
    </div>
  );
}

function SampleBody({ host }: { host: HostSample }): JSX.Element {
  const { t: tr } = useI18n();
  const offline = host.reachable !== 1;
  const gpuPct = percent(host.gpu_mem_used, host.gpu_mem_total);
  const memPct = percent(host.mem_used, host.mem_total);
  const diskPct = percent(host.disk_used, host.disk_total);
  return (
    <div className={offline ? 'host-sample stale' : 'host-sample'}>
      <div className="host-top">
        <span className="host-name">{host.host}</span>
        <span className={offline ? 'ssh-flag bad' : 'ssh-flag ok'}>
           {tr("SSH 连通：")}{offline ? tr("中断（含最后观测值）") : tr("正常")}
        </span>
      </div>

      <Meter
        label={tr("GPU 利用率")}
        value={host.gpu_util}
        text={host.gpu_util === null ? tr("无数据") : `${num(host.gpu_util, 1)} %`}
        tone={meterTone(host.gpu_util)}
      />
      <Meter
        label={tr("显存")}
        value={gpuPct}
        text={tr("{0}（{1}）", { 0: ratioText(host.gpu_mem_used, host.gpu_mem_total, 'MB'), 1: gpuPct === null ? tr("无数据") : `${gpuPct.toFixed(1)} %` })}
        tone={meterTone(gpuPct)}
      />
      <Meter
        label={tr("内存")}
        value={memPct}
        text={tr("{0}（{1}）", { 0: ratioText(host.mem_used, host.mem_total, 'MB'), 1: memPct === null ? tr("无数据") : `${memPct.toFixed(1)} %` })}
        tone={meterTone(memPct)}
      />
      <Meter
        label={tr("磁盘 /home")}
        value={diskPct}
        text={tr("{0}（{1}）", { 0: ratioText(host.disk_used, host.disk_total, 'GB'), 1: diskPct === null ? tr("无数据") : `${diskPct.toFixed(1)} %` })}
        tone={meterTone(diskPct)}
      />
      <Meter
        label={tr("CPU 占用")}
        value={host.cpu_pct}
        text={host.cpu_pct === null ? tr("无数据") : `${num(host.cpu_pct, 1)} %`}
        tone={meterTone(host.cpu_pct)}
      />

      <div className="host-foot">
        <span>{tr("缓存采样时间")} {dateTime(host.sampled_at)}</span>
        <span>{tr("本机相关执行进程：")}{host.running_tasks || tr("无")}</span>
      </div>
      {offline ? null : (
        <div className="running-tasks">
          <span className="field-label">{tr("正在运行的任务")}</span>
          {host.running_tasks && host.running_tasks !== '0' ? (
            <span className="field-value">{host.running_tasks}  {tr("个执行进程（按主机采集统计，非本项目任务名）")}</span>
          ) : (
            <span className="field-value">{tr("主机报告 0 个执行进程")}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function HostCard({
  host,
  entry,
  failure,
  loading,
  now,
  compact = false,
  onOpenAll,
}: {
  host: HostSample | null;
  entry: HostListEntry | null;
  failure: Failure | null;
  loading: boolean;
  now: number;
  compact?: boolean;
  onOpenAll?: () => void;
}): JSX.Element {
  const { t: tr } = useI18n();
  const shown = host ?? entry?.latest ?? null;
  return (
    <Card
      title={tr("主机")}
      aside={
        <span className="aside-note">
          {shown ? tr("最近缓存观测 {0}", { 0: clock(shown.sampled_at) }) : tr("尚未采样")}
          {entry ? tr(" · 已存 {0} 次采样", { 0: entry.samples }) : ''}
          {compact && onOpenAll ? (
            <>
              {' · '}
              <button type="button" className="link-btn" onClick={onOpenAll}>
                 {tr("资源详情")} </button>
            </>
          ) : null}
        </span>
      }
    >
      <p className="scope-note">{tr("主机整体观测，非本项目独占用量")}</p>
      <FetchFailure failure={failure} stale={shown !== null} />
      {shown === null ? (
        <Empty text={loading ? tr("正在取数") : tr("尚未采样")} />
      ) : (
        <>
          {shown.reachable !== 1 ? <Unreachable at={shown.sampled_at} /> : null}
          <SampleBody host={shown} />
          {!compact && entry?.previous ? (
            <p className="hint">
               {tr("上一次采样")} {dateTime(entry.previous.sampled_at)}  {tr("· 显存")}{' '}
              {ratioText(entry.previous.gpu_mem_used, entry.previous.gpu_mem_total, 'MB')}  {tr("· 内存")}{' '}
              {ratioText(entry.previous.mem_used, entry.previous.mem_total, 'MB')}
            </p>
          ) : null}
        </>
      )}
      {compact ? null : (
        <p className="hint muted">{tr("本地页面时间")} {clockMs(now)}{tr("；这里展示已有缓存，不代表实时探测。")}</p>
      )}
    </Card>
  );
}
