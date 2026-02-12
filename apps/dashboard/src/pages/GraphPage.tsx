import { useState } from 'react';
import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function GraphPage() {
  const [query, setQuery] = useState('wrela');
  const [activeQuery, setActiveQuery] = useState('wrela');

  const hotspots = usePollingQuery(() => dashboardApiClient.graphHotspots(), 20_000);
  const impact = usePollingQuery(() => dashboardApiClient.graphImpact(activeQuery), 25_000);

  const loading = hotspots.loading || impact.loading;
  const error = hotspots.error ?? impact.error;
  const refreshing = hotspots.refreshing || impact.refreshing;

  return (
    <section>
      <h2>Architecture Memory Graph</h2>
      <p className="muted">Code + PR + incident causality index with explain paths.</p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setActiveQuery(query.trim() || 'wrela');
        }}
        style={{ display: 'flex', gap: 8, marginBottom: 12 }}
      >
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="file, symbol, or service" />
        <button type="submit">Run impact query</button>
      </form>

      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={() => {
        void hotspots.refresh();
        void impact.refresh();
      }} />

      {!loading && !error ? (
        <div className="card-grid">
          <article className="card">
            <h3>Impact</h3>
            <p>
              Nodes: {impact.data?.touchedNodes.length ?? 0} | Edges: {impact.data?.edges.length ?? 0}
            </p>
            <ul>
              {(impact.data?.touchedNodes ?? []).slice(0, 10).map((node) => (
                <li key={node.id}>
                  {node.nodeType}: {node.ref}
                </li>
              ))}
            </ul>
          </article>

          <article className="card">
            <h3>Hotspots</h3>
            <ul>
              {(hotspots.data ?? []).slice(0, 15).map((item) => (
                <li key={`${item.ref}:${item.count}`}>
                  {item.ref} ({item.count})
                </li>
              ))}
            </ul>
          </article>
        </div>
      ) : null}
    </section>
  );
}
