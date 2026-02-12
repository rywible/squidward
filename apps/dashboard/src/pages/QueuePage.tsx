import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { TaskActionButtons } from '../components/TaskActionButtons';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function QueuePage() {
  const { data, error, loading, refreshing, refresh } = usePollingQuery(
    (signal) => dashboardApiClient.getQueue(signal),
    5000,
  );

  return (
    <section>
      <h2>Queue</h2>
      <PageState error={error} loading={loading} onRefresh={() => void refresh()} refreshing={refreshing} />

      <div className="list-grid">
        {(data ?? []).map((task) => (
          <article className="panel" key={task.id}>
            <div className="row-between">
              <h3>{task.title}</h3>
              <span className="pill">{task.priority}</span>
            </div>
            <p className="muted">Task ID: {task.id}</p>
            <p>
              Status: <strong>{task.status}</strong>
            </p>
            <p className="muted">Run: {task.runId}</p>
            <TaskActionButtons entityId={task.id} entityType="task" onDone={refresh} />
          </article>
        ))}
      </div>
    </section>
  );
}
