import { useState } from 'react';

import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function RetrievalPage() {
  const status = usePollingQuery(() => dashboardApiClient.getRetrievalStatus(), 7000);
  const queries = usePollingQuery(() => dashboardApiClient.getRetrievalQueries(undefined, 25), 7000);
  const [selectedQuery, setSelectedQuery] = useState<string | null>(null);
  const results = usePollingQuery(
    () => (selectedQuery ? dashboardApiClient.getRetrievalResults(selectedQuery) : Promise.resolve({ items: [], contextPack: { queryId: '', selectedCount: 0, budgetTokens: 0, usedTokens: 0, evidenceRefs: [], snippets: [] } })),
    9000,
  );

  const loading = status.loading || queries.loading || (selectedQuery !== null && results.loading);
  const refreshing = status.refreshing || queries.refreshing || results.refreshing;
  const error = status.error ?? queries.error ?? results.error;

  return (
    <section>
      <h2>Retrieval</h2>
      <p className="muted">Memory retrieval v3 diagnostics for mission context assembly.</p>
      <PageState
        error={error}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => {
          void status.refresh();
          void queries.refresh();
          if (selectedQuery) {
            void results.refresh();
          }
        }}
      />

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Status</h3>
        {status.data ? (
          <ul>
            <li>Enabled: {status.data.enabled ? 'yes' : 'no'}</li>
            <li>Last query: {status.data.lastQueryAt ? new Date(status.data.lastQueryAt).toLocaleString() : 'n/a'}</li>
            <li>Approx p95 latency: {Math.round(status.data.p95LatencyMs)}ms</li>
            <li>Cache hit rate: {Math.round(status.data.cacheHitRate * 100)}%</li>
            <li>Avg used tokens: {Math.round(status.data.avgUsedTokens)}</li>
          </ul>
        ) : null}
      </div>

      <div className="table-wrap panel" style={{ marginBottom: 16 }}>
        <h3>Queries</h3>
        <table>
          <thead>
            <tr>
              <th>Query</th>
              <th>Intent</th>
              <th>Selected</th>
              <th>Tokens</th>
              <th>Latency</th>
              <th>Cache</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(queries.data?.items ?? []).map((item) => (
              <tr key={item.id} onClick={() => setSelectedQuery(item.id)} style={{ cursor: 'pointer' }}>
                <td>{item.id.slice(0, 8)}</td>
                <td>{item.intent}</td>
                <td>{item.selectedCount}</td>
                <td>{item.usedTokens}/{item.budgetTokens}</td>
                <td>{item.latencyMs}ms</td>
                <td>{item.cacheHit ? 'hit' : 'miss'}</td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrap panel">
        <h3>Results {selectedQuery ? `(${selectedQuery.slice(0, 8)})` : ''}</h3>
        <table>
          <thead>
            <tr>
              <th>Source Class</th>
              <th>Source Ref</th>
              <th>Score</th>
              <th>Tokens</th>
              <th>Excerpt</th>
            </tr>
          </thead>
          <tbody>
            {(results.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.sourceClass}</td>
                <td>{item.sourceRef}</td>
                <td>{item.score.toFixed(3)}</td>
                <td>{item.tokenEstimate}</td>
                <td>{item.excerpt.slice(0, 120)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
