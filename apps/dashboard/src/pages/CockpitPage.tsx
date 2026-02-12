import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { TaskActionButtons } from '../components/TaskActionButtons';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function CockpitPage() {
  const { data, error, loading, refreshing, refresh } = usePollingQuery(
    (signal) => dashboardApiClient.getCockpit(signal),
    5000,
  );
  const portfolioTop = usePollingQuery(() => dashboardApiClient.getPortfolioTop(1), 15000);
  const tests = usePollingQuery(() => dashboardApiClient.getTestEvolutionStats(), 15000);
  const memo = usePollingQuery(() => dashboardApiClient.getLatestMemo(), 30000);
  const graphHotspots = usePollingQuery(() => dashboardApiClient.graphHotspots(), 20000);
  const perfStatus = usePollingQuery(() => dashboardApiClient.getPerfScientistStatus(), 15000);

  if (!data && (loading || error)) {
    return (
      <section>
        <h2>Ops Cockpit</h2>
        <PageState error={error} loading={loading} onRefresh={() => void refresh()} refreshing={refreshing} />
      </section>
    );
  }

  return (
    <section>
      <h2>Ops Cockpit</h2>
      <PageState error={error} loading={false} onRefresh={() => void refresh()} refreshing={refreshing} />

      <div className="grid-cards">
        <article className="panel stat">
          <h3>Active Runs</h3>
          <p>{data?.activeRuns ?? 0}</p>
        </article>
        <article className="panel stat">
          <h3>Queued Tasks</h3>
          <p>{data?.queuedTasks ?? 0}</p>
        </article>
        <article className="panel stat">
          <h3>Incidents Open</h3>
          <p>{data?.incidentsOpen ?? 0}</p>
        </article>
        <article className="panel stat">
          <h3>Approvals Pending</h3>
          <p>{data?.approvalsPending ?? 0}</p>
        </article>
        <article className="panel stat">
          <h3>Top EV Opportunity</h3>
          <p>{portfolioTop.data?.[0] ? portfolioTop.data[0].score.ev.toFixed(2) : 'n/a'}</p>
        </article>
        <article className="panel stat">
          <h3>Test Evolution Hit Rate</h3>
          <p>{((tests.data?.acceptanceRate ?? 0) * 100).toFixed(1)}%</p>
        </article>
        <article className="panel stat">
          <h3>Latest Memo</h3>
          <p>{memo.data?.createdAt ? new Date(memo.data.createdAt).toLocaleDateString() : 'none'}</p>
        </article>
        <article className="panel stat">
          <h3>Graph Freshness</h3>
          <p>{graphHotspots.data && graphHotspots.data.length > 0 ? 'indexed' : 'pending'}</p>
        </article>
        <article className="panel stat">
          <h3>Perf Scientist</h3>
          <p>{perfStatus.data?.enabled ? `${perfStatus.data.runningExperiments} running` : 'disabled'}</p>
        </article>
      </div>

      <article className="panel">
        <h3>Health</h3>
        <p className={`health ${data?.health ?? 'down'}`}>{data?.health?.toUpperCase() ?? 'UNKNOWN'}</p>
      </article>

      {data?.latestRun ? (
        <article className="panel">
          <h3>Latest Run</h3>
          <p>
            <strong>{data.latestRun.objective}</strong> ({data.latestRun.status})
          </p>
          <p className="muted">Run ID: {data.latestRun.id}</p>
          <TaskActionButtons entityId={data.latestRun.id} entityType="run" onDone={refresh} />
        </article>
      ) : null}
    </section>
  );
}
