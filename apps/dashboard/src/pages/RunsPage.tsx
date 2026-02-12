import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { TaskActionButtons } from '../components/TaskActionButtons';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function RunsPage() {
  const { data, error, loading, refreshing, refresh } = usePollingQuery(
    (signal) => dashboardApiClient.getRuns(signal),
    5000,
  );

  return (
    <section>
      <h2>Runs</h2>
      <PageState error={error} loading={loading} onRefresh={() => void refresh()} refreshing={refreshing} />

      <div className="table-wrap panel">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Objective</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((run) => (
              <tr key={run.id}>
                <td>{run.id}</td>
                <td>{run.objective}</td>
                <td>{run.status}</td>
                <td>{run.triggerType}</td>
                <td>{new Date(run.updatedAt).toLocaleString()}</td>
                <td>
                  <TaskActionButtons entityId={run.id} entityType="run" onDone={refresh} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
