import type { CockpitSnapshot, PortfolioCandidate, QueueTask, RunSummary } from '../types/dashboard';

export interface FocusNowCardModel {
  activeRuns: RunSummary[];
  queuedCriticalCount: number;
  modeSummary: string;
}

export interface FocusRiskCardModel {
  failedLast24h: RunSummary[];
  blockedTasks: QueueTask[];
  needsDecisionCount: number;
}

export interface FocusNextItem {
  id: string;
  title: string;
  ev: number;
  riskClass: string;
}

export interface FocusNextCardModel {
  items: FocusNextItem[];
}

const isRecent = (iso: string, hours: number): boolean => {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= hours * 60 * 60 * 1000;
};

export const buildFocusNowCard = (
  cockpit: CockpitSnapshot | null,
  runs: RunSummary[],
  queue: QueueTask[],
): FocusNowCardModel => {
  const activeRuns = runs.filter((run) => run.status === 'running').slice(0, 3);
  const queuedCriticalCount = queue.filter(
    (task) => (task.status === 'queued' || task.status === 'running') && (task.priority === 'urgent' || task.priority === 'high'),
  ).length;

  const modeSummary =
    activeRuns.length > 0
      ? `Active with ${activeRuns.length} running`
      : cockpit && cockpit.queuedTasks > 0
        ? `Idle with ${cockpit.queuedTasks} queued`
        : 'Idle';

  return { activeRuns, queuedCriticalCount, modeSummary };
};

export const buildFocusRiskCard = (runs: RunSummary[], queue: QueueTask[]): FocusRiskCardModel => {
  const failedLast24h = runs.filter((run) => run.status === 'failed' && isRecent(run.updatedAt, 24)).slice(0, 5);
  const blockedTasks = queue.filter((task) => task.status === 'blocked').slice(0, 5);
  return {
    failedLast24h,
    blockedTasks,
    needsDecisionCount: failedLast24h.length + blockedTasks.length,
  };
};

export const buildFocusNextCard = (portfolio: PortfolioCandidate[]): FocusNextCardModel => ({
  items: portfolio.slice(0, 3).map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    ev: candidate.score.ev,
    riskClass: candidate.riskClass,
  })),
});

