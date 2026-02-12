import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function TestsEvolutionPage() {
  const stats = usePollingQuery(() => dashboardApiClient.getTestEvolutionStats(), 12_000);
  const candidates = usePollingQuery(() => dashboardApiClient.getTestEvolutionCandidates(undefined, undefined), 18_000);

  const loading = stats.loading || candidates.loading;
  const error = stats.error ?? candidates.error;
  const refreshing = stats.refreshing || candidates.refreshing;

  return (
    <section>
      <h2>Self-Evolving Tests</h2>
      <p className="muted">Bug-to-regression candidate generation and acceptance tracking.</p>
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={() => {
        void stats.refresh();
        void candidates.refresh();
      }} />

      {!loading && !error ? (
        <div className="card-grid">
          <article className="card">
            <h3>Hit Rate</h3>
            <p>
              {stats.data?.accepted ?? 0}/{stats.data?.generated ?? 0} accepted ({((stats.data?.acceptanceRate ?? 0) * 100).toFixed(1)}%)
            </p>
            <p className="muted">Last run: {stats.data?.lastRunAt ? new Date(stats.data.lastRunAt).toLocaleString() : 'n/a'}</p>
          </article>

          <article className="card">
            <h3>Latest Candidates</h3>
            <ul>
              {(candidates.data?.items ?? []).slice(0, 20).map((item) => (
                <li key={item.id}>
                  {item.status} {item.testPath} ({item.score.toFixed(2)})
                </li>
              ))}
            </ul>
          </article>
        </div>
      ) : null}
    </section>
  );
}
