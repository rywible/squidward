import { describe, expect, it } from "bun:test";
import { Database } from "@squidward/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildRetrievalContextPack } from "../src/retrieval-orchestrator";

const migrate = (db: Database): void => {
  const migrationPath = resolve(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
};

describe("retrieval orchestrator", () => {
  it("always includes high-priority policy memory", () => {
    const db = new Database(":memory:");
    migrate(db);

    db.query(
      `INSERT INTO memory_facts
       (id, namespace, fact_key, fact_value_json, state, confidence, source, created_at, updated_at)
       VALUES ('mf_policy', 'policy', 'policy.no_prod_writes', '{"enforced":true}', 'active', 1, 'seed', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO repo_learning_facts
       (id, repo_path, fact_type, fact_key, fact_value_json, confidence, evidence_count, created_at, updated_at)
       VALUES ('rl_1', '/Users/ryanwible/projects/wrela', 'workflow_hint', 'build', '{"command":"cargo build"}', 0.8, 2, datetime('now'), datetime('now'))`
    ).run();

    const pack = buildRetrievalContextPack({
      db,
      repoPath: "/Users/ryanwible/projects/wrela",
      objective: "Please modify deploy scripts and push to prod",
      requestText: "Need prod access",
      taskType: "codex_mission",
      budgetTokens: 400,
    });

    const hasPolicy = pack.canonicalFacts.some((fact) => fact.source.includes("memory_facts:mf_policy"));
    expect(hasPolicy).toBe(true);
  });

  it("respects token budget cap", () => {
    const db = new Database(":memory:");
    migrate(db);

    for (let i = 0; i < 40; i += 1) {
      db.query(
        `INSERT INTO memory_facts
         (id, namespace, fact_key, fact_value_json, state, confidence, source, created_at, updated_at)
         VALUES (?, 'canonical', ?, ?, 'active', 0.8, 'seed', datetime('now'), datetime('now'))`
      ).run(
        `mf_${i}`,
        `key_${i}`,
        JSON.stringify({ text: `very long context ${"x".repeat(200)}` })
      );
    }

    const pack = buildRetrievalContextPack({
      db,
      repoPath: "/Users/ryanwible/projects/wrela",
      objective: "fix tests",
      requestText: "debug compiler",
      taskType: "codex_mission",
      budgetTokens: 220,
    });

    expect(pack.usedTokens).toBeLessThanOrEqual(220);
    expect(pack.budgetTokens).toBe(220);
  });

  it("keeps hard cap even with oversized mandatory policy facts", () => {
    const db = new Database(":memory:");
    migrate(db);

    db.query(
      `INSERT INTO memory_facts
       (id, namespace, fact_key, fact_value_json, state, confidence, source, created_at, updated_at)
       VALUES ('mf_policy_big', 'policy', 'policy.super_long', ?, 'active', 1, 'seed', datetime('now'), datetime('now'))`
    ).run(JSON.stringify({ note: "x".repeat(3000) }));

    const pack = buildRetrievalContextPack({
      db,
      repoPath: "/Users/ryanwible/projects/wrela",
      objective: "policy request",
      requestText: "anything",
      taskType: "codex_mission",
      budgetTokens: 120,
    });

    expect(pack.usedTokens).toBeLessThanOrEqual(120);
    expect(pack.canonicalFacts.length).toBeGreaterThan(0);
  });

  it("reindexes when retrieval documents are stale by coverage despite fresh timestamp", () => {
    const db = new Database(":memory:");
    migrate(db);

    db.query(
      `INSERT INTO memory_facts
       (id, namespace, fact_key, fact_value_json, state, confidence, source, created_at, updated_at)
       VALUES ('mf_coverage', 'canonical', 'build.cmd', '{"command":"cargo build"}', 'active', 0.9, 'seed', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO agent_runs
       (id, trigger_type, objective, actions, outcome, rollback_flag, duration, created_at)
       VALUES ('run_cov', 'manual', 'coverage', '[]', 'completed', 0, 0, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO command_audit
       (id, run_id, command, cwd, started_at, finished_at, exit_code, artifact_refs)
       VALUES ('ca_coverage', 'run_cov', 'cargo test', '/Users/ryanwible/projects/wrela', datetime('now'), datetime('now'), 0, '[]')`
    ).run();
    db.query(
      `INSERT INTO retrieval_documents
       (id, doc_type, source_ref, repo_path, title, content, metadata_json, updated_at, created_at)
       VALUES ('doc_partial', 'canonical', 'memory_facts:mf_coverage', '/Users/ryanwible/projects/wrela', 'stale', 'stale', '{}', datetime('now', '+1 day'), datetime('now', '+1 day'))`
    ).run();

    buildRetrievalContextPack({
      db,
      repoPath: "/Users/ryanwible/projects/wrela",
      objective: "find latest command evidence",
      requestText: "what should I run",
      taskType: "codex_mission",
      budgetTokens: 400,
    });

    const canonicalCount = db
      .query(
        `SELECT COUNT(*) AS count
         FROM retrieval_documents
         WHERE repo_path='/Users/ryanwible/projects/wrela' AND doc_type='canonical'`
      )
      .get() as { count: number };
    const evidenceCount = db
      .query(
        `SELECT COUNT(*) AS count
         FROM retrieval_documents
         WHERE repo_path='/Users/ryanwible/projects/wrela' AND doc_type='evidence'`
      )
      .get() as { count: number };
    expect(Number(canonicalCount.count)).toBeGreaterThanOrEqual(1);
    expect(Number(evidenceCount.count)).toBeGreaterThanOrEqual(1);
  });
});
