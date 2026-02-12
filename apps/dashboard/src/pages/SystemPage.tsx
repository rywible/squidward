import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function SystemPage() {
  const { data, error, loading, refreshing, refresh } = usePollingQuery(
    (signal) => dashboardApiClient.getSystem(signal),
    5000,
  );

  return (
    <section>
      <h2>System</h2>
      <PageState error={error} loading={loading} onRefresh={() => void refresh()} refreshing={refreshing} />

      {data ? (
        <div className="grid-cards">
          <article className="panel stat">
            <h3>Mode</h3>
            <p>{data.mode}</p>
          </article>
          <article className="panel stat">
            <h3>Uptime</h3>
            <p>{Math.floor(data.uptimeSeconds / 60)} min</p>
          </article>
          <article className="panel stat">
            <h3>Memory</h3>
            <p>{data.memoryMb} MB</p>
          </article>
          <article className="panel stat">
            <h3>CPU</h3>
            <p>{data.cpuPercent}%</p>
          </article>
          <article className="panel stat">
            <h3>Queue Depth</h3>
            <p>{data.queueDepth}</p>
          </article>
          <article className="panel stat">
            <h3>Denials (1h)</h3>
            <p>{data.policyDenialsLastHour}</p>
          </article>
        </div>
      ) : null}
    </section>
  );
}
