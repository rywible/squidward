import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PolicyPage() {
  const query = usePollingQuery(() => dashboardApiClient.getPolicyStatus(), 7000);
  const runAction = async (domain: string, action: 'retrain' | 'rollback') => {
    await dashboardApiClient.policyAction(domain, action);
    await query.refresh();
  };

  return (
    <section>
      <h2>Policy Learning</h2>
      <p className="muted">Bandit exploration state and 7-day reward trend by domain.</p>
      <PageState
        error={query.error}
        loading={query.loading}
        refreshing={query.refreshing}
        onRefresh={() => void query.refresh()}
      />

      <div className="table-wrap panel">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Exploration</th>
              <th>Version</th>
              <th>7d Reward</th>
              <th>Last Decision</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((item) => (
              <tr key={item.domain}>
                <td>{item.domain}</td>
                <td>{Math.round(item.explorationRate * 100)}%</td>
                <td>{item.latestVersion ?? 'n/a'}</td>
                <td>{item.totalRewards7d.toFixed(3)}</td>
                <td>{item.lastDecisionAt ? new Date(item.lastDecisionAt).toLocaleString() : 'n/a'}</td>
                <td>
                  <button onClick={() => void runAction(item.domain, 'retrain')}>Retrain</button>{' '}
                  <button onClick={() => void runAction(item.domain, 'rollback')}>Rollback</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
