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

export function HistoryPage() {
  const HistoryIcon = appIcons.history;
  const DoneIcon = appIcons.done;
  const FailedIcon = appIcons.failed;
  const BlockedIcon = appIcons.blocked;
  const ExpandClosedIcon = appIcons.expandClosed;
  const ExpandOpenIcon = appIcons.expandOpen;

  const { data, loading, error, refreshing, refresh } = usePollingQuery((signal) => dashboardApiClient.getRuns(signal), 7000);
  const [filter, setFilter] = useState<Filter>('all');

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
    <section className="minimal-grid">
      <PageState loading={loading} error={error} refreshing={refreshing} onRefresh={refresh} />
      <Card>
        <CardHeader className="history-head">
          <CardTitle className="card-title-with-icon">
            <HistoryIcon className="icon icon-18" aria-hidden="true" />
            <span>History</span>
          </CardTitle>
          <div className="history-filters" role="tablist" aria-label="History filters">
            {(['all', 'failed', 'completed'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`history-filter${filter === option ? ' active' : ''}`}
                onClick={() => setFilter(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="simple-list">
            {filtered.length === 0 ? <p className="muted">No runs for this filter.</p> : null}
            {filtered.slice(0, 80).map((run: RunSummary) => (
              <details key={run.id} className="history-item">
                <summary>
                  <span className="history-item-main">
                    {statusIcon(run.status)}
                    <span>{run.objective}</span>
                  </span>
                  <span className="history-item-end">
                    <span className={`status-chip status-chip--${run.status}`}>{run.status}</span>
                    <span className="history-expand">
                      <ExpandClosedIcon className="icon icon-14 history-expand-closed" aria-hidden="true" />
                      <ExpandOpenIcon className="icon icon-14 history-expand-open" aria-hidden="true" />
                    </span>
                  </span>
                </summary>
                <p className="muted">{formatTime(run.updatedAt)}</p>
                <p className="muted">Run ID: {run.id}</p>
              </details>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
