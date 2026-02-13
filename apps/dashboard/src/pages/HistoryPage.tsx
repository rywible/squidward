import { useMemo, useState } from 'react';
import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { usePollingQuery } from '../hooks/usePollingQuery';
import type { RunSummary } from '../types/dashboard';
import { appIcons } from '../lib/icons';

type Filter = 'all' | 'failed' | 'completed';

const formatTime = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
};

const formatRelative = (iso: string): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const deltaMs = Date.now() - parsed.getTime();
  const deltaMin = Math.round(deltaMs / 60000);
  if (deltaMin < 1) return 'just now';
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d ago`;
};

const formatTriggerType = (trigger: string): string => {
  const normalized = trigger.trim().toLowerCase();
  if (normalized === 'manual') return 'Manual';
  if (normalized === 'chat_reply') return 'Chat';
  if (normalized === 'codex_mission') return 'Mission';
  if (normalized === 'scheduled') return 'Scheduled';
  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
};

const formatRunStatus = (status: RunSummary['status']): string => {
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'running') return 'In progress';
  if (status === 'queued') return 'Queued';
  if (status === 'paused') return 'Paused';
  return 'Stopped';
};

export function HistoryPage() {
  const HistoryIcon = appIcons.history;
  const DoneIcon = appIcons.done;
  const FailedIcon = appIcons.failed;
  const BlockedIcon = appIcons.blocked;
  const ExpandClosedIcon = appIcons.expandClosed;
  const ExpandOpenIcon = appIcons.expandOpen;

  const { data, loading, error, refreshing, refresh } = usePollingQuery((signal) => dashboardApiClient.getRuns(signal), 7000);
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    if (filter === 'all') return rows;
    if (filter === 'failed') return rows.filter((run) => run.status === 'failed');
    return rows.filter((run) => run.status === 'completed');
  }, [data, filter]);

  if (!data) {
    return <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={refresh} />;
  }

  const statusIcon = (status: RunSummary['status']) => {
    if (status === 'failed') return <FailedIcon className="icon icon-14" aria-hidden="true" />;
    if (status === 'paused' || status === 'stopped') return <BlockedIcon className="icon icon-14" aria-hidden="true" />;
    return <DoneIcon className="icon icon-14" aria-hidden="true" />;
  };

  return (
    <section className="minimal-grid history-page">
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={refresh} />
      <Card>
        <CardHeader className="history-head">
          <CardTitle className="card-title-with-icon">
            <HistoryIcon className="icon icon-18" aria-hidden="true" />
            <span>Recent Activity</span>
          </CardTitle>
          <p className="muted">Completed and failed runs with outcomes you can review.</p>
          <div className="history-filters" role="tablist" aria-label="History filters">
            {(['all', 'failed', 'completed'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`history-filter${filter === option ? ' active' : ''}`}
                onClick={() => setFilter(option)}
              >
                {option === 'all' ? 'All' : option === 'failed' ? 'Failed' : 'Completed'}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="history-list">
            {filtered.length === 0 ? <p className="muted">No runs match this filter.</p> : null}
            {filtered.slice(0, 80).map((run: RunSummary) => (
              <button
                key={run.id}
                type="button"
                className={`history-row${expandedRunId === run.id ? ' expanded' : ''}`}
                onClick={() => setExpandedRunId((prev) => (prev === run.id ? null : run.id))}
              >
                <div className="history-row-main">
                  <span className="history-item-main">
                    {statusIcon(run.status)}
                    <span>{run.objective}</span>
                  </span>
                  <span className="history-item-end">
                    <span className={`status-chip status-chip--${run.status}`}>{formatRunStatus(run.status)}</span>
                    {expandedRunId === run.id ? (
                      <ExpandOpenIcon className="icon icon-14 history-expand-open" aria-hidden="true" />
                    ) : (
                      <ExpandClosedIcon className="icon icon-14 history-expand-closed" aria-hidden="true" />
                    )}
                  </span>
                </div>
                <div className="history-row-sub">
                  <span>{formatRelative(run.updatedAt)}</span>
                  <span>{formatTriggerType(run.triggerType)}</span>
                  {typeof run.durationMs === 'number' ? <span>{Math.round(run.durationMs / 1000)}s</span> : null}
                </div>
                {expandedRunId === run.id ? (
                  <div className="history-row-detail">
                    <p className="muted">Status: {formatRunStatus(run.status)}</p>
                    <p className="muted">{formatTime(run.updatedAt)}</p>
                    <p className="muted">Run ID: {run.id}</p>
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
