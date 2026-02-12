import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function AuditPage() {
  const { data, error, loading, refreshing, refresh } = usePollingQuery(
    (signal) => dashboardApiClient.getAudit(signal),
    5000,
  );

  return (
    <section>
      <h2>Audit</h2>
      <PageState error={error} loading={loading} onRefresh={() => void refresh()} refreshing={refreshing} />

      <div className="list-grid">
        {(data ?? []).map((entry) => (
          <article className="panel" key={entry.id}>
            <p className="muted">Run: {entry.runId}</p>
            <p>
              <code>{entry.command}</code>
            </p>
            <p className="muted">cwd: {entry.cwd}</p>
            <p>
              Exit code:{' '}
              <strong>{entry.exitCode !== undefined && entry.exitCode !== null ? entry.exitCode : 'running'}</strong>
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
