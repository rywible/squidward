import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PortfolioPage() {
  const top = usePollingQuery(() => dashboardApiClient.getPortfolioTop(10), 15_000);
  const history = usePollingQuery(() => dashboardApiClient.getPortfolioHistory(undefined, 25), 20_000);

  const loading = top.loading || history.loading;
  const error = top.error ?? history.error;
  const refreshing = top.refreshing || history.refreshing;

  return (
    <section>
      <h2>PR Hedge Fund</h2>
      <p className="muted">Expected-value ranked work portfolio and policy decisions.</p>
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={() => {
        void top.refresh();
        void history.refresh();
      }} />

      {!loading && !error ? (
        <div className="card-grid">
          <article className="card">
            <h3>Top Opportunities</h3>
            <ul>
              {(top.data ?? []).map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong> EV {item.score.ev.toFixed(2)} ({item.riskClass}/{item.effortClass})
                </li>
              ))}
            </ul>
          </article>

          <article className="card">
            <h3>Decision History</h3>
            <ul>
              {(history.data?.items ?? []).map((item) => (
                <li key={item.id}>
                  {item.decision}: {item.reason} ({new Date(item.createdAt).toLocaleString()})
                </li>
              ))}
            </ul>
          </article>
        </div>
      ) : null}
    </section>
  );
}
