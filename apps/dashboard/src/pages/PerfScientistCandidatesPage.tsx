import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PerfScientistCandidatesPage() {
  const candidates = usePollingQuery(() => dashboardApiClient.getPerfScientistCandidates(undefined, undefined), 15000);

  const runAction = async (candidateId: string, action: 'rerun' | 'open_draft_pr' | 'reject' | 'promote_priority') => {
    await dashboardApiClient.perfScientistAction(candidateId, action);
    await candidates.refresh();
  };

  return (
    <section>
      <h2>Perf Candidates</h2>
      <p className="muted">Candidate hypotheses, scores, and operator actions.</p>
      <PageState
        loading={candidates.loading}
        error={candidates.error}
        refreshing={candidates.refreshing}
        onRefresh={() => void candidates.refresh()}
      />

      {!candidates.loading && !candidates.error ? (
        <div className="card-grid">
          {(candidates.data?.items ?? []).map((candidate) => (
            <article key={candidate.id} className="card">
              <h3>{candidate.title}</h3>
              <p>{candidate.hypothesis}</p>
              <p className="muted">
                {candidate.changeClass} | risk={candidate.riskClass} | status={candidate.status}
              </p>
              <p className="muted">targets: {candidate.targetPaths.join(', ') || '-'}</p>
              {candidate.latestDecision ? (
                <p>
                  decision={candidate.latestDecision.decision} score={candidate.latestDecision.score.toFixed(3)} ({candidate.latestDecision.reason})
                </p>
              ) : (
                <p>no decision yet</p>
              )}
              <div className="action-buttons">
                <button className="btn" type="button" onClick={() => void runAction(candidate.id, 'rerun')}>
                  rerun
                </button>
                <button className="btn" type="button" onClick={() => void runAction(candidate.id, 'promote_priority')}>
                  prioritize
                </button>
                <button className="btn" type="button" onClick={() => void runAction(candidate.id, 'open_draft_pr')}>
                  open draft PR
                </button>
                <button className="btn ghost" type="button" onClick={() => void runAction(candidate.id, 'reject')}>
                  reject
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
