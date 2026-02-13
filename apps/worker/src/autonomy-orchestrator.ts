import { Database } from "@squidward/db";
import { existsSync } from "node:fs";
import type { EnqueueInput } from "./queue";
import type { WorkerTaskPayload } from "./runtime";

type SqlRecord = Record<string, unknown>;

const nowIso = (): string => new Date().toISOString();

const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const truncateToHour = (now: Date): Date => {
  const copy = new Date(now.getTime());
  copy.setMinutes(0, 0, 0);
  return copy;
};

const classifyCategory = (source: "portfolio" | "perf", text: string): "perf" | "bugfix" | "other" => {
  if (source === "perf") return "perf";
  const normalized = text.toLowerCase();
  if (/\b(perf|latency|p95|p99|throughput|benchmark|alloc|optimi[sz]e)\b/.test(normalized)) return "perf";
  if (/\b(fix|bug|flaky|failure|failed|regression|incident|error|crash|panic|test)\b/.test(normalized)) return "bugfix";
  return "other";
};

export interface AutonomyPlannerConfig {
  enabled: boolean;
  scope: Array<"perf" | "bugfix">;
  hourlyBudget: number;
  maxConcurrentMissions: number;
  minEv: number;
  requireLowRisk: boolean;
  maxAutoPrFiles: number;
  maxAutoPrLoc: number;
  interactiveQueueBlockThreshold: number;
  primaryRepoPath: string;
  perfRepoPath: string;
  perfManifestPath: string;
}

interface Candidate {
  id: string;
  source: "portfolio" | "perf";
  title: string;
  summary: string;
  ev: number;
  riskClass: "low" | "medium" | "high";
  category: "perf" | "bugfix" | "other";
}

interface RuntimeSettings {
  enabled: boolean;
  hourlyBudget: number;
}

const reasonDecisionMap = {
  filtered_scope: "filtered_scope",
  below_ev_threshold: "below_ev_threshold",
  risk_blocked: "risk_blocked",
  budget_exhausted: "budget_exhausted",
  concurrent_limit: "concurrent_limit",
  queued_for_execution: "queued_for_execution",
} as const;

