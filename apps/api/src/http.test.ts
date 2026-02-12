import { describe, expect, test } from "bun:test";
import { Database } from "@squidward/db";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandler } from "./http";

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "squidward-api-test-"));
  return join(dir, "agent.db");
};

const signSlackRequest = (secret: string, ts: string, body: string): string =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

describe("api handler", () => {
  test("returns health response", async () => {
    const handler = createHandler({ dbPath: makeDbPath() });
    const response = await handler(new Request("http://localhost/healthz"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns dashboard cockpit payload", async () => {
    const handler = createHandler({ dbPath: makeDbPath() });
    const response = await handler(new Request("http://localhost/api/dashboard/cockpit"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { activeRuns: number; queuedTasks: number };
    expect(typeof body.activeRuns).toBe("number");
    expect(typeof body.queuedTasks).toBe("number");
  });

  test("oauth routes are removed", async () => {
    const handler = createHandler({ dbPath: makeDbPath() });
    const start = await handler(new Request("http://localhost/oauth/slack/start"));
    const callback = await handler(new Request("http://localhost/oauth/linear/callback?code=x&state=y"));
    expect(start.status).toBe(404);
    expect(callback.status).toBe(404);
  });

  test("returns integrations status shape", async () => {
    const dbPath = makeDbPath();

    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        OPENAI_API_KEY: "sk-test",
      },
      runCommand: async (command, args) => {
        if (command === "gh" && args.join(" ") === "auth status") {
          return { exitCode: 0, stdout: "github.com logged in", stderr: "" };
        }
        if (command === "codex") {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unknown command" };
      },
    });

    const response = await handler(new Request("http://localhost/api/integrations/status"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      generatedAt: string;
      providers: Record<string, Record<string, unknown>>;
    };

    expect(body.ok).toBe(true);
    expect(typeof body.generatedAt).toBe("string");

    expect(body.providers.slack).toBeTruthy();
    expect(body.providers.linear).toBeTruthy();
    expect(body.providers.openai).toBeTruthy();
    expect(body.providers.github).toBeTruthy();
    expect(body.providers.codex).toBeTruthy();

    expect(body.providers.openai.connected).toBe(true);
    expect(body.providers.github.connected).toBe(true);
    expect(body.providers.codex.connected).toBe(true);
  });

  test("validates Linear personal API key through live status probe", async () => {
    const dbPath = makeDbPath();
    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        LINEAR_API_KEY: "lin_api_test",
      },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("api.linear.app/graphql")) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  id: "usr_linear_123",
                  name: "Ryan",
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }
        return new Response("not found", { status: 404 });
      },
      runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });

    const response = await handler(new Request("http://localhost/api/integrations/status"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: {
        linear: { connected: boolean; status: string; refreshSupported?: boolean; detail?: string };
      };
    };
    expect(body.providers.linear.connected).toBe(true);
    expect(body.providers.linear.status).toBe("api_key_valid");
    expect(body.providers.linear.refreshSupported).toBe(false);
    expect(body.providers.linear.detail).toContain("usr_linear_123");
  });

  test("sanitizes token-like lines from integrations status details", async () => {
    const dbPath = makeDbPath();
    const handler = createHandler({
      dbPath,
      env: { AGENT_DB_PATH: dbPath },
      runCommand: async (command, args) => {
        if (command === "gh" && args.join(" ") === "auth status") {
          return {
            exitCode: 0,
            stdout: "github.com\\nToken: gho_123456789\\nLogged in",
            stderr: "",
          };
        }
        if (command === "codex") {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unknown command" };
      },
    });

    const response = await handler(new Request("http://localhost/api/integrations/status"));
    const body = (await response.json()) as {
      providers: { github: { detail: string } };
    };

    expect(body.providers.github.detail).not.toContain("Token:");
    expect(body.providers.github.detail.length).toBeGreaterThan(0);
  });

  test("manual retrieval reindex invalidates repo-scoped retrieval cache entries", async () => {
    const dbPath = makeDbPath();
    const handler = createHandler({ dbPath });
    const db = new Database(dbPath, { strict: false });
    db.query(
      `INSERT INTO context_cache
       (id, cache_key, summary_text, source_fingerprint, token_size, expires_at, created_at)
       VALUES
       ('cc_target', 'retrieval:v3:/Users/ryanwible/projects/wrela:code:fix tests', '{}', 'fp-1', 120, datetime('now', '+10 minutes'), datetime('now')),
       ('cc_other', 'retrieval:v3:/tmp/other:code:fix tests', '{}', 'fp-2', 120, datetime('now', '+10 minutes'), datetime('now'))`
    ).run();

    const response = await handler(
      new Request("http://localhost/api/retrieval/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoPath: "/Users/ryanwible/projects/wrela" }),
      })
    );
    expect(response.status).toBe(200);

    const targetCount = db
      .query(`SELECT COUNT(*) AS count FROM context_cache WHERE cache_key LIKE 'retrieval:v3:/Users/ryanwible/projects/wrela:%'`)
      .get() as Record<string, unknown>;
    const otherCount = db
      .query(`SELECT COUNT(*) AS count FROM context_cache WHERE cache_key LIKE 'retrieval:v3:/tmp/other:%'`)
      .get() as Record<string, unknown>;
    expect(Number(targetCount.count ?? 0)).toBe(0);
    expect(Number(otherCount.count ?? 0)).toBe(1);
  });

  test("oauth refresh endpoint is removed", async () => {
    const dbPath = makeDbPath();
    const handler = createHandler({ dbPath });
    const response = await handler(new Request("http://localhost/api/integrations/refresh/slack", { method: "POST" }));
    expect(response.status).toBe(404);
  });

  test("returns portfolio, test evolution, memo, and graph endpoints", async () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath, { create: true, strict: false });
    db.exec(readFileSync(join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql"), "utf8"));

    db.query(
      `INSERT INTO portfolio_candidates
       (id, source_type, source_ref, title, summary, risk_class, effort_class, evidence_links, created_at, updated_at)
       VALUES ('cand_1', 'task_queue', 'src/a.ts', 'Fix flaky test', 'summary', 'low', 'small', '[]', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO portfolio_scores
       (id, candidate_id, impact, confidence, urgency, risk, effort, ev, reasons_json, scored_at)
       VALUES ('score_1', 'cand_1', 2, 1.5, 1.2, 0.8, 0.7, 6.4, '{}', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO portfolio_decisions
       (id, score_id, decision, policy_mode, threshold, reason, created_at)
       VALUES ('dec_1', 'score_1', 'advisory', 'balanced', 1.25, 'seed', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO test_candidates
       (id, bug_ref, language, framework, test_path, test_code, status, score, validation_notes, created_at, updated_at)
       VALUES ('tc_1', 'incident:inc_1', 'typescript', 'vitest', 'tests/a.test.ts', 'it()', 'accepted', 0.9, 'ok', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO test_provenance_links
       (id, test_candidate_id, source_type, source_ref, created_at)
       VALUES ('tp_1', 'tc_1', 'incident', 'incident:inc_1', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO test_evolution_runs
       (id, trigger_source, bug_ref, candidates_generated, candidates_accepted, status, notes, created_at)
       VALUES ('tr_1', 'incident', 'incident:inc_1', 1, 1, 'completed', '', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO cto_memos
       (id, week_start, week_end, summary_md, evidence_links, delivered_to_slack, created_at)
       VALUES ('memo_1', datetime('now', '-7 day'), datetime('now'), '# memo', '[]', 0, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO memo_recommendations
       (id, memo_id, recommendation_type, title, rationale, expected_value, evidence_links, created_at)
       VALUES ('mr_1', 'memo_1', 'double_down', 'Fix flaky test', 'good', 6.4, '[]', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO decision_asks
       (id, memo_id, prompt, impact, created_at)
       VALUES ('ask_1', 'memo_1', 'Approve?', 'high', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO graph_nodes (id, node_type, ref, label, metadata_json, snapshot_id, created_at)
       VALUES ('gn_1', 'file', 'src/a.ts', 'src/a.ts', '{}', 'snap_1', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, weight, snapshot_id, created_at)
       VALUES ('ge_1', 'gn_1', 'gn_1', 'touches', 1, 'snap_1', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_baselines
       (id, repo_path, commit_sha, profile, manifest_path, baseline_json_path, summary_json, created_at)
       VALUES ('pb_1', '/Users/ryanwible/projects/wrela', 'abc123', 'standard', '/tmp/bench.toml', '/tmp/baseline.json', '{}', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_experiments
       (id, objective, status, trigger_source, base_commit_sha, branch_name, started_at)
       VALUES ('pe_1', 'balanced_score', 'running', 'nightly', 'abc123', 'codex/perf/x', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_candidates
       (id, experiment_id, title, hypothesis, change_class, target_paths_json, risk_class, status, created_at, updated_at)
       VALUES ('pc_1', 'pe_1', 'Perf: compiler', 'reduce p95', 'allocation_reduction', '[\"compiler/bin/wrela.rs\"]', 'low', 'recommended', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_runs
       (id, candidate_id, run_kind, profile, runs, command, cwd, artifact_path, exit_code, started_at, finished_at)
       VALUES ('pr_1', 'pc_1', 'perfcmp', 'standard', 5, 'wrela perfcmp', '/Users/ryanwible/projects/wrela', '/tmp/perfcmp.json', 0, datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_metrics
       (id, run_id, scenario_id, runtime_p95_ns, cv_pct, confidence_pct, effect_pct, created_at)
       VALUES ('pm_1', 'pr_1', 'summary', 123, 1.5, 95, 5, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_decisions
       (id, candidate_id, decision, score, reason, created_at)
       VALUES ('pd_1', 'pc_1', 'recommend', 4.2, 'good', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO perf_artifacts
       (id, owner_type, owner_id, artifact_type, path, digest, created_at)
       VALUES ('pa_1', 'candidate', 'pc_1', 'perfcmp_json', '/tmp/perfcmp.json', 'abc', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO memory_facts
       (id, namespace, fact_key, fact_value_json, state, confidence, source, created_at, updated_at)
       VALUES ('mf_1', 'canonical', 'repo.build.command', '{"command":"bun run build"}', 'active', 0.9, 'test', datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO memory_episodes
       (id, run_id, trigger_type, context_json, actions_json, outcome_json, created_at)
       VALUES ('me_1', 'run_1', 'codex_mission', '{}', '[]', '{"summary":"ok"}', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO policy_arms (id, domain, name, config_json, active)
       VALUES ('arm_1', 'general', 'default', '{}', 1)`
    ).run();
    db.query(
      `INSERT INTO policy_bandit_state (id, domain, model_json, exploration_rate, version, created_at)
       VALUES ('pbs_1', 'general', '{}', 0.1, 1, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO policy_decisions (id, domain, context_hash, arm_id, decision_reason, explore_flag, created_at)
       VALUES ('pdec_1', 'general', 'ctx', 'arm_1', 'seed', 0, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO policy_rewards (id, policy_decision_id, reward_total, reward_components_json, latency_minutes, created_at)
       VALUES ('prw_1', 'pdec_1', 0.5, '{}', 0, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO repo_learning_facts
       (id, repo_path, fact_type, fact_key, fact_value_json, confidence, evidence_count, last_validated_at, created_at, updated_at)
       VALUES ('rf_1', '/Users/ryanwible/projects/wrela', 'workflow_hint', 'build', '{"command":"cargo build"}', 0.8, 2, datetime('now'), datetime('now'), datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO repo_competence_snapshots
       (id, repo_path, score_total, subscores_json, top_risks_json, top_strengths_json, created_at)
       VALUES ('rcs_1', '/Users/ryanwible/projects/wrela', 0.75, '{"avgSuccess":0.8}', '["perf"]', '["build"]', datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO token_budgets (id, window, domain, soft_cap, hard_cap, updated_at)
       VALUES ('tb_1', 'monthly', 'general', 50000, 100000, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO token_usage_events
       (id, run_id, domain, model, input_tokens, output_tokens, cache_hit, cost_estimate, created_at)
       VALUES ('tue_1', 'run_1', 'general', 'codex-cli', 1200, 300, 0, 0, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO retrieval_queries
       (id, query_text, intent, repo_path, candidate_count, selected_count, budget_tokens, used_tokens, cache_hit, latency_ms, created_at)
       VALUES ('rq_1', 'fix perf', 'perf', '/Users/ryanwible/projects/wrela', 12, 5, 4000, 980, 0, 420, datetime('now'))`
    ).run();
    db.query(
      `INSERT INTO retrieval_results
       (id, query_id, document_id, source_class, source_ref, score, included, token_estimate, excerpt, created_at)
       VALUES ('rr_1', 'rq_1', 'doc_1', 'canonical', 'memory_facts:mf_1', 0.92, 1, 120, 'fact excerpt', datetime('now'))`
    ).run();
    db.close();

    const handler = createHandler({ dbPath, env: { AGENT_DB_PATH: dbPath } });

    const portfolioTop = await handler(new Request("http://localhost/api/portfolio/top?limit=5"));
    expect(portfolioTop.status).toBe(200);
    const portfolioTopBody = (await portfolioTop.json()) as Array<{ id: string }>;
    expect(portfolioTopBody[0]?.id).toBe("cand_1");

    const portfolioHistory = await handler(new Request("http://localhost/api/portfolio/history"));
    expect(portfolioHistory.status).toBe(200);

    const testStats = await handler(new Request("http://localhost/api/tests/evolution/stats"));
    expect(testStats.status).toBe(200);
    const testStatsBody = (await testStats.json()) as { generated: number; accepted: number };
    expect(testStatsBody.generated).toBeGreaterThan(0);

    const testCandidates = await handler(new Request("http://localhost/api/tests/evolution/candidates"));
    expect(testCandidates.status).toBe(200);

    const latestMemo = await handler(new Request("http://localhost/api/memos/latest"));
    expect(latestMemo.status).toBe(200);
    const latestMemoBody = (await latestMemo.json()) as { id: string };
    expect(latestMemoBody.id).toBe("memo_1");

    const impact = await handler(
      new Request("http://localhost/api/graph/impact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "src/a.ts" }),
      })
    );
    expect(impact.status).toBe(200);
    const impactBody = (await impact.json()) as { touchedNodes: Array<{ ref: string }> };
    expect(impactBody.touchedNodes.length).toBeGreaterThan(0);

    const hotspots = await handler(new Request("http://localhost/api/graph/hotspots"));
    expect(hotspots.status).toBe(200);

    const explain = await handler(new Request("http://localhost/api/graph/explain/mr_1"));
    expect(explain.status).toBe(200);

    const perfStatus = await handler(new Request("http://localhost/api/perf-scientist/status"));
    expect(perfStatus.status).toBe(200);

    const perfExperiments = await handler(new Request("http://localhost/api/perf-scientist/experiments"));
    expect(perfExperiments.status).toBe(200);

    const perfCandidates = await handler(new Request("http://localhost/api/perf-scientist/candidates"));
    expect(perfCandidates.status).toBe(200);

    const perfBaselines = await handler(new Request("http://localhost/api/perf-scientist/baselines?limit=5"));
    expect(perfBaselines.status).toBe(200);

    const perfLeaderboard = await handler(new Request("http://localhost/api/perf-scientist/leaderboard?window=7d"));
    expect(perfLeaderboard.status).toBe(200);

    const perfArtifacts = await handler(new Request("http://localhost/api/perf-scientist/artifacts/pr_1"));
    expect(perfArtifacts.status).toBe(200);

    const perfAction = await handler(
      new Request("http://localhost/api/perf-scientist/actions/pc_1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rerun" }),
      })
    );
    expect(perfAction.status).toBe(200);

    const memoryFacts = await handler(new Request("http://localhost/api/memory/facts"));
    expect(memoryFacts.status).toBe(200);

    const memoryEpisodes = await handler(new Request("http://localhost/api/memory/episodes"));
    expect(memoryEpisodes.status).toBe(200);

    const policyStatus = await handler(new Request("http://localhost/api/policy/status"));
    expect(policyStatus.status).toBe(200);

    const policyHistory = await handler(new Request("http://localhost/api/policy/history"));
    expect(policyHistory.status).toBe(200);

    const repoLearningStatus = await handler(
      new Request("http://localhost/api/repo-learning/status?repoPath=/Users/ryanwible/projects/wrela")
    );
    expect(repoLearningStatus.status).toBe(200);

    const repoLearningFacts = await handler(
      new Request("http://localhost/api/repo-learning/facts?repoPath=/Users/ryanwible/projects/wrela")
    );
    expect(repoLearningFacts.status).toBe(200);

    const tokenEconomyStatus = await handler(new Request("http://localhost/api/token-economy/status"));
    expect(tokenEconomyStatus.status).toBe(200);

    const tokenEconomyUsage = await handler(new Request("http://localhost/api/token-economy/usage"));
    expect(tokenEconomyUsage.status).toBe(200);

    const retrievalStatus = await handler(new Request("http://localhost/api/retrieval/status"));
    expect(retrievalStatus.status).toBe(200);

    const retrievalQueries = await handler(new Request("http://localhost/api/retrieval/queries?limit=10"));
    expect(retrievalQueries.status).toBe(200);

    const retrievalResults = await handler(new Request("http://localhost/api/retrieval/results/rq_1"));
    expect(retrievalResults.status).toBe(200);

    const retrievalFeedback = await handler(
      new Request("http://localhost/api/retrieval/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queryId: "rq_1", feedbackType: "helpful", notes: "solid context" }),
      })
    );
    expect(retrievalFeedback.status).toBe(200);
  });

  test("gracefully handles malformed limit params on paginated endpoints", async () => {
    const handler = createHandler({ dbPath: makeDbPath() });
    const endpoints = [
      "http://localhost/api/portfolio/top?limit=abc",
      "http://localhost/api/portfolio/history?limit=abc",
      "http://localhost/api/tests/evolution/candidates?limit=abc",
      "http://localhost/api/memos/history?limit=abc",
      "http://localhost/api/perf-scientist/experiments?limit=abc",
      "http://localhost/api/perf-scientist/candidates?limit=abc",
      "http://localhost/api/perf-scientist/baselines?limit=abc",
      "http://localhost/api/memory/facts?limit=abc",
      "http://localhost/api/memory/episodes?limit=abc",
      "http://localhost/api/policy/history?limit=abc",
      "http://localhost/api/repo-learning/facts?repoPath=/Users/ryanwible/projects/wrela&limit=abc",
      "http://localhost/api/token-economy/usage?limit=abc",
      "http://localhost/api/retrieval/queries?limit=abc",
    ];

    for (const endpoint of endpoints) {
      const response = await handler(new Request(endpoint));
      expect(response.status).toBe(200);
    }
  });

  test("captures retrieval feedback directly from Slack command messages", async () => {
    const dbPath = makeDbPath();
    const secret = "slack-signing-secret";
    const db = new Database(dbPath, { strict: false, create: true });
    db.exec(readFileSync(join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql"), "utf8"));
    db.query(
      `INSERT INTO retrieval_queries
       (id, query_text, intent, repo_path, candidate_count, selected_count, budget_tokens, used_tokens, cache_hit, latency_ms, created_at)
       VALUES ('rq_abc12345', 'seed', 'meta', '/Users/ryanwible/projects/wrela', 1, 1, 4000, 200, 0, 12, datetime('now'))`
    ).run();
    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        SLACK_SIGNING_SECRET: secret,
      },
    });

    const eventBody = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        client_msg_id: "cli-1",
        ts: "4102444800.000100",
        text: "fb rq_abc12345 helpful super useful context",
      },
    };

    const body = JSON.stringify(eventBody);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSlackRequest(secret, ts, body);
    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(202);

    const row = db
      .query(
        `SELECT query_id, feedback_type, notes
         FROM retrieval_feedback
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(row?.query_id).toBe("rq_abc12345");
    expect(row?.feedback_type).toBe("helpful");
    expect(String(row?.notes ?? "")).toContain("super useful context");
  });

  test("accepts app_mention events and enqueues codex mission tasks", async () => {
    const dbPath = makeDbPath();
    const secret = "slack-signing-secret";
    const db = new Database(dbPath, { strict: false, create: true });
    db.exec(readFileSync(join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql"), "utf8"));
    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        SLACK_SIGNING_SECRET: secret,
        PRIMARY_REPO_PATH: "/Users/ryanwible/projects/wrela",
      },
    });

    const eventBody = {
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C123",
        ts: "4102444800.000100",
        text: "<@U123ABC> please check the top perf opportunities",
      },
    };

    const body = JSON.stringify(eventBody);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSlackRequest(secret, ts, body);
    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(202);

    const row = db
      .query(
        `SELECT payload_json
         FROM task_queue
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    const payload = JSON.parse(String(row?.payload_json ?? "{}")) as {
      payload?: { requestText?: string };
    };
    expect(payload.payload?.requestText).toBe("please check the top perf opportunities");
  });

  test("routes owner control Slack commands to owner_control tasks", async () => {
    const dbPath = makeDbPath();
    const secret = "slack-signing-secret";
    const db = new Database(dbPath, { strict: false, create: true });
    db.exec(readFileSync(join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql"), "utf8"));
    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        SLACK_SIGNING_SECRET: secret,
        SLACK_TRIGGER_USER_IDS: "UOWNER",
      },
    });

    const eventBody = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "D123",
        user: "UOWNER",
        client_msg_id: "cli-owner-1",
        ts: "4102444800.000110",
        text: "control pause",
      },
    };

    const body = JSON.stringify(eventBody);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSlackRequest(secret, ts, body);
    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(202);

    const row = db
      .query(
        `SELECT task_type, payload_json
         FROM task_queue
         WHERE task_type='owner_control'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(String(row?.task_type ?? "")).toBe("owner_control");
    const payload = JSON.parse(String(row?.payload_json ?? "{}")) as { payload?: { controlAction?: string } };
    expect(payload.payload?.controlAction).toBe("pause");
  });

  test("ignores Slack channel messages from users outside the trigger allowlist", async () => {
    const dbPath = makeDbPath();
    const secret = "slack-signing-secret";
    const db = new Database(dbPath, { strict: false, create: true });
    db.exec(readFileSync(join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql"), "utf8"));
    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        SLACK_SIGNING_SECRET: secret,
        SLACK_TRIGGER_USER_IDS: "UALLOWED",
      },
    });

    const eventBody = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        user: "UNBLOCKED",
        client_msg_id: "cli-2",
        ts: "4102444800.000100",
        text: "please run your checks",
      },
    };

    const body = JSON.stringify(eventBody);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSlackRequest(secret, ts, body);
    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(202);

    const queued = db.query(`SELECT COUNT(*) AS count FROM task_queue WHERE task_type='codex_mission'`).get() as {
      count: number;
    };
    expect(Number(queued?.count ?? 0)).toBe(0);
  });

  test("ignores threaded Slack replies to avoid loop churn", async () => {
    const dbPath = makeDbPath();
    const secret = "slack-signing-secret";
    const db = new Database(dbPath, { strict: false, create: true });
    db.exec(readFileSync(join(import.meta.dir, "../../../packages/db/migrations/001_initial.sql"), "utf8"));
    const handler = createHandler({
      dbPath,
      env: {
        AGENT_DB_PATH: dbPath,
        SLACK_SIGNING_SECRET: secret,
        SLACK_TRIGGER_USER_IDS: "UOWNER",
      },
    });

    const eventBody = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        user: "UOWNER",
        client_msg_id: "cli-3",
        ts: "4102444800.000200",
        thread_ts: "4102444800.000100",
        text: "follow up in thread",
      },
    };

    const body = JSON.stringify(eventBody);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSlackRequest(secret, ts, body);
    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(202);

    const queued = db.query(`SELECT COUNT(*) AS count FROM task_queue WHERE task_type='codex_mission'`).get() as {
      count: number;
    };
    expect(Number(queued?.count ?? 0)).toBe(0);
  });

  test("rejects stale Slack signatures to prevent replay", async () => {
    const dbPath = makeDbPath();
    const secret = "slack-signing-secret";
    const handler = createHandler({
      dbPath,
      env: { AGENT_DB_PATH: dbPath, SLACK_SIGNING_SECRET: secret },
    });
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "message", channel: "C123", ts: "4102444800.000100", text: "hello" },
    });
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = signSlackRequest(secret, ts, body);

    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(401);
  });

  test("rejects slack event when signing secret is missing", async () => {
    const dbPath = makeDbPath();
    const handler = createHandler({ dbPath, env: { AGENT_DB_PATH: dbPath } });
    const response = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event: { type: "message", channel: "C123", ts: "4102444800.000100", text: "hello" },
        }),
      })
    );
    expect(response.status).toBe(401);
  });
});
