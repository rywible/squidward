import { useMemo } from 'react';
import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { Sparkline } from '../components/Sparkline';
import { TaskActionButtons } from '../components/TaskActionButtons';
import { usePollingQuery } from '../hooks/usePollingQuery';

interface MetricCardProps {
  label: string;
  value: string | number;
  trend: number[];
}

function trendFromCurrent(value: number): number[] {
  const normalized = Number.isFinite(value) ? value : 0;
  return [0.92, 0.95, 0.97, 1, 0.99, 1.01, 1].map((factor) => Math.max(0, normalized * factor));
}

function MetricCard({ label, value, trend }: MetricCardProps) {
  return (
    <article className="panel stat">
      <h3>{label}</h3>
      <p>{value}</p>
      <Sparkline className="metric-sparkline" values={trend} />
    </article>
  );
}

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

  const trends = useMemo(
    () => ({
      activeRuns: trendFromCurrent(data?.activeRuns ?? 0),
      queuedTasks: trendFromCurrent(data?.queuedTasks ?? 0),
      incidentsOpen: trendFromCurrent(data?.incidentsOpen ?? 0),
      approvalsPending: trendFromCurrent(data?.approvalsPending ?? 0),
      topEv: trendFromCurrent(portfolioTop.data?.[0]?.score.ev ?? 0),
      testHitRate: trendFromCurrent((tests.data?.acceptanceRate ?? 0) * 100),
      graphFreshness: trendFromCurrent(graphHotspots.data && graphHotspots.data.length > 0 ? 1 : 0),
      perfRuns: trendFromCurrent(perfStatus.data?.runningExperiments ?? 0),
    }),
    [
      data?.activeRuns,
      data?.approvalsPending,
      data?.incidentsOpen,
      data?.queuedTasks,
      graphHotspots.data,
      perfStatus.data?.runningExperiments,
      portfolioTop.data,
      tests.data?.acceptanceRate,
    ],
  );

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
        <MetricCard label="Active Runs" trend={trends.activeRuns} value={data?.activeRuns ?? 0} />
        <MetricCard label="Queued Tasks" trend={trends.queuedTasks} value={data?.queuedTasks ?? 0} />
        <MetricCard label="Incidents Open" trend={trends.incidentsOpen} value={data?.incidentsOpen ?? 0} />
        <MetricCard label="Approvals Pending" trend={trends.approvalsPending} value={data?.approvalsPending ?? 0} />
        <MetricCard
          label="Top EV Opportunity"
          trend={trends.topEv}
          value={portfolioTop.data?.[0] ? portfolioTop.data[0].score.ev.toFixed(2) : 'n/a'}
        />
        <MetricCard
          label="Test Evolution Hit Rate"
          trend={trends.testHitRate}
          value={`${((tests.data?.acceptanceRate ?? 0) * 100).toFixed(1)}%`}
        />
        <article className="panel stat">
          <h3>Latest Memo</h3>
          <p>{memo.data?.createdAt ? new Date(memo.data.createdAt).toLocaleDateString() : 'none'}</p>
        </article>
        <MetricCard
          label="Graph Freshness"
          trend={trends.graphFreshness}
          value={graphHotspots.data && graphHotspots.data.length > 0 ? 'indexed' : 'pending'}
        />
        <MetricCard
          label="Perf Scientist"
          trend={trends.perfRuns}
          value={perfStatus.data?.enabled ? `${perfStatus.data.runningExperiments} running` : 'disabled'}
        />
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