export class AutonomyOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly enqueue: (input: EnqueueInput<WorkerTaskPayload>) => Promise<{ id: string; coalesced: boolean }>,
    private readonly config: AutonomyPlannerConfig
  ) {}

  private loadSettings(): RuntimeSettings {
    this.db
      .query(
        `INSERT OR IGNORE INTO autonomy_settings (id, enabled, hourly_budget, updated_at)
         VALUES ('global', ?, ?, ?)`
      )
      .run(this.config.enabled ? 1 : 0, this.config.hourlyBudget, nowIso());

    const row = this.db
      .query(`SELECT enabled, hourly_budget FROM autonomy_settings WHERE id='global' LIMIT 1`)
      .get() as SqlRecord | null;
    return {
      enabled: row ? asNumber(row.enabled, 1) === 1 : this.config.enabled,
      hourlyBudget: Math.max(0, Math.min(20, asNumber(row?.hourly_budget, this.config.hourlyBudget))),
    };
  }

  private ensureWindow(now: Date, budget: number): { windowStart: string; windowEnd: string; consumed: number } {
    const windowStartDate = truncateToHour(now);
    const windowEndDate = new Date(windowStartDate.getTime() + 60 * 60 * 1000);
    const windowStart = windowStartDate.toISOString();
    const windowEnd = windowEndDate.toISOString();

    this.db
      .query(
        `INSERT OR IGNORE INTO autonomy_windows
         (id, window_start, window_end, budget, consumed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(`window:${windowStart}`, windowStart, windowEnd, budget, nowIso());

    this.db
      .query(`UPDATE autonomy_windows SET budget=? WHERE window_start=?`)
      .run(budget, windowStart);

    const consumedRow = this.db
      .query(
        `SELECT COUNT(*) AS count
         FROM autonomy_decisions
         WHERE budget_window=? AND decision='queued_for_execution'`
      )
      .get(windowStart) as SqlRecord;
    const consumed = asNumber(consumedRow.count, 0);
    this.db
      .query(`UPDATE autonomy_windows SET consumed=? WHERE window_start=?`)
      .run(consumed, windowStart);

    return { windowStart, windowEnd, consumed };
  }

  private listCandidates(limit = 50): Candidate[] {
    const portfolioRows = this.db
      .query(
        `WITH latest_scores AS (
           SELECT candidate_id, MAX(scored_at) AS scored_at
           FROM portfolio_scores
           GROUP BY candidate_id
         ),
         latest_decisions AS (
           SELECT ps.candidate_id, MAX(pd.created_at) AS decided_at
           FROM portfolio_scores ps
           JOIN portfolio_decisions pd ON pd.score_id = ps.id
           GROUP BY ps.candidate_id
         )
         SELECT pc.id, pc.title, pc.summary, pc.risk_class, ps.ev
         FROM latest_scores ls
         JOIN portfolio_scores ps ON ps.candidate_id = ls.candidate_id AND ps.scored_at = ls.scored_at
         JOIN portfolio_candidates pc ON pc.id = ls.candidate_id
         JOIN latest_decisions ld ON ld.candidate_id = pc.id
         ORDER BY ps.ev DESC, pc.updated_at DESC
         LIMIT ?`
      )
      .all(limit) as SqlRecord[];

    const perfRows = this.db
      .query(
        `SELECT c.id, c.title, c.hypothesis, c.risk_class, d.score
         FROM perf_candidates c
         JOIN perf_decisions d ON d.candidate_id = c.id
         WHERE d.id IN (
           SELECT d2.id
           FROM perf_decisions d2
           WHERE d2.candidate_id = c.id
           ORDER BY d2.created_at DESC
           LIMIT 1
         )
           AND d.decision = 'recommend'
         ORDER BY d.score DESC, d.created_at DESC
         LIMIT ?`
      )
      .all(limit) as SqlRecord[];

    const portfolio = portfolioRows.map((row): Candidate => {
      const title = String(row.title);
      const summary = String(row.summary ?? "");
      return {
        id: String(row.id),
        source: "portfolio",
        title,
        summary,
        ev: asNumber(row.ev, 0),
        riskClass: (String(row.risk_class) as Candidate["riskClass"]) || "medium",
        category: classifyCategory("portfolio", `${title} ${summary}`),
      };
    });

    const perf = perfRows.map((row): Candidate => {
      const title = String(row.title);
      const summary = String(row.hypothesis ?? "");
      return {
        id: String(row.id),
        source: "perf",
        title,
        summary,
        ev: asNumber(row.score, 0),
        riskClass: (String(row.risk_class) as Candidate["riskClass"]) || "medium",
        category: classifyCategory("perf", `${title} ${summary}`),
      };
    });

    return [...perf, ...portfolio]
      .sort((a, b) => b.ev - a.ev)
      .slice(0, limit);
  }

  private async recordDecision(input: {
    candidateRef: string;
    source: "portfolio" | "perf";
    decision: string;
    reason: string;
    ev: number;
    riskClass: "low" | "medium" | "high";
    budgetWindow: string;
    queuedTaskId?: string;
  }): Promise<void> {
    const queuedTaskId = input.queuedTaskId
      ? ((this.db
          .query(`SELECT id FROM task_queue WHERE id=? LIMIT 1`)
          .get(input.queuedTaskId) as SqlRecord | null)
          ? input.queuedTaskId
          : null)
      : null;
    this.db
      .query(
        `INSERT INTO autonomy_decisions
         (id, candidate_ref, source, decision, reason, ev, risk_class, budget_window, queued_task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.candidateRef,
        input.source,
        input.decision,
        input.reason,
        input.ev,
        input.riskClass,
        input.budgetWindow,
        queuedTaskId,
        nowIso()
      );
  }

  async planHourly(now: Date, interactivePending: number): Promise<{ queued: number; evaluated: number }> {
    const settings = this.loadSettings();
    if (!settings.enabled) {
      return { queued: 0, evaluated: 0 };
    }

    if (interactivePending >= this.config.interactiveQueueBlockThreshold) {
      this.db
        .query(
          `INSERT INTO autonomy_failures (id, stage, reason, details_json, created_at)
           VALUES (?, 'planner', ?, ?, ?)`
        )
        .run(crypto.randomUUID(), reasonDecisionMap.concurrent_limit, JSON.stringify({ interactivePending }), nowIso());
      return { queued: 0, evaluated: 0 };
    }

    const runningRow = this.db
      .query(`SELECT COUNT(*) AS count FROM task_queue WHERE status='running' AND task_type='codex_mission'`)
      .get() as SqlRecord;
    const running = asNumber(runningRow.count, 0);

    const window = this.ensureWindow(now, settings.hourlyBudget);
    const budgetRemaining = Math.max(0, settings.hourlyBudget - window.consumed);
    const concurrencyRemaining = Math.max(0, this.config.maxConcurrentMissions - running);
    const available = Math.min(budgetRemaining, concurrencyRemaining);

    const candidates = this.listCandidates(60);
    let queued = 0;

    for (const candidate of candidates) {
      const candidateRef = `${candidate.source}:${candidate.id}`;
      if (!this.config.scope.includes(candidate.category as "perf" | "bugfix")) {
        await this.recordDecision({
          candidateRef,
          source: candidate.source,
          decision: "dropped",
          reason: reasonDecisionMap.filtered_scope,
          ev: candidate.ev,
          riskClass: candidate.riskClass,
          budgetWindow: window.windowStart,
        });
        continue;
      }

      if (candidate.ev < this.config.minEv) {
        await this.recordDecision({
          candidateRef,
          source: candidate.source,
          decision: "dropped",
          reason: reasonDecisionMap.below_ev_threshold,
          ev: candidate.ev,
          riskClass: candidate.riskClass,
          budgetWindow: window.windowStart,
        });
        continue;
      }

      if (this.config.requireLowRisk && candidate.riskClass !== "low") {
        await this.recordDecision({
          candidateRef,
          source: candidate.source,
          decision: "dropped",
          reason: reasonDecisionMap.risk_blocked,
          ev: candidate.ev,
          riskClass: candidate.riskClass,
          budgetWindow: window.windowStart,
        });
        continue;
      }

      if (queued >= available) {
        await this.recordDecision({
          candidateRef,
          source: candidate.source,
          decision: "dropped",
          reason: reasonDecisionMap.budget_exhausted,
          ev: candidate.ev,
          riskClass: candidate.riskClass,
          budgetWindow: window.windowStart,
        });
        continue;
      }

      const result = await this.enqueue({
        dedupeKey: `autonomy:${candidate.source}:${candidate.id}:${window.windowStart}`,
        priority: "P1",
        payload: {
          taskType: "codex_mission",
          runId: `run_auto_${candidate.source}_${candidate.id}_${Date.now()}`,
          domain: "autonomy",
          objective: `[Autonomy] ${candidate.title}`,
          requestText: `${candidate.summary}\nScope: ${candidate.category}. Generate a small safe change and open a draft PR.`,
          repoPath: this.config.primaryRepoPath,
          cwd: this.config.primaryRepoPath,
          title: `Autonomy mission ${candidate.source}:${candidate.id}`,
          autonomous: true,
          category: candidate.category as "perf" | "bugfix",
          expectedEvidence: [`candidate:${candidate.source}:${candidate.id}`],
          maxFiles: this.config.maxAutoPrFiles,
          maxLoc: this.config.maxAutoPrLoc,
          candidateId: candidate.id,
        },
      });

      await this.recordDecision({
        candidateRef,
        source: candidate.source,
        decision: "queued_for_execution",
        reason: reasonDecisionMap.queued_for_execution,
        ev: candidate.ev,
        riskClass: candidate.riskClass,
        budgetWindow: window.windowStart,
        queuedTaskId: result.id,
      });

      if (candidate.source === "portfolio") {
        const taskExists = this.db
          .query(`SELECT id FROM task_queue WHERE id=? LIMIT 1`)
          .get(result.id) as SqlRecord | null;
        if (taskExists) {
          this.db
            .query(
              `UPDATE portfolio_decisions
               SET queued_task_id=?
               WHERE id = (
                 SELECT pd.id
                 FROM portfolio_decisions pd
                 JOIN portfolio_scores ps ON ps.id = pd.score_id
                 WHERE ps.candidate_id = ?
                 ORDER BY pd.created_at DESC
                 LIMIT 1
               )`
            )
            .run(result.id, candidate.id);
        }
      }

      queued += 1;
    }

    this.db
      .query(`UPDATE autonomy_windows SET consumed=? WHERE window_start=?`)
      .run(window.consumed + queued, window.windowStart);

    return { queued, evaluated: candidates.length };
  }

  async checkApsReadiness(now: Date): Promise<{ ok: boolean; reason: string }> {
    if (!this.config.enabled) {
      return { ok: false, reason: "autonomy_disabled" };
    }
    if (!existsSync(this.config.perfRepoPath)) {
      const reason = "repo_path_missing";
      this.recordFailure("aps_readiness", reason, { perfRepoPath: this.config.perfRepoPath, at: now.toISOString() });
      return { ok: false, reason };
    }
    if (!existsSync(this.config.perfManifestPath)) {
      const reason = "manifest_missing";
      this.recordFailure("aps_readiness", reason, { perfManifestPath: this.config.perfManifestPath, at: now.toISOString() });
      return { ok: false, reason };
    }

    const proc = Bun.spawnSync(["cargo", "run", "-q", "--bin", "wrela", "--", "--version"], {
      cwd: this.config.perfRepoPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((proc.exitCode ?? 1) !== 0) {
      const reason = "cli_not_buildable";
      this.recordFailure("aps_readiness", reason, {
        exitCode: proc.exitCode ?? 1,
        stderr: Buffer.from(proc.stderr).toString("utf8").slice(0, 1000),
      });
      return { ok: false, reason };
    }

    const hasBaseline = this.db
      .query(`SELECT id FROM perf_baselines ORDER BY created_at DESC LIMIT 1`)
      .get() as SqlRecord | null;
    if (!hasBaseline) {
      await this.enqueue({
        dedupeKey: "aps_readiness_seed_baseline",
        priority: "P1",
        payload: {
          taskType: "perf_baseline_nightly",
          runId: `run_perf_seed_${Date.now()}`,
          profile: "standard",
          triggerSource: "aps_readiness",
          title: "APS readiness baseline seed",
        },
      });
    }

    const recentExperiment = this.db
      .query(`SELECT id FROM perf_experiments WHERE started_at >= datetime('now','-24 hour') LIMIT 1`)
      .get() as SqlRecord | null;
    if (!recentExperiment) {
      await this.enqueue({
        dedupeKey: "aps_readiness_generate_candidates",
        priority: "P1",
        payload: {
          taskType: "perf_generate_candidates",
          runId: `run_perf_generate_seed_${Date.now()}`,
          triggerSource: "aps_readiness",
          title: "APS readiness candidate generation seed",
        },
      });
    }
    return { ok: true, reason: "ready" };
  }

  recordFailure(stage: string, reason: string, details: Record<string, unknown>): void {
    this.db
      .query(
        `INSERT INTO autonomy_failures (id, stage, reason, details_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), stage, reason, JSON.stringify(details), nowIso());
  }
}
