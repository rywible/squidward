import { isAbsolute, normalize, resolve } from "node:path";

import { SqliteWorkerDb } from "./db";
import { SerializedTaskProcessor } from "./queue";
import { CodexSessionManager } from "./session-manager";
import {
  RealCodexCliAdapter,
  RealGithubGhAdapter,
  StubCodexCliAdapter,
  StubGithubGhAdapter,
  type CodexCliAdapter,
  type GithubGhAdapter,
} from "./adapters";
import { CommandAuditService } from "./audit";
import { WorkerRuntime, type WorkerTaskPayload } from "./runtime";
import { MoonshotEngine } from "./moonshot";
import { PerfScientist } from "./perf-scientist";
import { CodexHarness } from "./codex-harness";
import { MemoryGovernor } from "./memory-governor";
import { WrelaLearningService } from "./wrela-learning";
import { WorktreeManager } from "./worktree-manager";

const workspaceRoot = resolve(import.meta.dir, "../../..");
const resolveDbPath = (rawPath?: string): string => {
  if (!rawPath) {
    return normalize(resolve(workspaceRoot, ".data/agent.db"));
  }
  return normalize(isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath));
};

const dbPath = resolveDbPath(process.env.AGENT_DB_PATH);
const useStubExecutor = process.env.WORKER_USE_STUB_EXECUTOR === "1";

const db = new SqliteWorkerDb({ dbPath });
const queue = new SerializedTaskProcessor<WorkerTaskPayload>(db, { coalesceWindowMs: 15 * 60_000 });
const sessions = new CodexSessionManager(Number(process.env.MAX_CODEX_SESSIONS ?? 4));
const codexCli: CodexCliAdapter = useStubExecutor ? new StubCodexCliAdapter() : new RealCodexCliAdapter();
const ghAdapter: GithubGhAdapter = useStubExecutor ? new StubGithubGhAdapter() : new RealGithubGhAdapter();
const audit = new CommandAuditService(db, codexCli);
const moonshot = new MoonshotEngine(db.db);
const codexHarness = new CodexHarness(codexCli, db.db);
const memoryGovernor = new MemoryGovernor(db.db);
const worktrees = new WorktreeManager({
  rootDir: process.env.CODEX_WORKTREE_ROOT,
  baseRef: process.env.CODEX_WORKTREE_BASE_REF ?? "main",
  keepFailed: process.env.CODEX_WORKTREE_KEEP_FAILED !== "0",
});
const wrlelaLearning = new WrelaLearningService(
  db.db,
  process.env.PRIMARY_REPO_PATH ?? resolve(process.env.HOME ?? process.cwd(), "projects/wrela")
);
const perfScientist = new PerfScientist(
  db.db,
  audit,
  ghAdapter,
  {
  enabled: process.env.PERF_SCIENTIST_ENABLED === "1",
  repoPath:
    process.env.PERF_SCIENTIST_REPO_PATH ??
    process.env.PRIMARY_REPO_PATH ??
    resolve(process.env.HOME ?? process.cwd(), "projects/wrela"),
  benchmarkRoot:
    process.env.PERF_SCIENTIST_BENCHMARK_ROOT ??
    resolve(process.env.HOME ?? process.cwd(), "projects/wrela/benchmarks/macro"),
  manifestPath:
    process.env.PERF_SCIENTIST_MANIFEST_PATH ??
    resolve(process.env.HOME ?? process.cwd(), "projects/wrela/benchmarks/macro/bench.toml"),
  nightlyHour: Number(process.env.PERF_SCIENTIST_NIGHTLY_HOUR ?? 2),
  smokeOnChange: process.env.PERF_SCIENTIST_SMOKE_ON_CHANGE !== "0",
  standardRuns: Number(process.env.PERF_SCIENTIST_STANDARD_RUNS ?? 5),
  smokeRuns: Number(process.env.PERF_SCIENTIST_SMOKE_RUNS ?? 2),
  cvMaxPct: Number(process.env.PERF_SCIENTIST_CV_MAX_PCT ?? 5),
  minEffectPct: Number(process.env.PERF_SCIENTIST_MIN_EFFECT_PCT ?? 2),
  confidencePct: Number(process.env.PERF_SCIENTIST_CONFIDENCE_PCT ?? 95),
  maxAutoPrFiles: Number(process.env.PERF_SCIENTIST_MAX_AUTO_PR_FILES ?? 8),
  maxAutoPrLoc: Number(process.env.PERF_SCIENTIST_MAX_AUTO_PR_LOC ?? 250),
  baseRefForPerfCmp: process.env.PERF_SCIENTIST_BASE_REF ?? "main",
  patchCommandTemplate: process.env.PERF_SCIENTIST_PATCH_COMMAND_TEMPLATE,
  testCommand: process.env.PERF_SCIENTIST_TEST_COMMAND ?? "cargo test -q -p compiler --lib",
  },
);

