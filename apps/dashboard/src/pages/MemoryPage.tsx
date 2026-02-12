import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function MemoryPage() {
  const facts = usePollingQuery(() => dashboardApiClient.getMemoryFacts(), 7000);
  const episodes = usePollingQuery(() => dashboardApiClient.getMemoryEpisodes(), 9000);
  const error = facts.error ?? episodes.error;
  const loading = facts.loading || episodes.loading;
  const refreshing = facts.refreshing || episodes.refreshing;

  return (
    <section>
      <h2>Memory</h2>
      <p className="muted">Canonical facts and episodic traces committed via memory governor.</p>
      <PageState
        error={error}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => {
          void facts.refresh();
          void episodes.refresh();
        }}
      />

      <div className="table-wrap panel">
        <h3>Facts</h3>
        <table>
          <thead>
            <tr>
              <th>Namespace</th>
              <th>Key</th>
              <th>Confidence</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(facts.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.namespace}</td>
                <td>{item.key}</td>
                <td>{Math.round(item.confidence * 100)}%</td>
                <td>{item.source}</td>
                <td>{new Date(item.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrap panel">
        <h3>Episodes</h3>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Trigger</th>
              <th>Summary</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(episodes.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.runId}</td>
                <td>{item.triggerType}</td>
                <td>{String(item.outcome.summary ?? item.outcome.status ?? 'episode')}</td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
