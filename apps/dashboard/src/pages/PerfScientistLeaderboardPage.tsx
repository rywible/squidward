import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PerfScientistLeaderboardPage() {
  const leaderboard = usePollingQuery(() => dashboardApiClient.getPerfScientistLeaderboard('30d'), 30000);

  return (
    <section>
      <h2>Perf Leaderboard (30d)</h2>
      <p className="muted">Top APS recommendations by weighted decision score.</p>
      <PageState
        loading={leaderboard.loading}
        error={leaderboard.error}
        refreshing={leaderboard.refreshing}
        onRefresh={() => void leaderboard.refresh()}
      />

      {!leaderboard.loading && !leaderboard.error ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Status</th>
                <th>Risk</th>
                <th>Last Decision</th>
              </tr>
            </thead>
            <tbody>
              {(leaderboard.data ?? []).map((row) => (
                <tr key={row.candidate.id}>
                  <td>{row.candidate.title}</td>
                  <td>{row.candidate.status}</td>
                  <td>{row.candidate.riskClass}</td>
                  <td>{row.decision.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
