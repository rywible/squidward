import { describe, expect, it } from "bun:test";
import { Database } from "@squidward/db";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeEv, MoonshotEngine } from "../src/moonshot";

const createDb = (): Database => {
  const dir = mkdtempSync(join(tmpdir(), "squidward-moonshot-"));
  const db = new Database(join(dir, "agent.db"), { create: true, strict: false });
  const migrationPath = join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
  return db;
};

describe("computeEv", () => {
  it("is monotonic with higher impact and lower risk", () => {
    const low = computeEv({ impact: 1, confidence: 1, urgency: 1, risk: 2, effort: 1 });
    const high = computeEv({ impact: 2, confidence: 1, urgency: 1, risk: 1, effort: 1 });
    expect(high.ev).toBeGreaterThan(low.ev);
  });
});

describe("MoonshotEngine", () => {
  it("writes ranked portfolio scores and decisions", () => {
    const db = createDb();
    db.query(
      `INSERT INTO task_queue (id, source_id, task_type, payload_json, priority, status, created_at, updated_at)
       VALUES ('task_1', 'seed', 'maintenance', '{"title":"Fix flaky test","sourceRef":"src/a.ts"}', 2, 'queued', datetime('now'), datetime('now'))`
    ).run();

    const engine = new MoonshotEngine(db);
    const result = engine.runPortfolioRankerDaily(5, 0.1);

    expect(result.evaluated).toBeGreaterThan(0);
    const scoreCount = db.query("SELECT COUNT(*) AS count FROM portfolio_scores").get() as { count: number };
    const decisionCount = db.query("SELECT COUNT(*) AS count FROM portfolio_decisions").get() as { count: number };
    expect(Number(scoreCount.count)).toBeGreaterThan(0);
    expect(Number(decisionCount.count)).toBeGreaterThan(0);
  });

  it("builds graph snapshot and returns impact report", () => {
    const db = createDb();
    const engine = new MoonshotEngine(db);
    const repoPath = join(import.meta.dir, "../../..");

    const snapshot = engine.runGraphIndexerIncremental(repoPath);
    expect(snapshot.nodeCount).toBeGreaterThan(0);
    expect(snapshot.edgeCount).toBeGreaterThan(0);

    const impact = engine.getImpact("apps/worker");
    expect(impact.touchedNodes.length).toBeGreaterThan(0);
  });

  it("generates test candidates with provenance links", () => {
    const db = createDb();
    db.query(
      `INSERT INTO incidents (id, signature, severity, started_at, timeline, followups, created_at)
       VALUES ('inc_1', 'worker crashed in parser', 'high', datetime('now'), '[]', '[]', datetime('now'))`
    ).run();

    const engine = new MoonshotEngine(db);
    const result = engine.runTestEvolutionContinuous(2);

    expect(result.generated).toBeGreaterThan(0);
    const provCount = db.query("SELECT COUNT(*) AS count FROM test_provenance_links").get() as { count: number };
    expect(Number(provCount.count)).toBeGreaterThan(0);
  });
});
