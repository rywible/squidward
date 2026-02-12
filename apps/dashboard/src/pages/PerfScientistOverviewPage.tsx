import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PerfScientistOverviewPage() {
  const status = usePollingQuery(() => dashboardApiClient.getPerfScientistStatus(), 15000);
  const baselines = usePollingQuery(() => dashboardApiClient.getPerfScientistBaselines(5), 30000);
  const leaderboard = usePollingQuery(() => dashboardApiClient.getPerfScientistLeaderboard('7d'), 30000);

  const loading = status.loading || baselines.loading || leaderboard.loading;
  const error = status.error ?? baselines.error ?? leaderboard.error;
  const refreshing = status.refreshing || baselines.refreshing || leaderboard.refreshing;

  return (
    <section>
      <h2>Autonomous Perf Scientist</h2>
      <p className="muted">Nightly baselines + change-triggered smoke + ranked perf candidates.</p>

      <PageState
        loading={loading}
        error={error}
        refreshing={refreshing}
        onRefresh={() => {
          void status.refresh();
          void baselines.refresh();
          void leaderboard.refresh();
        }}
      />

      {!loading && !error ? (
        <div className="card-grid">
          <article className="card">
            <h3>Status</h3>
            <p>Enabled: {status.data?.enabled ? 'yes' : 'no'}</p>
            <p>Repo: {status.data?.repoPath ?? 'n/a'}</p>
            <p>Queued APS tasks: {status.data?.queuedTasks ?? 0}</p>
            <p>Running experiments: {status.data?.runningExperiments ?? 0}</p>
            <p>Nightly hour: {status.data?.nextNightlyHour ?? 2}:00</p>
          </article>

          <article className="card">
            <h3>Baseline Freshness</h3>
            <p>Last baseline: {status.data?.lastBaselineAt ? new Date(status.data.lastBaselineAt).toLocaleString() : 'none'}</p>
            <p>Last experiment: {status.data?.lastExperimentAt ? new Date(status.data.lastExperimentAt).toLocaleString() : 'none'}</p>
            <p>Recent baselines: {baselines.data?.length ?? 0}</p>
          </article>

          <article className="card">
            <h3>7d Leaderboard</h3>
            <ul>
              {(leaderboard.data ?? []).slice(0, 10).map((item) => (
                <li key={item.candidate.id}>
                  {item.candidate.title} ({item.candidate.status})
                </li>
              ))}
            </ul>
          </article>
        </div>
      ) : null}
    </section>
  );
}
