import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function WrelaLearningPage() {
  const repoPath = '/Users/ryanwible/projects/wrela';
  const status = usePollingQuery(() => dashboardApiClient.getRepoLearningStatus(repoPath), 8000);
  const facts = usePollingQuery(() => dashboardApiClient.getRepoLearningFacts(repoPath), 8000);

  const error = status.error ?? facts.error;
  const loading = status.loading || facts.loading;
  const refreshing = status.refreshing || facts.refreshing;

  return (
    <section>
      <h2>Wrela Learning</h2>
      <p className="muted">Repo-specific competence, failure patterns, and workflow memory.</p>
      <PageState
        error={error}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => {
          void status.refresh();
          void facts.refresh();
        }}
      />

      <div className="grid cols-3">
        <article className="panel">
          <h3>Competence Score</h3>
          <p>{status.data ? status.data.scoreTotal.toFixed(3) : 'n/a'}</p>
        </article>
        <article className="panel">
          <h3>Top Strengths</h3>
          <p>{status.data?.topStrengths?.join(', ') || 'n/a'}</p>
        </article>
        <article className="panel">
          <h3>Top Risks</h3>
          <p>{status.data?.topRisks?.join(', ') || 'n/a'}</p>
        </article>
      </div>

      <div className="table-wrap panel">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Key</th>
              <th>Confidence</th>
              <th>Evidence</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(facts.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.factType}</td>
                <td>{item.key}</td>
                <td>{Math.round(item.confidence * 100)}%</td>
                <td>{item.evidenceCount}</td>
                <td>{new Date(item.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
