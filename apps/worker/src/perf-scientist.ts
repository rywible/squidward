import { Database } from "@squidward/db";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { GithubGhAdapter } from "./adapters";
import type { CommandAuditService } from "./audit";
import { applyPersonaSignal } from "./persona-feedback";

type SqlRecord = Record<string, unknown>;

type PerfProfile = "smoke" | "standard" | "deep";

export type PerfScientistDecision = "reject_noise" | "reject_regression" | "recommend" | "draft_pr_opened";

export interface PerfScientistConfig {
  enabled: boolean;
  repoPath: string;
  benchmarkRoot: string;
  manifestPath: string;
  nightlyHour: number;
  smokeOnChange: boolean;
  standardRuns: number;
  smokeRuns: number;
  cvMaxPct: number;
  minEffectPct: number;
  confidencePct: number;
  maxAutoPrFiles: number;
  maxAutoPrLoc: number;
  baseRefForPerfCmp: string;
  patchCommandTemplate?: string;
  testCommand: string;
}

export interface PerfScientistStatus {
  enabled: boolean;
  repoPath: string;
  lastBaselineAt?: string;
  lastExperimentAt?: string;
  queuedTasks: number;
  runningExperiments: number;
  nextNightlyHour: number;
}

export interface PerfScoreBreakdown {
  latencyGainPct: number;
  throughputGainPct: number;
  allocRegressPct: number;
  rcRegressPct: number;
  score: number;
}

export interface CandidateGenerationResult {
  experimentId: string;
  candidateIds: string[];
}

const nowIso = (): string => new Date().toISOString();

const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

export const computeBalancedPerfScore = (input: {
  latencyGainPct: number;
  throughputGainPct: number;
  allocRegressPct: number;
  rcRegressPct: number;
}): PerfScoreBreakdown => {
  const latencyGainPct = input.latencyGainPct;
  const throughputGainPct = input.throughputGainPct;
  const allocRegressPct = input.allocRegressPct;
  const rcRegressPct = input.rcRegressPct;
  const score =
    0.45 * latencyGainPct +
    0.3 * throughputGainPct -
    0.15 * allocRegressPct -
    0.1 * rcRegressPct;

  return {
    latencyGainPct,
    throughputGainPct,
    allocRegressPct,
    rcRegressPct,
    score: Number(score.toFixed(4)),
  };
};

const extractSummaryFromPerfBaseline = (raw: unknown): {
  runtimeP50Ns: number;
  runtimeP95Ns: number;
  runtimeP99Ns: number;
  compileThroughputTps: number;
  allocsPerRequest: number;
  dispatchHitRatio: number;
  rcOpsTotal: number;
  cvPct: number;
} => {
  const report = typeof raw === "object" && raw ? (raw as Record<string, unknown>) : {};
  const summary = typeof report.summary === "object" && report.summary ? (report.summary as Record<string, unknown>) : report;
  const cv = typeof report.cv === "object" && report.cv ? (report.cv as Record<string, unknown>) : {};

  const cvCandidates = [
    asNumber(cv.runtime_p95_pct, 0),
    asNumber(cv.runtime_p99_pct, 0),
    asNumber(cv.runtime_p50_pct, 0),
    asNumber(cv.compile_throughput_pct, 0),
  ];

  return {
    runtimeP50Ns: asNumber(summary.runtime_p50_ns, 0),
    runtimeP95Ns: asNumber(summary.runtime_p95_ns, 0),
    runtimeP99Ns: asNumber(summary.runtime_p99_ns, 0),
    compileThroughputTps: asNumber(summary.compile_throughput_tests_per_sec, 0),
    allocsPerRequest: asNumber(summary.allocs_per_request, 0),
    dispatchHitRatio: asNumber(summary.dispatch_hit_ratio, 0),
    rcOpsTotal: asNumber(summary.rc_ops_total, 0),
    cvPct: Math.max(...cvCandidates),
  };
};

