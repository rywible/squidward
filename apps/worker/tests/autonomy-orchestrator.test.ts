import { describe, expect, it } from "bun:test";
import { Database } from "@squidward/db";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutonomyOrchestrator } from "../src/autonomy-orchestrator";
import type { WorkerTaskPayload } from "../src/runtime";

const createDb = (): Database => {
  const dir = mkdtempSync(join(tmpdir(), "squidward-autonomy-"));
  const db = new Database(join(dir, "agent.db"), { create: true, strict: false });
  const migrationPath = join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
  return db;
};

describe("AutonomyOrchestrator", () => {
  it("queues low-risk high-EV bugfix candidates within budget", async () => {
    const db = createDb();
    db.query(
      `INSERT INTO portfolio_candidates
       (id, source_type, source_ref, title, summary, risk_class, effort_class, evidence_links, created_at, updated_at)
       VALUES ('cand_a', 'task_queue', 'src/a.ts', 'Fix flaky parser test', 'bugfix candidate', 'low', 'small', '[]', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO portfolio_scores
       (id, candidate_id, impact, confidence, urgency, risk, effort, ev, reasons_json, scored_at)
       VALUES ('score_a', 'cand_a', 2, 1.2, 1.1, 0.8, 0.6, 2.1, '{}', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO portfolio_decisions
       (id, score_id, decision, policy_mode, threshold, reason, queued_task_id, created_at)
       VALUES ('dec_a', 'score_a', 'queued_draft', 'balanced', 1.25, 'eligible', NULL, datetime('now'))`
    ).run();

    const enqueued: Array<WorkerTaskPayload> = [];
    const orchestrator = new AutonomyOrchestrator(
      db,
      async (input) => {
        enqueued.push(input.payload);
        return { id: "task_1", coalesced: false };
      },
      {
        enabled: true,
        scope: ["perf", "bugfix"],
        hourlyBudget: 2,
        maxConcurrentMissions: 2,
        minEv: 1.25,
        requireLowRisk: true,
        maxAutoPrFiles: 8,
        maxAutoPrLoc: 250,
        interactiveQueueBlockThreshold: 4,
        primaryRepoPath: "/Users/ryanwible/projects/wrela",
        perfRepoPath: "/Users/ryanwible/projects/wrela",
        perfManifestPath: "/Users/ryanwible/projects/wrela/benchmarks/macro/bench.toml",
      }
    );

    const result = await orchestrator.planHourly(new Date(), 0);
    expect(result.queued).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.taskType).toBe("codex_mission");
    expect(enqueued[0]?.autonomous).toBe(true);
  });

  it("records budget_exhausted when hourly budget is zero", async () => {
    const db = createDb();
    db.query(
      `INSERT INTO portfolio_candidates
       (id, source_type, source_ref, title, summary, risk_class, effort_class, evidence_links, created_at, updated_at)
       VALUES ('cand_b', 'task_queue', 'src/b.ts', 'Fix runtime bug', 'bugfix candidate', 'low', 'small', '[]', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO portfolio_scores
       (id, candidate_id, impact, confidence, urgency, risk, effort, ev, reasons_json, scored_at)
       VALUES ('score_b', 'cand_b', 2, 1.2, 1.1, 0.8, 0.6, 2.0, '{}', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO portfolio_decisions
       (id, score_id, decision, policy_mode, threshold, reason, queued_task_id, created_at)
       VALUES ('dec_b', 'score_b', 'queued_draft', 'balanced', 1.25, 'eligible', NULL, datetime('now'))`
    ).run();
    db.query(
      `INSERT OR REPLACE INTO autonomy_settings (id, enabled, hourly_budget, updated_at)
       VALUES ('global', 1, 0, datetime('now'))`
    ).run();

    const orchestrator = new AutonomyOrchestrator(
      db,
      async () => ({ id: "task_unused", coalesced: false }),
      {
        enabled: true,
        scope: ["perf", "bugfix"],
        hourlyBudget: 2,
        maxConcurrentMissions: 2,
        minEv: 1.25,
        requireLowRisk: true,
        maxAutoPrFiles: 8,
        maxAutoPrLoc: 250,
        interactiveQueueBlockThreshold: 4,
        primaryRepoPath: "/Users/ryanwible/projects/wrela",
        perfRepoPath: "/Users/ryanwible/projects/wrela",
        perfManifestPath: "/Users/ryanwible/projects/wrela/benchmarks/macro/bench.toml",
      }
    );

    const result = await orchestrator.planHourly(new Date(), 0);
    expect(result.queued).toBe(0);
    const row = db
      .query(
        `SELECT reason
         FROM autonomy_decisions
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as { reason: string } | null;
    expect(row?.reason).toBe("budget_exhausted");
  });
});

