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

  const hasRisk = (riskCard?.needsDecisionCount ?? 0) > 0;
  const topOpportunity = nextCard?.items?.[0] ?? null;
  const topActiveRun = nowCard?.activeRuns?.[0] ?? null;

  return (
    <section className="minimal-grid focus-page">
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={refresh} />

      <Card className="focus-priority-card">
        <CardHeader className="focus-priority-head">
          <CardTitle className="card-title-with-icon">
            <RiskIcon className="icon icon-18" aria-hidden="true" />
            <span>Start Here</span>
          </CardTitle>
          <Button type="button" size="sm" variant="ghost" disabled={actionBusy} onClick={() => void pauseWorker()}>
            <PauseIcon className="icon icon-16" aria-hidden="true" />
            Pause Worker
          </Button>
        </CardHeader>
        <CardContent className="focus-priority-body">
          <div className="focus-kpis">
            <span className="status-chip">Open issues: {riskCard?.needsDecisionCount ?? 0}</span>
            <span className="status-chip">In progress: {nowCard?.activeRuns?.length ?? 0}</span>
            <span className="status-chip">Urgent queue: {nowCard?.queuedCriticalCount ?? 0}</span>
          </div>
          {hasRisk ? (
            <div className="focus-step">
              <p className="focus-step-title">1. Resolve blockers before starting anything new.</p>
              <p className="muted">You have {riskCard?.needsDecisionCount ?? 0} failed or blocked items.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => pushMission('Review current failed and blocked items, then propose a triage plan')}
              >
                <PrioritizeIcon className="icon icon-16" aria-hidden="true" />
                Triage Issues
              </Button>
            </div>
          ) : topActiveRun ? (
            <div className="focus-step">
              <p className="focus-step-title">1. Keep current work moving.</p>
              <p className="muted">{topActiveRun.objective}</p>
            </div>
          ) : topOpportunity ? (
            <div className="focus-step">
              <p className="focus-step-title">1. Run the best next opportunity.</p>
              <p className="muted">{topOpportunity.title}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => pushMission(`Run top candidate ${topOpportunity.id}: ${topOpportunity.title}`)}
              >
                <RunIcon className="icon icon-16" aria-hidden="true" />
                Run Top Opportunity
              </Button>
            </div>
          ) : (
            <div className="focus-step">
              <p className="focus-step-title">1. No immediate action needed.</p>
              <p className="muted">The system is stable. Wait for the next task or send a mission from chat.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="focus-grid">
      <Card>
        <CardHeader>
          <CardTitle className="card-title-with-icon">
            <NowIcon className="icon icon-18" aria-hidden="true" />
            <span>In Progress</span>
          </CardTitle>
          <p className="muted">Work currently running and queue pressure.</p>
        </CardHeader>
        <CardContent>
          <p className="metric-row">Worker mode: {nowCard?.modeSummary}</p>
          <div className="simple-list">
            {(nowCard?.activeRuns ?? []).length === 0 ? <p className="muted">No active jobs right now.</p> : null}
            {(nowCard?.activeRuns ?? []).map((run) => (
              <div key={run.id} className="simple-list-item">
                <span>{run.objective}</span>
                <span className="muted">{formatRunStatus(run.status)}</span>
              </div>
            ))}
            {(riskCard?.blockedTasks ?? []).slice(0, 2).map((task) => (
              <div key={task.id} className="simple-list-item">
                <span>{task.title}</span>
                <span className="status-chip status-chip--blocked">
                  <BlockedIcon className="icon icon-14" aria-hidden="true" />
                  <span>Blocked</span>
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="card-title-with-icon">
            <NextIcon className="icon icon-18" aria-hidden="true" />
            <span>Up Next</span>
          </CardTitle>
          <p className="muted">Ranked opportunities to improve reliability and performance.</p>
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
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      </div>

      <Card className="focus-risk-card">
        <CardHeader>
          <CardTitle className="card-title-with-icon">
            <RiskIcon className="icon icon-18" aria-hidden="true" />
            <span>Needs Your Attention</span>
          </CardTitle>
          <p className="muted">Failures from the last 24h.</p>
        </CardHeader>
        <CardContent>
          <div className="simple-list">
            {(riskCard?.failedLast24h ?? []).slice(0, 3).map((run) => (
              <div key={run.id} className="simple-list-item">
                <span>{run.objective}</span>
                <span className="status-chip status-chip--failed">
                  <FailedIcon className="icon icon-14" aria-hidden="true" />
                  <span>Failed</span>
                </span>
              </div>
            ))}
            {(riskCard?.failedLast24h ?? []).length === 0 ? <p className="muted">No recent failures.</p> : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