const extractSummaryFromPerfCmp = (raw: unknown): {
  confidencePct: number;
  effectPct: number;
  gatePassed: boolean;
  medianLatencyGainPct: number;
  unstableCount: number;
  winCount: number;
  regressionCount: number;
  noSignalCount: number;
} => {
  const report = typeof raw === "object" && raw ? (raw as Record<string, unknown>) : {};
  const summary = typeof report.summary === "object" && report.summary ? (report.summary as Record<string, unknown>) : {};
  const scenarios = Array.isArray(report.scenarios) ? (report.scenarios as Array<Record<string, unknown>>) : [];

  const gains: number[] = [];
  for (const scenario of scenarios) {
    const baselineNs = asNumber(scenario.baseline_runtime_ns_median, 0);
    const candidateNs = asNumber(scenario.candidate_runtime_ns_median, 0);
    if (baselineNs > 0 && candidateNs > 0) {
      gains.push(((baselineNs - candidateNs) / baselineNs) * 100);
    }
  }

  return {
    confidencePct: asNumber(report.confidence_pct, 95),
    effectPct: asNumber(report.min_effect_pct, 2),
    gatePassed: summary.gate_passed === true,
    medianLatencyGainPct: gains.length > 0 ? gains.sort((a, b) => a - b)[Math.floor(gains.length / 2)] ?? 0 : 0,
    unstableCount: asNumber(summary.unstable_count, 0),
    winCount: asNumber(summary.win_count, 0),
    regressionCount: asNumber(summary.regression_count, 0),
    noSignalCount: asNumber(summary.no_signal_count, 0),
  };
};

const resolveArtifactDir = (repoPath: string): string => {
  const artifactDir = resolve(repoPath, ".artifacts/squidward/perf-scientist");
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
};

export const resolveBenchmarkRoot = (configuredRoot: string, manifestPath: string): string => {
  const manifestDir = dirname(manifestPath);
  if (!existsSync(manifestDir)) {
    return configuredRoot;
  }

  // Wrela perf/perfcmp commands expect a suite path like benchmarks/macro.
  // If the configured root is the parent benchmarks directory, use the manifest suite directory.
  if (configuredRoot === dirname(manifestDir)) {
    return manifestDir;
  }
  return configuredRoot;
};

const runGit = (repoPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: (proc.exitCode ?? 1) === 0,
    stdout: Buffer.from(proc.stdout).toString("utf8").trim(),
    stderr: Buffer.from(proc.stderr).toString("utf8").trim(),
  };
};

