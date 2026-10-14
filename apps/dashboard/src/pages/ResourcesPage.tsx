import { useI18n } from '../i18n';
import { fetchHosts } from '../api';
import { useAsync } from '../hooks/useAsync';
import { clock, dateTime, ratioText } from '../format';
import { HostCard } from '../components/HostCard';
import { Card, Empty, FetchFailure } from '../components/bits';

/**
 * 资源是跨项目的共享观测，因此这一视图不属于任何单个项目：
 * 它回答「最近一次缓存观测是什么、我们的执行进程占了几何」。
 */
export function ResourcesPage({ revision, now }: { revision: number; now: number }): JSX.Element {
  const { t: tr } = useI18n();
  const hosts = useAsync(() => fetchHosts(), [revision]);
  const entries = hosts.data ?? [];

  return (
    <div className="resources-page">
      <Card title={tr("观测范围")} aside={<span className="aside-note">{tr("主机级，不归属单个项目")}</span>}>
        <p className="scope-note">
           {tr("下列数值是主机整体情况：GPU、内存与磁盘包含同一台机器上其他使用者的负载。本项目的执行进程数单独统计， 两者不混为一谈；共享主机上是否让路取决于调度器与协调，不由本页面决定。")} </p>
      </Card>

      <FetchFailure failure={hosts.error} stale={entries.length > 0} />
      {hosts.loading && entries.length === 0 ? <Empty text={tr("正在读取缓存")} /> : null}
      {!hosts.loading && entries.length === 0 ? <Empty text={tr("尚无缓存采样")} note={tr("尚未接入资源采样；已有缓存请核对观测时间。")} /> : null}

      {entries.map((entry) => (
        <div key={entry.host} className="host-block">
          <HostCard host={entry.latest ?? null} entry={entry} failure={null} loading={hosts.loading} now={now} />
          <Card title={tr("采样历史")} aside={<span className="aside-note">{tr("最近缓存观测")} {entry.sampled_at ? clock(entry.sampled_at) : tr("无")}</span>}>
            {entry.latest ? (
              <ul className="sample-list">
                <li>
                  <span>SSH</span>
                  <span>{entry.latest.reachable === 1 ? tr("连通") : tr("失联（{0}）", { 0: dateTime(entry.latest.sampled_at) })}</span>
                </li>
                <li>
                  <span>{tr("GPU 利用率")}</span>
                  <span>{entry.latest.gpu_util === null ? tr("无数据") : `${entry.latest.gpu_util} %`}</span>
                </li>
                <li>
                  <span>{tr("显存")}</span>
                  <span>{ratioText(entry.latest.gpu_mem_used, entry.latest.gpu_mem_total, 'MB')}</span>
                </li>
                <li>
                  <span>{tr("内存")}</span>
                  <span>{ratioText(entry.latest.mem_used, entry.latest.mem_total, 'MB')}</span>
                </li>
                <li>
                  <span>{tr("磁盘")}</span>
                  <span>{ratioText(entry.latest.disk_used, entry.latest.disk_total, 'GB')}</span>
                </li>
                <li>
                  <span>{tr("本项目执行进程")}</span>
                  <span>{entry.latest.running_tasks || '0'}</span>
                </li>
              </ul>
            ) : (
              <Empty text={tr("尚无采样")} />
            )}
            {entry.previous ? (
              <p className="hint">
                 {tr("与上一次采样的差值：CPU")}{' '}
                {entry.latest && entry.previous.cpu_pct !== null && entry.latest.cpu_pct !== null
                  ? tr("{0} 个百分点", { 0: (entry.latest.cpu_pct - entry.previous.cpu_pct).toFixed(1) })
                  : tr("无数据")}
                 {tr("，显存")}{' '}
                {entry.latest && entry.latest.gpu_mem_used !== null && entry.previous.gpu_mem_used !== null
                  ? `${entry.latest.gpu_mem_used - entry.previous.gpu_mem_used} MB`
                  : tr("无数据")}
              </p>
            ) : null}
            {entry.latest?.raw ? (
              <details className="raw-sample">
                <summary>{tr("原始采样")}</summary>
                <pre>{entry.latest.raw}</pre>
              </details>
            ) : null}
          </Card>
        </div>
      ))}
    </div>
  );
}