const runtime = new WorkerRuntime({
  db,
  queue,
  sessions,
  audit,
  hasActiveIncident: async () => false,
  moonshot,
  perfScientist,
  codexHarness,
  memoryGovernor,
  worktrees,
  wrelaLearning: wrlelaLearning,
  config: {
    portfolioTopN: Number(process.env.PORTFOLIO_TOP_N ?? 5),
    portfolioMinEvAutorun: Number(process.env.PORTFOLIO_MIN_EV_AUTORUN ?? 1.25),
    testGenMaxCandidatesPerBug: Number(process.env.TEST_GEN_MAX_CANDIDATES_PER_BUG ?? 3),
    memoWeekday: Number(process.env.MEMO_WEEKDAY ?? 1),
    memoHour: Number(process.env.MEMO_HOUR ?? 9),
    graphReindexIntervalMinutes: Number(process.env.GRAPH_REINDEX_CRON ?? 60),
    primaryRepoPath:
      process.env.PRIMARY_REPO_PATH ?? resolve(process.env.HOME ?? process.cwd(), "projects/wrela"),
    retrievalBudgetTokens: Number(process.env.RETRIEVAL_BUDGET_TOKENS ?? 4000),
    maxSkillsPerMission: Number(process.env.MAX_SKILLS_PER_MISSION ?? 2),
    maxTasksPerHeartbeat: Number(process.env.MAX_TASKS_PER_HEARTBEAT ?? 8),
    maxCodexSessions: Number(process.env.MAX_CODEX_SESSIONS ?? 4),
    codexWorktreesEnabled: process.env.CODEX_WORKTREES_ENABLED !== "0",
    perfScientist: {
      enabled: process.env.PERF_SCIENTIST_ENABLED === "1",
      nightlyHour: Number(process.env.PERF_SCIENTIST_NIGHTLY_HOUR ?? 2),
      smokeOnChange: process.env.PERF_SCIENTIST_SMOKE_ON_CHANGE !== "0",
    },
  },
});

const writePreflightAudit = async (
  runId: string,
  command: string,
  ok: boolean,
  details: string[]
): Promise<void> => {
  const now = new Date();
  await db.appendCommandAudit({
    id: crypto.randomUUID(),
    runId,
    command,
    cwd: process.cwd(),
    startedAt: now,
    finishedAt: now,
    exitCode: ok ? 0 : 1,
    artifactRefs: details,
  });
};

const runStartupPreflight = async (): Promise<void> => {
  const runId = `startup-preflight:${new Date().toISOString()}`;
  const createdAt = new Date().toISOString();
  db.db
    .query(
      `INSERT OR IGNORE INTO agent_runs
       (id, trigger_type, objective, actions, outcome, rollback_flag, duration, created_at)
       VALUES (?, 'startup_preflight', 'Startup integration/tooling preflight', '[]', 'completed', 0, 0, ?)`
    )
    .run(runId, createdAt);

  try {
    const gh = await ghAdapter.preflightAuth();
    await writePreflightAudit(runId, "gh auth status", gh.ok, gh.details);
  } catch (error) {
    await writePreflightAudit(runId, "gh auth status", false, [String(error)]);
  }

  try {
    const codex = await codexCli.preflightAvailability();
    await writePreflightAudit(runId, "codex --version", codex.ok, codex.details);
  } catch (error) {
    await writePreflightAudit(runId, "codex --version", false, [String(error)]);
  }

  const codexAuthCommand = process.env.CODEX_PREFLIGHT_AUTH_COMMAND;
  if (codexAuthCommand) {
    try {
      const codexAuth = await codexCli.preflightAuth(codexAuthCommand);
      await writePreflightAudit(runId, codexAuthCommand, codexAuth.ok, codexAuth.details);
    } catch (error) {
      await writePreflightAudit(runId, codexAuthCommand, false, [String(error)]);
    }
  }
};

const bootstrapCommand = process.env.WORKER_BOOTSTRAP_COMMAND ?? "codex --help || true";

await runStartupPreflight();

await queue.enqueue({
  dedupeKey: "bootstrap",
  priority: "P2",
  payload: {
    taskType: "maintenance",
    runId: crypto.randomUUID(),
    command: bootstrapCommand,
    cwd: process.env.PRIMARY_REPO_PATH ?? resolve(process.env.HOME ?? process.cwd(), "projects/wrela"),
  },
});

await runtime.start();
console.log(`[worker] started with db=${dbPath} stubExecutor=${useStubExecutor} transport=web`);

process.on("SIGINT", () => {
  runtime.stop();
  process.exit(0);
});
