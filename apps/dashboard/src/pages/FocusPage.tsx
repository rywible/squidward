import { useMemo, useState } from 'react';
import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { usePollingQuery } from '../hooks/usePollingQuery';
import type { CockpitSnapshot, PortfolioCandidate, QueueTask, RunSummary } from '../types/dashboard';
import { buildFocusNextCard, buildFocusNowCard, buildFocusRiskCard } from './focus-model';
import { appIcons } from '../lib/icons';

interface FocusPayload {
  cockpit: CockpitSnapshot;
  runs: RunSummary[];
  queue: QueueTask[];
  portfolio: PortfolioCandidate[];
}

const fetchFocusPayload = async (signal: AbortSignal): Promise<FocusPayload> => {
  const [cockpit, runs, queue, portfolio] = await Promise.all([
    dashboardApiClient.getCockpit(signal),
    dashboardApiClient.getRuns(signal),
    dashboardApiClient.getQueue(signal),
    dashboardApiClient.getPortfolioTop(3),
  ]);
  return { cockpit, runs, queue, portfolio };
};

const formatRunStatus = (status: RunSummary['status']): string => {
  if (status === 'running') return 'In progress';
  if (status === 'queued') return 'Queued';
  if (status === 'failed') return 'Failed';
  if (status === 'completed') return 'Completed';
  if (status === 'paused') return 'Paused';
  return 'Stopped';
};

export function FocusPage() {
  const NowIcon = appIcons.now;
  const RiskIcon = appIcons.risk;
  const NextIcon = appIcons.next;
  const PrioritizeIcon = appIcons.prioritize;
  const RunIcon = appIcons.run;
  const PauseIcon = appIcons.pause;
  const FailedIcon = appIcons.failed;
  const BlockedIcon = appIcons.blocked;

  const { data, loading, error, refreshing, refresh } = usePollingQuery(fetchFocusPayload, 5000);
  const [actionBusy, setActionBusy] = useState(false);

  const nowCard = useMemo(
    () => (data ? buildFocusNowCard(data.cockpit, data.runs, data.queue) : null),
    [data],
  );
  const riskCard = useMemo(() => (data ? buildFocusRiskCard(data.runs, data.queue) : null), [data]);
  const nextCard = useMemo(() => (data ? buildFocusNextCard(data.portfolio) : null), [data]);

  const pushMission = async (objective: string) => {
    setActionBusy(true);
    try {
      const conversation = await dashboardApiClient.createConversation('Focus Actions');
      await dashboardApiClient.sendConversationMessage({
        conversationId: conversation.id,
        content: objective,
        mode: 'mission',
      });
    } finally {
      setActionBusy(false);
    }
  };

  const pauseWorker = async () => {
    setActionBusy(true);
    try {
      await dashboardApiClient.pauseWorker();
    } finally {
      setActionBusy(false);
    }
  };

  if (!data) {
    return <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={refresh} />;
  }

  return (
    <section className="minimal-grid minimal-grid--three focus-page">
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={refresh} />

      <Card>
        <CardHeader>
          <CardTitle className="card-title-with-icon">
            <NowIcon className="icon icon-18" aria-hidden="true" />
            <span>What Is Happening Now</span>
          </CardTitle>
          <p className="muted">Live work currently running and urgent queue pressure.</p>
        </CardHeader>
        <CardContent>
          <p className="metric-row">Worker mode: {nowCard?.modeSummary}</p>
          <p className="metric-row">Urgent items waiting: {nowCard?.queuedCriticalCount ?? 0}</p>
          <div className="simple-list">
            {(nowCard?.activeRuns ?? []).length === 0 ? <p className="muted">No active jobs right now.</p> : null}
            {(nowCard?.activeRuns ?? []).map((run) => (
              <div key={run.id} className="simple-list-item">
                <span>{run.objective}</span>
                <span className="muted">{formatRunStatus(run.status)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="card-title-with-icon">
            <RiskIcon className="icon icon-18" aria-hidden="true" />
            <span>Needs Your Attention</span>
          </CardTitle>
          <p className="muted">Failures and blockers that can stall progress.</p>
        </CardHeader>
        <CardContent>
          <p className="metric-row">Open issues needing triage: {riskCard?.needsDecisionCount ?? 0}</p>
          <div className="simple-list">
            {(riskCard?.failedLast24h ?? []).slice(0, 3).map((run) => (
              <div key={run.id} className="simple-list-item">
                <span>{run.objective}</span>
                <span className="status-chip status-chip--failed">
                  <FailedIcon className="icon icon-14" aria-hidden="true" />
                  <span>failed</span>
                </span>
              </div>
            ))}
            {(riskCard?.blockedTasks ?? []).slice(0, 2).map((task) => (
              <div key={task.id} className="simple-list-item">
                <span>{task.title}</span>
                <span className="status-chip status-chip--blocked">
                  <BlockedIcon className="icon icon-14" aria-hidden="true" />
                  <span>blocked</span>
                </span>
              </div>
            ))}
            {(riskCard?.needsDecisionCount ?? 0) === 0 ? <p className="muted">No blockers or failures at the moment.</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="card-title-with-icon">
            <NextIcon className="icon icon-18" aria-hidden="true" />
            <span>Recommended Next Moves</span>
          </CardTitle>
          <p className="muted">Highest expected-value opportunities to run next.</p>
        </CardHeader>
        <CardContent>
          <div className="simple-list">
            {(nextCard?.items ?? []).length === 0 ? <p className="muted">No ranked opportunities available yet.</p> : null}
            {(nextCard?.items ?? []).map((item) => (
              <div key={item.id} className="next-item">
                <div>
                  <p>{item.title}</p>
                  <p className="muted">Expected value: {item.ev.toFixed(2)} · Risk: {item.riskClass}</p>
                </div>
                <div className="next-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={actionBusy}
                    onClick={() => pushMission(`Prioritize portfolio candidate ${item.id}: ${item.title}`)}
                  >
                    <PrioritizeIcon className="icon icon-16" aria-hidden="true" />
                    Prioritize
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={actionBusy}
                    onClick={() => pushMission(`Run top candidate ${item.id}: ${item.title}`)}
                  >
                    <RunIcon className="icon icon-16" aria-hidden="true" />
                    Run
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={actionBusy}
                    onClick={() => void pauseWorker()}
                  >
                    <PauseIcon className="icon icon-16" aria-hidden="true" />
                    Pause
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
