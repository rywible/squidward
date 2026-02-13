import { describe, expect, it } from 'bun:test';
import type { CockpitSnapshot, PortfolioCandidate, QueueTask, RunSummary } from '../types/dashboard';
import { buildFocusNextCard, buildFocusNowCard, buildFocusRiskCard } from './focus-model';

describe('focus model mapping', () => {
  it('builds Now card with active runs and queued critical count', () => {
    const cockpit: CockpitSnapshot = {
      generatedAt: new Date().toISOString(),
      activeRuns: 1,
      queuedTasks: 3,
      incidentsOpen: 0,
      approvalsPending: 0,
      health: 'ok',
    };
    const runs: RunSummary[] = [
      {
        id: 'run_1',
        objective: 'ship fix',
        triggerType: 'manual',
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rollbackFlag: false,
      },
    ];
    const queue: QueueTask[] = [
      {
        id: 'q1',
        runId: 'r1',
        title: 'critical task',
        priority: 'urgent',
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const now = buildFocusNowCard(cockpit, runs, queue);
    expect(now.activeRuns).toHaveLength(1);
    expect(now.queuedCriticalCount).toBe(1);
    expect(now.modeSummary).toContain('Active');
  });

  it('builds Risk card from failed and blocked items', () => {
    const now = new Date().toISOString();
    const runs: RunSummary[] = [
      {
        id: 'run_fail',
        objective: 'bad deploy',
        triggerType: 'manual',
        status: 'failed',
        startedAt: now,
        updatedAt: now,
        rollbackFlag: false,
      },
    ];
    const queue: QueueTask[] = [
      {
        id: 'q_block',
        runId: 'r_block',
        title: 'waiting approval',
        priority: 'high',
        status: 'blocked',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const risk = buildFocusRiskCard(runs, queue);
    expect(risk.failedLast24h).toHaveLength(1);
    expect(risk.blockedTasks).toHaveLength(1);
    expect(risk.needsDecisionCount).toBe(2);
  });

  it('builds Next card from top EV candidates', () => {
    const candidates: PortfolioCandidate[] = [
      {
        id: 'cand_1',
        sourceType: 'task_queue',
        sourceRef: 'ref',
        title: 'speed up parser',
        summary: 'summary',
        riskClass: 'low',
        effortClass: 'small',
        evidenceLinks: [],
        score: { impact: 2, confidence: 2, urgency: 1, risk: 1, effort: 1, ev: 4.2 },
        scoredAt: new Date().toISOString(),
      },
    ];

    const next = buildFocusNextCard(candidates);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.ev).toBe(4.2);
  });
});
