import { describe, expect, it } from "bun:test";
import { Database } from "@squidward/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CodexCliAdapter } from "../src/adapters";
import { CodexHarness } from "../src/codex-harness";
import { MemoryGovernor } from "../src/memory-governor";
import { buildMissionPack, renderMissionPrompt } from "../src/mission-pack";
import { recordReward } from "../src/reward-engine";
import { buildTokenEnvelope } from "../src/token-economy";
import { WrelaLearningService } from "../src/wrela-learning";

const migrate = (db: Database): void => {
  const migrationPath = resolve(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
};

class FixedOutputCodexAdapter implements CodexCliAdapter {
  constructor(private readonly output: string) {}
  async runCommand(): Promise<{ exitCode: number; artifactRefs: string[] }> {
    return { exitCode: 0, artifactRefs: [this.output] };
  }
  async preflightAvailability(): Promise<{ ok: boolean; details: string[] }> {
    return { ok: true, details: ["ok"] };
  }
  async preflightAuth(): Promise<{ ok: boolean; details: string[] }> {
    return { ok: true, details: ["ok"] };
  }
}

describe("codex mission harness e2e", () => {
  it("parses payload, commits memory, records reward, and updates wrlela learning", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const runId = "run_e2e_1";
    db.query(
      `INSERT INTO agent_runs
       (id, trigger_type, objective, actions, outcome, rollback_flag, duration, created_at)
       VALUES (?, 'manual', 'test', '[]', 'running', 0, 0, datetime('now'))`
    ).run(runId);
    db.query(
      `INSERT INTO command_audit
       (id, run_id, command, cwd, started_at, finished_at, exit_code, artifact_refs)
       VALUES (?, ?, 'cargo test -q', '/Users/ryanwible/projects/wrela', datetime('now'), datetime('now'), 0, '[]')`
    ).run(crypto.randomUUID(), runId);

    const payload = [
      "BEGIN_AGENT_PAYLOAD",
      JSON.stringify({
        status: "done",
        summary: "Completed mission",
        actionsTaken: [{ kind: "analysis", detail: "checked benchmarks", evidenceRefs: ["command:a1"] }],
        proposedChanges: { files: ["compiler/foo.rs"], estimatedLoc: 20, risk: "low" },
        memoryProposals: [
          {
            layerHint: "canonical",
            type: "workflow_hint",
            key: "wrela.build.fast_path",
            value: { command: "cargo test -q -p compiler --lib" },
            confidence: 0.9,
            citations: ["command:a1"],
          },
        ],
        nextSteps: ["open draft pr"],
      }),
      "END_AGENT_PAYLOAD",
    ].join("\n");

    const harness = new CodexHarness(new FixedOutputCodexAdapter(payload), db);
    const envelope = buildTokenEnvelope(db, "general");
    const missionPack = buildMissionPack({
      db,
      task: { taskType: "codex_mission", runId, objective: "test objective" },
      repoPath: "/Users/ryanwible/projects/wrela",
      objective: "test objective",
      tokenEnvelope: envelope,
    });
    expect(missionPack.context.selectedSkills.length).toBeGreaterThan(0);
    expect(missionPack.context.selectedSkills.some((skill) => skill.id === "repo-orient")).toBe(true);
    const prompt = renderMissionPrompt(missionPack, "do it");
    expect(prompt).toContain("Selected OOB skills");
    expect(prompt).toContain("Repo Orient");
    const parsed = await harness.run({
      missionPack,
      objectiveDetails: "do it",
      cwd: "/Users/ryanwible/projects/wrela",
    });
    const governor = new MemoryGovernor(db);
    const commit = governor.commit(runId, parsed.payload.memoryProposals, "test");
    expect(commit.accepted).toBe(1);

    db.query(`INSERT INTO policy_arms (id, domain, name, config_json, active) VALUES ('arm1', 'general', 'default', '{}', 1)`).run();
    db.query(
      `INSERT INTO policy_decisions (id, domain, context_hash, arm_id, decision_reason, explore_flag, created_at)
       VALUES ('pd1', 'general', ?, 'arm1', 'test', 0, datetime('now'))`
    ).run(parsed.contextHash);
    recordReward(db, {
      policyDecisionId: "pd1",
      reliability: 1,
      completion: 1,
      perfGain: 0,
      ownerFeedback: 0,
      noisePenalty: -0.1,
      latencyMinutes: 0,
    });

    const learning = new WrelaLearningService(db, "/Users/ryanwible/projects/wrela");
    learning.ingestRun(runId, "success", "codex mission");

    const fact = db.query(`SELECT id FROM memory_facts WHERE fact_key='wrela.build.fast_path' LIMIT 1`).get() as { id: string } | null;
    expect(fact).not.toBeNull();
    const reward = db.query(`SELECT id FROM policy_rewards WHERE policy_decision_id='pd1' LIMIT 1`).get() as { id: string } | null;
    expect(reward).not.toBeNull();
    const snapshot = db.query(`SELECT id FROM repo_competence_snapshots LIMIT 1`).get() as { id: string } | null;
    expect(snapshot).not.toBeNull();
  });

  it("returns blocked fallback payload on malformed output after retry", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const badAdapter = new FixedOutputCodexAdapter("not-json-at-all");
    const harness = new CodexHarness(badAdapter, db);
    const missionPack = buildMissionPack({
      db,
      task: { taskType: "codex_mission", runId: "run_bad_1", objective: "test objective" },
      repoPath: "/Users/ryanwible/projects/wrela",
      objective: "test objective",
      tokenEnvelope: buildTokenEnvelope(db, "general"),
    });
    const parsed = await harness.run({
      missionPack,
      objectiveDetails: "do it",
      cwd: "/Users/ryanwible/projects/wrela",
    });
    expect(parsed.payload.status).toBe("blocked");
    expect(parsed.payload.summary.length).toBeGreaterThan(0);
  });
});