export class PerfScientist {
  private lastObservedHead: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly audit: CommandAuditService,
    private readonly gh: GithubGhAdapter,
    private readonly config: PerfScientistConfig
  ) {}

  getConfig(): PerfScientistConfig {
    return this.config;
  }

  getStatus(): PerfScientistStatus {
    const lastBaseline = this.db
      .query(`SELECT created_at FROM perf_baselines ORDER BY created_at DESC LIMIT 1`)
      .get() as SqlRecord | null;
    const lastExperiment = this.db
      .query(`SELECT started_at FROM perf_experiments ORDER BY started_at DESC LIMIT 1`)
      .get() as SqlRecord | null;
    const queued = this.db
      .query(
        `SELECT COUNT(*) AS count FROM task_queue WHERE status='queued' AND task_type IN ('perf_baseline_nightly','perf_detect_change_smoke','perf_generate_candidates','perf_run_candidate','perf_score_decide','perf_open_draft_pr')`
      )
      .get() as SqlRecord;
    const running = this.db
      .query(`SELECT COUNT(*) AS count FROM perf_experiments WHERE status='running'`)
      .get() as SqlRecord;

    return {
      enabled: this.config.enabled,
      repoPath: this.config.repoPath,
      lastBaselineAt: lastBaseline?.created_at ? String(lastBaseline.created_at) : undefined,
      lastExperimentAt: lastExperiment?.started_at ? String(lastExperiment.started_at) : undefined,
      queuedTasks: asNumber(queued.count, 0),
      runningExperiments: asNumber(running.count, 0),
      nextNightlyHour: this.config.nightlyHour,
    };
  }

  detectQualifyingHeadChange(): { changed: boolean; head: string; changedPaths: string[] } {
    const headRes = runGit(this.config.repoPath, ["rev-parse", "HEAD"]);
    if (!headRes.ok || !headRes.stdout) {
      return { changed: false, head: "", changedPaths: [] };
    }

    const head = headRes.stdout;
    if (!this.lastObservedHead) {
      this.lastObservedHead = head;
      return { changed: false, head, changedPaths: [] };
    }

    if (this.lastObservedHead === head) {
      return { changed: false, head, changedPaths: [] };
    }

    const diffRes = runGit(this.config.repoPath, ["diff", "--name-only", this.lastObservedHead, head]);
    const changedPaths = diffRes.ok
      ? diffRes.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];

    this.lastObservedHead = head;

    const qualifying = changedPaths.some((path) =>
      /^(compiler|runtime|language|benchmarks)\//.test(path) || /\.(rs|wr|toml)$/.test(path)
    );

    return {
      changed: qualifying,
      head,
      changedPaths,
    };
  }

  async runBaseline(params: {
    runId: string;
    profile: PerfProfile;
    triggerSource: string;
    runs: number;
  }): Promise<{ ok: boolean; baselineId?: string; reason?: string }> {
    if (!this.config.enabled) {
      return { ok: false, reason: "disabled" };
    }

    const precheck = await this.audit.runWithAudit(
      params.runId,
      "cargo run -q --bin wrela -- --version > /dev/null 2>&1",
      this.config.repoPath
    );
    if (precheck.exitCode !== 0) {
      await this.recordBlockedDecision(params.triggerSource, "cli_not_buildable");
      await this.notify(`APS blocked: cli_not_buildable (${params.triggerSource})`);
      return { ok: false, reason: "cli_not_buildable" };
    }

    const commit = runGit(this.config.repoPath, ["rev-parse", "HEAD"]);
    const commitSha = commit.ok ? commit.stdout : "unknown";
    const artifactDir = resolveArtifactDir(this.config.repoPath);
    const benchmarkRoot = resolveBenchmarkRoot(this.config.benchmarkRoot, this.config.manifestPath);
    const baselinePath = join(artifactDir, `baseline-${params.profile}-${Date.now()}.json`);

    const runId = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO perf_runs
         (id, candidate_id, run_kind, profile, runs, command, cwd, artifact_path, started_at)
         VALUES (?, NULL, 'baseline', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        params.profile,
        params.runs,
        "wrela perf",
        this.config.repoPath,
        baselinePath,
        nowIso()
      );

    const command = `cargo run -q --bin wrela -- perf --runs=${params.runs} --profile=${params.profile} --benchmark-manifest="${this.config.manifestPath}" --baseline-out="${baselinePath}" "${benchmarkRoot}"`;

    const result = await this.audit.runWithAudit(params.runId, command, this.config.repoPath);

    this.db
      .query(`UPDATE perf_runs SET exit_code=?, finished_at=? WHERE id=?`)
      .run(result.exitCode, nowIso(), runId);

    if (result.exitCode !== 0 || !existsSync(baselinePath)) {
      await this.recordBlockedDecision(params.triggerSource, "perf_command_failed");
      await this.notify(`APS baseline failed (${params.profile}): perf command failed`);
      return { ok: false, reason: "perf_command_failed" };
    }

    const raw = parseJson<unknown>(readFileSync(baselinePath, "utf8"), {});
    const summary = extractSummaryFromPerfBaseline(raw);
    const baselineId = crypto.randomUUID();

    this.db
      .query(
        `INSERT INTO perf_baselines
         (id, repo_path, commit_sha, profile, manifest_path, baseline_json_path, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        baselineId,
        this.config.repoPath,
        commitSha,
        params.profile,
        this.config.manifestPath,
        baselinePath,
        JSON.stringify(summary),
        nowIso()
      );

    this.db
      .query(
        `INSERT INTO perf_metrics
         (id, run_id, scenario_id, runtime_p50_ns, runtime_p95_ns, runtime_p99_ns, compile_throughput_tps, allocs_per_request, dispatch_hit_ratio, cv_pct, confidence_pct, effect_pct, created_at)
         VALUES (?, ?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        runId,
        summary.runtimeP50Ns,
        summary.runtimeP95Ns,
        summary.runtimeP99Ns,
        summary.compileThroughputTps,
        summary.allocsPerRequest,
        summary.dispatchHitRatio,
        summary.cvPct,
        this.config.confidencePct,
        this.config.minEffectPct,
        nowIso()
      );

    await this.recordArtifact("baseline", baselineId, "baseline_json", baselinePath);

    return { ok: true, baselineId };
  }

  async generateCandidates(params: {
    runId: string;
    triggerSource: string;
    objective?: string;
    maxCandidates?: number;
  }): Promise<CandidateGenerationResult> {
    const commit = runGit(this.config.repoPath, ["rev-parse", "HEAD"]);
    const baseCommitSha = commit.ok ? commit.stdout : "unknown";
    const experimentId = crypto.randomUUID();

    this.db
      .query(
        `INSERT INTO perf_experiments
         (id, objective, status, trigger_source, base_commit_sha, started_at)
         VALUES (?, ?, 'running', ?, ?, ?)`
      )
      .run(experimentId, params.objective ?? "balanced_score", params.triggerSource, baseCommitSha, nowIso());

    const graphHotspots = this.db
      .query(
        `SELECT n.ref, COUNT(*) AS count
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.to_node_id
         GROUP BY n.ref
         ORDER BY count DESC
         LIMIT 20`
      )
      .all() as SqlRecord[];

    const recentRegressions = this.db
      .query(
        `SELECT scenario_id, effect_pct
         FROM perf_metrics
         WHERE effect_pct < 0
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all() as SqlRecord[];

    const churnRes = runGit(this.config.repoPath, ["log", "--name-only", "--pretty=format:", "-n", "60"]);
    const churnPaths = churnRes.ok
      ? churnRes.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];

    const pooledPaths = [
      ...graphHotspots.map((row) => String(row.ref)),
      ...recentRegressions.map((row) => String(row.scenario_id)),
      ...churnPaths,
    ].filter((path) => path.length > 0);

    const uniquePaths = [...new Set(pooledPaths)]
      .filter((path) => !this.isSensitivePath(path))
      .slice(0, Math.max(1, params.maxCandidates ?? 1));

    const changeClasses = [
      "algorithmic_simplification",
      "allocation_reduction",
      "branch_match_simplification",
      "loop_data_structure_improvement",
    ];

    const candidateIds: string[] = [];
    for (let i = 0; i < uniquePaths.length; i += 1) {
      const target = uniquePaths[i] ?? "compiler";
      const candidateId = crypto.randomUUID();
      const title = `Perf: ${target}`;
      const hypothesis = `Reduce runtime p95 for ${target} with a small low-risk change.`;
      const changeClass = changeClasses[i % changeClasses.length] ?? changeClasses[0];

      this.db
        .query(
          `INSERT INTO perf_candidates
           (id, experiment_id, title, hypothesis, change_class, target_paths_json, risk_class, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'low', 'queued', ?, ?)`
        )
        .run(candidateId, experimentId, title, hypothesis, changeClass, JSON.stringify([target]), nowIso(), nowIso());

      candidateIds.push(candidateId);
    }

    if (candidateIds.length === 0) {
      this.db
        .query(`UPDATE perf_experiments SET status='completed', finished_at=? WHERE id=?`)
        .run(nowIso(), experimentId);
    }

    return { experimentId, candidateIds };
  }

  async runCandidate(params: {
    runId: string;
    candidateId: string;
    profile: PerfProfile;
    runs: number;
  }): Promise<{ ok: boolean; reportPath?: string; reason?: string }> {
    const candidate = this.db
      .query(
        `SELECT id, experiment_id, title, hypothesis, target_paths_json
         FROM perf_candidates
         WHERE id=?
         LIMIT 1`
      )
      .get(params.candidateId) as SqlRecord | null;

    if (!candidate) {
      return { ok: false, reason: "candidate_not_found" };
    }

    this.db
      .query(`UPDATE perf_candidates SET status='running', updated_at=? WHERE id=?`)
      .run(nowIso(), params.candidateId);

    const experiment = this.db
      .query(`SELECT id, branch_name FROM perf_experiments WHERE id=? LIMIT 1`)
      .get(String(candidate.experiment_id)) as SqlRecord | null;

    if (!experiment) {
      return { ok: false, reason: "experiment_not_found" };
    }

    const targetPaths = parseJson<string[]>(candidate.target_paths_json, []);
    const targetPath = targetPaths[0] ?? "compiler";

    let branchName = experiment.branch_name ? String(experiment.branch_name) : "";
    if (!branchName) {
      branchName = `codex/perf/${slugify(String(candidate.title))}-${Date.now()}`;
      const checkout = await this.audit.runWithAudit(
        params.runId,
        `git checkout -B ${branchName}`,
        this.config.repoPath
      );
      if (checkout.exitCode !== 0) {
        this.db
          .query(`UPDATE perf_candidates SET status='failed', updated_at=? WHERE id=?`)
          .run(nowIso(), params.candidateId);
        this.db
          .query(`UPDATE perf_experiments SET status='failed', error=?, finished_at=? WHERE id=?`)
          .run("failed_to_checkout_branch", nowIso(), String(experiment.id));
        return { ok: false, reason: "failed_to_checkout_branch" };
      } else {
        this.db
          .query(`UPDATE perf_experiments SET branch_name=? WHERE id=?`)
          .run(branchName, String(experiment.id));
      }
    }

    if (this.config.patchCommandTemplate && this.config.patchCommandTemplate.trim().length > 0) {
      const patchCommand = this.config.patchCommandTemplate
        .replaceAll("{{repo_path}}", this.config.repoPath)
        .replaceAll("{{target_path}}", targetPath)
        .replaceAll("{{hypothesis}}", String(candidate.hypothesis));
      const patchResult = await this.audit.runWithAudit(params.runId, patchCommand, this.config.repoPath);
      if (patchResult.exitCode !== 0) {
        this.db
          .query(`UPDATE perf_candidates SET status='failed', updated_at=? WHERE id=?`)
          .run(nowIso(), params.candidateId);
        this.db
          .query(`UPDATE perf_experiments SET status='failed', error=?, finished_at=? WHERE id=?`)
          .run("patch_command_failed", nowIso(), String(candidate.experiment_id));
        return { ok: false, reason: "patch_command_failed" };
      }
    }

    const artifactDir = resolveArtifactDir(this.config.repoPath);
    const benchmarkRoot = resolveBenchmarkRoot(this.config.benchmarkRoot, this.config.manifestPath);
    const candidatePerfPath = join(artifactDir, `candidate-${params.candidateId}-${Date.now()}.json`);
    const perfcmpPath = join(artifactDir, `perfcmp-${params.candidateId}-${Date.now()}.json`);

    const perfRunId = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO perf_runs
         (id, candidate_id, run_kind, profile, runs, command, cwd, artifact_path, started_at)
         VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        perfRunId,
        params.candidateId,
        params.profile,
        params.runs,
        "wrela perf",
        this.config.repoPath,
        candidatePerfPath,
        nowIso()
      );

    const perfCommand = `cargo run -q --bin wrela -- perf --runs=${params.runs} --profile=${params.profile} --benchmark-manifest="${this.config.manifestPath}" --baseline-out="${candidatePerfPath}" "${benchmarkRoot}"`;
    const perfResult = await this.audit.runWithAudit(params.runId, perfCommand, this.config.repoPath);

    this.db
      .query(`UPDATE perf_runs SET exit_code=?, finished_at=? WHERE id=?`)
      .run(perfResult.exitCode, nowIso(), perfRunId);

    if (perfResult.exitCode !== 0 || !existsSync(candidatePerfPath)) {
      this.db
        .query(`UPDATE perf_candidates SET status='failed', updated_at=? WHERE id=?`)
        .run(nowIso(), params.candidateId);
      this.db
        .query(`UPDATE perf_experiments SET status='failed', error=?, finished_at=? WHERE id=?`)
        .run("candidate_perf_failed", nowIso(), String(candidate.experiment_id));
      return { ok: false, reason: "candidate_perf_failed" };
    }

    const perfcmpRunId = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO perf_runs
         (id, candidate_id, run_kind, profile, runs, command, cwd, artifact_path, started_at)
         VALUES (?, ?, 'perfcmp', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        perfcmpRunId,
        params.candidateId,
        params.profile,
        params.runs,
        "wrela perfcmp",
        this.config.repoPath,
        perfcmpPath,
        nowIso()
      );

    const perfcmpCommand = `cargo run -q --bin wrela -- perfcmp --profile=${params.profile} --benchmark-manifest="${this.config.manifestPath}" --baseline-ref=${this.config.baseRefForPerfCmp} --candidate-ref=HEAD --min-effect-pct=${this.config.minEffectPct} --confidence=${this.config.confidencePct} -o "${perfcmpPath}" "${benchmarkRoot}"`;
    const perfcmpResult = await this.audit.runWithAudit(params.runId, perfcmpCommand, this.config.repoPath);

    this.db
      .query(`UPDATE perf_runs SET exit_code=?, finished_at=? WHERE id=?`)
      .run(perfcmpResult.exitCode, nowIso(), perfcmpRunId);

    if (perfcmpResult.exitCode !== 0 || !existsSync(perfcmpPath)) {
      this.db
        .query(`UPDATE perf_candidates SET status='failed', updated_at=? WHERE id=?`)
        .run(nowIso(), params.candidateId);
      this.db
        .query(`UPDATE perf_experiments SET status='failed', error=?, finished_at=? WHERE id=?`)
        .run("perfcmp_failed", nowIso(), String(candidate.experiment_id));
      return { ok: false, reason: "perfcmp_failed" };
    }

    const candidateSummary = extractSummaryFromPerfBaseline(
      parseJson<unknown>(readFileSync(candidatePerfPath, "utf8"), {})
    );
    const cmpSummary = extractSummaryFromPerfCmp(parseJson<unknown>(readFileSync(perfcmpPath, "utf8"), {}));

    this.db
      .query(
        `INSERT INTO perf_metrics
         (id, run_id, scenario_id, runtime_p50_ns, runtime_p95_ns, runtime_p99_ns, compile_throughput_tps, allocs_per_request, dispatch_hit_ratio, cv_pct, confidence_pct, effect_pct, created_at)
         VALUES (?, ?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        perfRunId,
        candidateSummary.runtimeP50Ns,
        candidateSummary.runtimeP95Ns,
        candidateSummary.runtimeP99Ns,
        candidateSummary.compileThroughputTps,
        candidateSummary.allocsPerRequest,
        candidateSummary.dispatchHitRatio,
        candidateSummary.cvPct,
        this.config.confidencePct,
        this.config.minEffectPct,
        nowIso()
      );

    this.db
      .query(
        `INSERT INTO perf_metrics
         (id, run_id, scenario_id, runtime_p50_ns, runtime_p95_ns, runtime_p99_ns, compile_throughput_tps, allocs_per_request, dispatch_hit_ratio, cv_pct, confidence_pct, effect_pct, created_at)
         VALUES (?, ?, 'perfcmp', NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        perfcmpRunId,
        cmpSummary.medianLatencyGainPct,
        cmpSummary.unstableCount,
        cmpSummary.confidencePct,
        cmpSummary.effectPct,
        nowIso()
      );

    await this.recordArtifact("candidate", params.candidateId, "candidate_perf_json", candidatePerfPath);
    await this.recordArtifact("candidate", params.candidateId, "perfcmp_json", perfcmpPath);

    this.db
      .query(`UPDATE perf_candidates SET status='evaluated', updated_at=? WHERE id=?`)
      .run(nowIso(), params.candidateId);

    return { ok: true, reportPath: perfcmpPath };
  }

  async scoreDecision(params: { candidateId: string }): Promise<{
    decision: PerfScientistDecision;
    score: number;
    reason: string;
    shouldOpenPr: boolean;
  }> {
    const candidate = this.db
      .query(
        `SELECT id, experiment_id, risk_class
         FROM perf_candidates
         WHERE id=?
         LIMIT 1`
      )
      .get(params.candidateId) as SqlRecord | null;

    if (!candidate) {
      return { decision: "reject_noise", score: 0, reason: "candidate_not_found", shouldOpenPr: false };
    }

    const runs = this.db
      .query(
        `SELECT id, run_kind, artifact_path
         FROM perf_runs
         WHERE candidate_id=?
         ORDER BY started_at DESC`
      )
      .all(params.candidateId) as SqlRecord[];

    const perfRun = runs.find((row) => row.run_kind === "candidate");
    const cmpRun = runs.find((row) => row.run_kind === "perfcmp");

    if (!perfRun || !cmpRun || !perfRun.artifact_path || !cmpRun.artifact_path) {
      return { decision: "reject_noise", score: 0, reason: "missing_perf_artifacts", shouldOpenPr: false };
    }

    const candidateSummary = extractSummaryFromPerfBaseline(
      parseJson<unknown>(readFileSync(String(perfRun.artifact_path), "utf8"), {})
    );
    const cmpSummary = extractSummaryFromPerfCmp(
      parseJson<unknown>(readFileSync(String(cmpRun.artifact_path), "utf8"), {})
    );

    const latestBaselineRow = this.db
      .query(`SELECT summary_json FROM perf_baselines ORDER BY created_at DESC LIMIT 1`)
      .get() as SqlRecord | null;
    const baselineSummary = latestBaselineRow
      ? (parseJson<Record<string, unknown>>(latestBaselineRow.summary_json, {}) as Record<string, unknown>)
      : {};

    const baselineThroughput = asNumber(baselineSummary.compileThroughputTps, 0);
    const baselineAllocs = asNumber(baselineSummary.allocsPerRequest, 0);
    const baselineRcOps = asNumber(baselineSummary.rcOpsTotal, asNumber(baselineSummary.rc_ops_total, 0));

    const throughputGainPct =
      baselineThroughput > 0
        ? ((candidateSummary.compileThroughputTps - baselineThroughput) / baselineThroughput) * 100
        : 0;

    const allocRegressPct =
      baselineAllocs > 0 ? Math.max(0, ((candidateSummary.allocsPerRequest - baselineAllocs) / baselineAllocs) * 100) : 0;

    const rcRegressPct =
      baselineRcOps > 0 ? Math.max(0, ((candidateSummary.rcOpsTotal - baselineRcOps) / baselineRcOps) * 100) : 0;

    const breakdown = computeBalancedPerfScore({
      latencyGainPct: cmpSummary.medianLatencyGainPct,
      throughputGainPct,
      allocRegressPct,
      rcRegressPct,
    });

    const failsCv = candidateSummary.cvPct > this.config.cvMaxPct;
    const failsConfidence = cmpSummary.confidencePct < this.config.confidencePct;
    const failsEffect = Math.abs(cmpSummary.medianLatencyGainPct) < this.config.minEffectPct;
    const failsGate = !cmpSummary.gatePassed;

    let decision: PerfScientistDecision;
    let reason: string;
    if (failsGate || cmpSummary.regressionCount > 0 || breakdown.score <= 0) {
      decision = "reject_regression";
      reason = failsGate
        ? "kpi_gate_failed"
        : cmpSummary.regressionCount > 0
        ? "perfcmp_regression_detected"
        : "non_positive_balanced_score";
    } else if (failsCv || failsConfidence || failsEffect || cmpSummary.noSignalCount > 0) {
      decision = "reject_noise";
      reason = failsCv
        ? "cv_over_threshold"
        : failsConfidence
        ? "confidence_below_threshold"
        : failsEffect
        ? "effect_below_threshold"
        : "no_signal";
    } else {
      decision = "recommend";
      reason = "balanced_score_positive_and_all_gates_passed";
    }

    this.db
      .query(
        `INSERT INTO perf_decisions
         (id, candidate_id, decision, score, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), params.candidateId, decision, breakdown.score, reason, nowIso());

    this.db
      .query(`UPDATE perf_candidates SET status=?, updated_at=? WHERE id=?`)
      .run(decision === "recommend" ? "recommended" : "rejected", nowIso(), params.candidateId);

    if (decision !== "recommend") {
      this.db
        .query(`UPDATE perf_experiments SET status='completed', finished_at=? WHERE id=?`)
        .run(nowIso(), String(candidate.experiment_id));
    }

    const shouldOpenPr = decision === "recommend" && String(candidate.risk_class) === "low";
    applyPersonaSignal(this.db, {
      source: "aps_score_decide",
      confidence: 0.8,
      adjustments: [
        { trait: "proactivity", delta: decision === "recommend" ? 0.025 : -0.015 },
        { trait: "risk_tolerance_within_policy", delta: decision === "recommend" ? 0.01 : -0.012 },
        { trait: "notification_frequency", delta: decision === "reject_noise" ? -0.015 : 0.005 },
      ],
      context: {
        candidateId: params.candidateId,
        decision,
        score: Number(breakdown.score.toFixed(4)),
        reason,
        shouldOpenPr,
      },
    });
    await this.notify(
      `APS decision ${decision} for candidate ${params.candidateId}: score=${breakdown.score.toFixed(
        3
      )} reason=${reason}`
    );
    return { decision, score: breakdown.score, reason, shouldOpenPr };
  }

  async openDraftPr(params: { candidateId: string; runId: string }): Promise<{ ok: boolean; reason?: string; prNumber?: number }> {
    const candidate = this.db
      .query(
        `SELECT c.id, c.title, c.hypothesis, c.change_class, c.target_paths_json, c.risk_class,
                e.id AS experiment_id, e.branch_name
         FROM perf_candidates c
         JOIN perf_experiments e ON e.id = c.experiment_id
         WHERE c.id=?
         LIMIT 1`
      )
      .get(params.candidateId) as SqlRecord | null;

    if (!candidate) {
      return { ok: false, reason: "candidate_not_found" };
    }

    const branchName = String(candidate.branch_name ?? "").trim();
    if (!branchName) {
      return { ok: false, reason: "missing_branch" };
    }

    const changedFilesRes = runGit(this.config.repoPath, ["diff", "--name-only", `${this.config.baseRefForPerfCmp}...${branchName}`]);
    if (!changedFilesRes.ok) {
      return { ok: false, reason: "failed_to_read_diff" };
    }

    const files = changedFilesRes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (files.length === 0) {
      return { ok: false, reason: "no_diff_for_pr" };
    }

    if (files.length > this.config.maxAutoPrFiles) {
      return { ok: false, reason: "file_cap_exceeded" };
    }

    if (files.some((path) => this.isSensitivePath(path))) {
      return { ok: false, reason: "sensitive_path_detected" };
    }

    const shortstatRes = runGit(this.config.repoPath, ["diff", "--shortstat", `${this.config.baseRefForPerfCmp}...${branchName}`]);
    const loc = Number(shortstatRes.stdout.match(/(\d+) insertions?/)?.[1] ?? 0) +
      Number(shortstatRes.stdout.match(/(\d+) deletions?/)?.[1] ?? 0);

    if (loc > this.config.maxAutoPrLoc) {
      return { ok: false, reason: "loc_cap_exceeded" };
    }

    const testResult = await this.audit.runWithAudit(
      params.runId,
      this.config.testCommand,
      this.config.repoPath
    );
    if (testResult.exitCode !== 0) {
      await this.notify(`APS blocked draft PR for ${params.candidateId}: targeted tests failed`);
      return { ok: false, reason: "targeted_tests_failed" };
    }

    const decisions = this.db
      .query(
        `SELECT decision, score, reason, created_at
         FROM perf_decisions
         WHERE candidate_id=?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(params.candidateId) as SqlRecord | null;

    const artifacts = this.db
      .query(
        `SELECT artifact_type, path
         FROM perf_artifacts
         WHERE owner_type='candidate' AND owner_id=?
         ORDER BY created_at DESC`
      )
      .all(params.candidateId) as SqlRecord[];

    const bodyLines = [
      "## Autonomous Perf Scientist Result",
      "",
      `- Candidate: ${String(candidate.title)}`,
      `- Hypothesis: ${String(candidate.hypothesis)}`,
      `- Change class: ${String(candidate.change_class)}`,
      `- Risk class: ${String(candidate.risk_class)}`,
      decisions ? `- Balanced score: ${asNumber(decisions.score, 0).toFixed(3)}` : "- Balanced score: n/a",
      decisions ? `- Decision reason: ${String(decisions.reason)}` : "- Decision reason: n/a",
      "",
      "## Artifact Evidence",
      ...artifacts.map((artifact) => `- ${String(artifact.artifact_type)}: ${String(artifact.path)}`),
      "",
      "## Safety",
      "- Auto-merge disabled for APS v1",
      "- Low-risk path policy enforced",
      "",
      "-Codex Automated",
    ];

    try {
      const pr = await this.gh.createDraftPr({
        title: `[APS] ${String(candidate.title)}`,
        body: bodyLines.join("\n"),
        head: branchName,
        base: this.config.baseRefForPerfCmp,
      });

      this.db
        .query(
          `INSERT INTO perf_decisions
           (id, candidate_id, decision, score, reason, created_at)
           VALUES (?, ?, 'draft_pr_opened', ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          params.candidateId,
          asNumber(decisions?.score, 0),
          `draft_pr_opened:${pr.prNumber}`,
          nowIso()
        );

      this.db
        .query(`UPDATE perf_candidates SET status='pr_opened', updated_at=? WHERE id=?`)
        .run(nowIso(), params.candidateId);

      this.db
        .query(`UPDATE perf_experiments SET status='completed', finished_at=? WHERE id=?`)
        .run(nowIso(), String(candidate.experiment_id));

      applyPersonaSignal(this.db, {
        source: "aps_open_draft_pr",
        confidence: 0.86,
        adjustments: [
          { trait: "proactivity", delta: 0.03 },
          { trait: "decision_framing", delta: 0.02 },
          { trait: "directness", delta: 0.01 },
        ],
        context: {
          candidateId: params.candidateId,
          branchName,
          prNumber: pr.prNumber,
        },
      });

      await this.notify(`APS opened draft PR #${pr.prNumber} for candidate ${params.candidateId}`);

      return { ok: true, prNumber: pr.prNumber };
    } catch (error) {
      await this.notify(`APS failed opening draft PR for candidate ${params.candidateId}: ${String(error)}`);
      return { ok: false, reason: `gh_pr_create_failed:${String(error)}` };
    }
  }

  private isSensitivePath(path: string): boolean {
    return /(^|\/)(auth|billing|secret|secrets|migration|migrations|deploy|terraform|k8s|helm|infra)(\/|$)/.test(
      path
    );
  }

  private async recordArtifact(
    ownerType: "baseline" | "candidate" | "experiment",
    ownerId: string,
    artifactType: string,
    path: string
  ): Promise<void> {
    const digest = existsSync(path) ? sha256(readFileSync(path, "utf8")) : undefined;
    this.db
      .query(
        `INSERT INTO perf_artifacts
         (id, owner_type, owner_id, artifact_type, path, digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), ownerType, ownerId, artifactType, path, digest ?? null, nowIso());
  }

  private async recordBlockedDecision(triggerSource: string, reason: string): Promise<void> {
    const experimentId = crypto.randomUUID();
    const candidateId = crypto.randomUUID();

    this.db
      .query(
        `INSERT INTO perf_experiments
         (id, objective, status, trigger_source, base_commit_sha, started_at, finished_at, error)
         VALUES (?, 'balanced_score', 'failed', ?, 'unknown', ?, ?, ?)`
      )
      .run(experimentId, triggerSource, nowIso(), nowIso(), reason);

    this.db
      .query(
        `INSERT INTO perf_candidates
         (id, experiment_id, title, hypothesis, change_class, target_paths_json, risk_class, status, created_at, updated_at)
         VALUES (?, ?, 'APS blocked', ?, 'precheck', '[]', 'low', 'rejected', ?, ?)`
      )
      .run(candidateId, experimentId, reason, nowIso(), nowIso());

    this.db
      .query(
        `INSERT INTO perf_decisions
         (id, candidate_id, decision, score, reason, created_at)
         VALUES (?, ?, 'reject_noise', 0, ?, ?)`
      )
      .run(crypto.randomUUID(), candidateId, reason, nowIso());
  }

  private async notify(text: string): Promise<void> {
    void text;
  }
}
