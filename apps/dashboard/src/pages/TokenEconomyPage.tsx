import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function TokenEconomyPage() {
  const status = usePollingQuery(() => dashboardApiClient.getTokenEconomyStatus(), 7000);
  const usage = usePollingQuery(() => dashboardApiClient.getTokenEconomyUsage(), 7000);
  const error = status.error ?? usage.error;
  const loading = status.loading || usage.loading;
  const refreshing = status.refreshing || usage.refreshing;
  const setMode = async (domain: string, enabled: boolean) => {
    await dashboardApiClient.tokenEconomyAction(enabled ? 'enter_economy_mode' : 'exit_economy_mode', { domain });
    await status.refresh();
  };

  return (
    <section>
      <h2>Token Economy</h2>
      <p className="muted">Domain-level token governance, caps, and economy mode activation.</p>
      <PageState
        error={error}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => {
          void status.refresh();
          void usage.refresh();
        }}
      />

      <div className="table-wrap panel">
        <h3>Budget Status</h3>
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Used</th>
              <th>Soft Cap</th>
              <th>Hard Cap</th>
              <th>Economy Mode</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(status.data ?? []).map((item) => (
              <tr key={item.domain}>
                <td>{item.domain}</td>
                <td>{item.monthlyUsedTokens}</td>
                <td>{item.softCap}</td>
                <td>{item.hardCap}</td>
                <td>{item.economyMode ? 'on' : 'off'}</td>
                <td>
                  <button onClick={() => void setMode(item.domain, true)}>Force On</button>{' '}
                  <button onClick={() => void setMode(item.domain, false)}>Normalize</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrap panel">
        <h3>Recent Usage</h3>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Domain</th>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(usage.data?.items ?? []).slice(0, 25).map((item) => (
              <tr key={item.id}>
                <td>{item.runId}</td>
                <td>{item.domain}</td>
                <td>{item.model}</td>
                <td>{item.inputTokens}</td>
                <td>{item.outputTokens}</td>
                <td>{item.cacheHit ? 'hit' : 'miss'}</td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
