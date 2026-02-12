import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function MemosPage() {
  const latest = usePollingQuery(() => dashboardApiClient.getLatestMemo(), 30_000);
  const history = usePollingQuery(() => dashboardApiClient.getMemoHistory(undefined, 8), 35_000);

  const loading = latest.loading || history.loading;
  const error = latest.error ?? history.error;
  const refreshing = latest.refreshing || history.refreshing;

  return (
    <section>
      <h2>Personal CTO Memo</h2>
      <p className="muted">Weekly strategic brief with kill/double-down recommendations.</p>
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={() => {
        void latest.refresh();
        void history.refresh();
      }} />

      {!loading && !error ? (
        <div className="card-grid">
          <article className="card">
            <h3>Latest Memo</h3>
            {latest.data ? (
              <>
                <p>
                  Window: {new Date(latest.data.weekStart).toLocaleDateString()} - {new Date(latest.data.weekEnd).toLocaleDateString()}
                </p>
                <p>{latest.data.summaryMd.split('\n').slice(0, 5).join(' ')}</p>
                <p className="muted">Recommendations: {latest.data.recommendations.length}</p>
              </>
            ) : (
              <p>No memo generated yet.</p>
            )}
          </article>

          <article className="card">
            <h3>Memo History</h3>
            <ul>
              {(history.data?.items ?? []).map((memo) => (
                <li key={memo.id}>
                  {new Date(memo.createdAt).toLocaleString()} ({memo.recommendations.length} recs)
                </li>
              ))}
            </ul>
          </article>
        </div>
      ) : null}
    </section>
  );
}
