import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PerfScientistExperimentsPage() {
  const experiments = usePollingQuery(() => dashboardApiClient.getPerfScientistExperiments(undefined, undefined), 20000);

  return (
    <section>
      <h2>Perf Experiments</h2>
      <p className="muted">Experiment lifecycle, trigger source, branch, and candidate counts.</p>
      <PageState
        loading={experiments.loading}
        error={experiments.error}
        refreshing={experiments.refreshing}
        onRefresh={() => void experiments.refresh()}
      />

      {!experiments.loading && !experiments.error ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Branch</th>
                <th>Candidates</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {(experiments.data?.items ?? []).map((exp) => (
                <tr key={exp.id}>
                  <td>{exp.id.slice(0, 12)}</td>
                  <td>{exp.status}</td>
                  <td>{exp.triggerSource}</td>
                  <td>{exp.branchName ?? '-'}</td>
                  <td>{exp.candidateCount}</td>
                  <td>{new Date(exp.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
