import type { WorkerDb } from "./db";
import type { SchedulerMode } from "./types";
import type { SlackAdapter } from "./adapters";
import { schedulerIntervalMs, selectSchedulerMode } from "./scheduler";
import { SerializedTaskProcessor } from "./queue";
import { CodexSessionManager } from "./session-manager";
import { CommandAuditService } from "./audit";
import { MoonshotEngine } from "./moonshot";
import { PerfScientist, type PerfScientistConfig } from "./perf-scientist";
import { CodexHarness } from "./codex-harness";
import { MemoryGovernor } from "./memory-governor";
import { WrelaLearningService } from "./wrela-learning";
import { buildMissionPack } from "./mission-pack";
import { buildTokenEnvelope } from "./token-economy";
import { recordReward } from "./reward-engine";
import { WorktreeManager } from "./worktree-manager";

export type WorkerTaskType =
  | "maintenance"
  | "codex_mission"
  | "portfolio_eval"
  | "test_gen"
  | "memo_build"
  | "graph_reindex"
  | "perf_baseline_nightly"
  | "perf_detect_change_smoke"
  | "perf_generate_candidates"
  | "perf_run_candidate"
  | "perf_score_decide"
  | "perf_open_draft_pr";

export interface WorkerTaskPayload {
  taskType?: WorkerTaskType;
  runId: string;
  command?: string;
  objective?: string;
  domain?: string;
  model?: string;
  cwd?: string;
  responseChannel?: string;
  responseThreadTs?: string;
  requestText?: string;
  repoPath?: string;
  title?: string;
  candidateId?: string;
  profile?: "smoke" | "standard" | "deep";
  triggerSource?: string;
}

export interface WorkerRuntimeDeps {
  db: WorkerDb;
  queue: SerializedTaskProcessor<WorkerTaskPayload>;
  sessions: CodexSessionManager;
  audit: CommandAuditService;
  hasActiveIncident: () => Promise<boolean>;
  moonshot: MoonshotEngine;
  perfScientist?: PerfScientist;
  codexHarness?: CodexHarness;
  memoryGovernor?: MemoryGovernor;
  wrelaLearning?: WrelaLearningService;
  worktrees?: WorktreeManager;
  slack?: SlackAdapter;
  config?: {
    portfolioTopN?: number;
    portfolioMinEvAutorun?: number;
    testGenMaxCandidatesPerBug?: number;
    memoWeekday?: number;
    memoHour?: number;
    graphReindexIntervalMinutes?: number;
    primaryRepoPath?: string;
    retrievalBudgetTokens?: number;
    maxTasksPerHeartbeat?: number;
    maxCodexSessions?: number;
    codexWorktreesEnabled?: boolean;
    perfScientist?: Partial<PerfScientistConfig>;
  };
  now?: () => Date;
}

export class WorkerRuntime {
  private readonly db: WorkerDb;
  private readonly queue: SerializedTaskProcessor<WorkerTaskPayload>;
  private readonly sessions: CodexSessionManager;
  private readonly audit: CommandAuditService;
  private readonly hasActiveIncident: () => Promise<boolean>;
  private readonly moonshot: MoonshotEngine;
  private readonly perfScientist: PerfScientist | null;
  private readonly codexHarness: CodexHarness | null;
  private readonly memoryGovernor: MemoryGovernor | null;
  private readonly wrelaLearning: WrelaLearningService | null;
  private readonly worktrees: WorktreeManager | null;
  private readonly slack: SlackAdapter | null;
  private readonly sqliteDb: { query: (sql: string) => { run: (...args: unknown[]) => unknown } } | null;
  private readonly config: Required<NonNullable<WorkerRuntimeDeps["config"]>>;
  private readonly now: () => Date;
  private lastPortfolioAt = 0;
  private lastTestEvolutionAt = 0;
  private lastMemoAt = 0;
  private lastGraphAt = 0;
  private lastPerfBaselineAt = 0;

  private mode: SchedulerMode = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private heartbeating = false;
  private heartbeatPending = false;

  constructor(deps: WorkerRuntimeDeps) {
    this.db = deps.db;
    this.queue = deps.queue;
    this.sessions = deps.sessions;
    this.audit = deps.audit;
    this.hasActiveIncident = deps.hasActiveIncident;
    this.moonshot = deps.moonshot;
    this.perfScientist = deps.perfScientist ?? null;
    this.codexHarness = deps.codexHarness ?? null;
    this.memoryGovernor = deps.memoryGovernor ?? null;
    this.wrelaLearning = deps.wrelaLearning ?? null;
    this.worktrees = deps.worktrees ?? null;
    this.slack = deps.slack ?? null;
    this.sqliteDb = (this.db as { db?: { query: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db ?? null;
    this.config = {
      portfolioTopN: deps.config?.portfolioTopN ?? 5,
      portfolioMinEvAutorun: deps.config?.portfolioMinEvAutorun ?? 1.25,
      testGenMaxCandidatesPerBug: deps.config?.testGenMaxCandidatesPerBug ?? 3,
      memoWeekday: deps.config?.memoWeekday ?? 1,
      memoHour: deps.config?.memoHour ?? 9,
      graphReindexIntervalMinutes: deps.config?.graphReindexIntervalMinutes ?? 60,
      primaryRepoPath: deps.config?.primaryRepoPath ?? process.cwd(),
      retrievalBudgetTokens: Math.max(512, Math.min(16000, deps.config?.retrievalBudgetTokens ?? 4000)),
      maxTasksPerHeartbeat: Math.max(1, Math.min(50, deps.config?.maxTasksPerHeartbeat ?? 8)),
      maxCodexSessions: Math.max(1, Math.min(16, deps.config?.maxCodexSessions ?? 4)),
      codexWorktreesEnabled: deps.config?.codexWorktreesEnabled ?? true,
      perfScientist: {
        enabled: deps.config?.perfScientist?.enabled ?? false,
        nightlyHour: deps.config?.perfScientist?.nightlyHour ?? 2,
        smokeOnChange: deps.config?.perfScientist?.smokeOnChange ?? true,
      },
    };
    this.now = deps.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.heartbeat();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async heartbeat(): Promise<void> {
    if (this.heartbeating) {
      this.heartbeatPending = true;
      return;
    }
    this.heartbeating = true;
    try {
      const now = this.now();
      await this.enqueueScheduledJobs(now);
      const workerMode = await this.db.getWorkerMode();
      const queueDepthBefore = await this.db.countReadyQueueItems(now);
      const hasQueuedWork = queueDepthBefore > 0;
      const incident = await this.hasActiveIncident();
      const nextMode = selectSchedulerMode({
        now,
        hasQueuedWork,
        hasActiveIncident: incident,
      });
      this.mode = nextMode;

      await this.db.saveWorkerState({
        mode: nextMode,
        heartbeatAt: now,
        queueDepth: queueDepthBefore,
        activeSessionId: this.sessions.getActiveSession()?.id ?? null,
      });

      if (workerMode !== "paused") {
        try {
          const availableSlots = Math.max(0, Math.min(this.config.maxTasksPerHeartbeat, this.sessions.getAvailableSlots()));
          const work: Array<Promise<void>> = [];
          for (let i = 0; i < availableSlots; i += 1) {
            const claimed = await this.queue.claimNext();
            if (!claimed) {
              break;
            }
            const session = this.sessions.start(claimed.id);
            const payload =
              claimed.payload && typeof claimed.payload === "object"
                ? (claimed.payload as WorkerTaskPayload)
                : ({
                    taskType: "maintenance",
                    runId: claimed.id,
                    command: "true",
                    cwd: this.config.primaryRepoPath,
                    title: "Recovered malformed queue payload",
                  } as WorkerTaskPayload);
            work.push(
              (async () => {
                let success = true;
                try {
                  await this.executeTask(payload);
                } catch (error) {
                  success = false;
                  console.error("[worker] task execution failed:", error);
                } finally {
                  await this.queue.finalize(claimed.id, success);
                  this.sessions.end(session.id);
                }
              })()
            );
          }
          if (work.length > 0) {
            await Promise.allSettled(work);
          }
        } catch (error) {
          console.error("[worker] task execution failed:", error);
        }
      }

      const postRunNow = this.now();
      await this.db.saveWorkerState({
        mode: this.mode,
        heartbeatAt: postRunNow,
        queueDepth: await this.db.countReadyQueueItems(postRunNow),
        activeSessionId: this.sessions.getActiveSession()?.id ?? null,
      });

      this.scheduleNext();
    } finally {
      this.heartbeating = false;
      if (this.heartbeatPending) {
        this.heartbeatPending = false;
        queueMicrotask(() => {
          void this.heartbeat();
        });
      }
    }
  }

  async poke(): Promise<void> {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.heartbeat();
  }

  private scheduleNext(): void {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }

    const waitMs = schedulerIntervalMs(this.mode);
    this.timer = setTimeout(() => {
      void this.heartbeat();
    }, waitMs);
  }

  private async executeTask(task: WorkerTaskPayload): Promise<void> {
    if (!task || typeof task !== "object") {
      task = {
        taskType: "maintenance",
        runId: crypto.randomUUID(),
        command: "true",
        cwd: this.config.primaryRepoPath,
        title: "Recovered invalid task payload",
      };
    }
    const taskType = task.taskType ?? "maintenance";
    console.log(`[worker] executing task type=${taskType} runId=${task.runId}`);
    if (taskType === "maintenance") {
      await this.audit.runWithAudit(task.runId, task.command ?? "true", task.cwd ?? process.cwd());
      return;
    }

    const startedAt = this.now();
    try {
      if (taskType === "codex_mission") {
        if (!this.codexHarness || !this.memoryGovernor) {
          throw new Error("codex_harness_not_configured");
        }
        const canonicalRepoPath = task.repoPath ?? this.config.primaryRepoPath;
        let executionCwd = task.cwd ?? canonicalRepoPath;
        let lease: { cleanup(success: boolean): void; path: string } | null = null;
        let missionSucceeded = false;
        if (this.worktrees && this.config.codexWorktreesEnabled) {
          lease = this.worktrees.acquire(canonicalRepoPath, task.runId);
          executionCwd = lease.path;
        }
        try {
        const domain = task.domain ?? "general";
        const tokenEnvelope = buildTokenEnvelope(this.sqliteDb as never, domain);
        const objective = task.objective ?? task.title ?? "Execute codex mission";
        const missionPack = buildMissionPack({
          db: this.sqliteDb as never,
          task,
          repoPath: canonicalRepoPath,
          objective,
          tokenEnvelope,
          retrievalBudgetTokens: this.config.retrievalBudgetTokens,
        });
        const parsed = await this.codexHarness.run({
          missionPack,
          objectiveDetails: task.requestText ?? task.command ?? objective,
          cwd: executionCwd,
          model: task.model,
        });
        const memoryResult = this.memoryGovernor.commit(task.runId, parsed.payload.memoryProposals, "codex_harness");
        if (this.sqliteDb) {
          this.sqliteDb
            .query(
              `INSERT INTO memory_episodes
               (id, run_id, trigger_type, context_json, actions_json, outcome_json, created_at)
               VALUES (?, ?, 'codex_mission', ?, ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              task.runId,
              JSON.stringify({
                taskType: "codex_mission",
                contextHash: parsed.contextHash,
                domain,
                retrieval: {
                  queryId: missionPack.context.retrieval.queryId,
                  intent: missionPack.context.retrieval.intent,
                  usedTokens: missionPack.context.retrieval.usedTokens,
                  budgetTokens: missionPack.context.retrieval.budgetTokens,
                  evidenceRefs: missionPack.context.retrieval.evidenceRefs.slice(0, 20),
                },
              }),
              JSON.stringify(parsed.payload.actionsTaken),
              JSON.stringify({
                status: parsed.payload.status,
                summary: parsed.payload.summary,
                acceptedMemoryWrites: memoryResult.accepted,
              }),
              this.now().toISOString()
            );

          const armId = `arm_${domain}_default`;
          this.sqliteDb
            .query(
              `INSERT OR IGNORE INTO policy_arms (id, domain, name, config_json, active)
               VALUES (?, ?, 'default', '{}', 1)`
            )
            .run(armId, domain);
          const policyDecisionId = crypto.randomUUID();
          this.sqliteDb
            .query(
              `INSERT INTO policy_decisions
               (id, domain, context_hash, arm_id, decision_reason, explore_flag, created_at)
               VALUES (?, ?, ?, ?, ?, 0, ?)`
            )
            .run(
              policyDecisionId,
              domain,
              parsed.contextHash,
              armId,
              parsed.payload.status === "done" ? "mission_completed" : "mission_blocked",
              this.now().toISOString()
            );
          recordReward(this.sqliteDb as never, {
            policyDecisionId,
            reliability: parsed.payload.status === "done" ? 1 : -0.2,
            completion: parsed.payload.status === "done" ? 1 : -0.4,
            perfGain: 0,
            ownerFeedback: 0,
            noisePenalty: -0.1,
            latencyMinutes: 0,
          });
        }
        this.wrelaLearning?.ingestRun(
          task.runId,
          parsed.payload.status === "done" ? "success" : "failed",
          objective
        );
        if (this.slack && task.responseChannel) {
          const evidenceRefs = missionPack.context.retrieval.evidenceRefs.slice(0, 6);
          const reply = [
            `Run ${task.runId}: ${parsed.payload.status}`,
            parsed.payload.summary,
            `Retrieval query: ${missionPack.context.retrieval.queryId} (${missionPack.context.retrieval.usedTokens}/${missionPack.context.retrieval.budgetTokens} tokens)`,
            parsed.payload.nextSteps.length > 0 ? `Next: ${parsed.payload.nextSteps.slice(0, 3).join(" | ")}` : "",
            evidenceRefs.length > 0 ? `Evidence: ${evidenceRefs.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          await this.slack.postMessage(task.responseChannel, reply, { threadTs: task.responseThreadTs });
        }
        missionSucceeded = true;
        } finally {
          if (lease) {
            try {
              lease.cleanup(missionSucceeded);
            } catch (cleanupError) {
              console.error("[worker] failed to cleanup worktree lease:", cleanupError);
            }
          }
        }
      } else if (taskType === "portfolio_eval") {
        this.moonshot.runPortfolioRankerDaily(this.config.portfolioTopN, this.config.portfolioMinEvAutorun);
        await this.queue.enqueue({
          dedupeKey: "codex_mission:portfolio_eval",
          priority: "P2",
          payload: {
            taskType: "codex_mission",
            runId: `run_codex_portfolio_${Date.now()}`,
            domain: "triage",
            objective: "Summarize top portfolio opportunities and propose next actions",
            command: "Analyze latest portfolio rankings and return an action plan.",
            repoPath: this.config.primaryRepoPath,
            cwd: this.config.primaryRepoPath,
            title: "Codex portfolio triage mission",
          },
        });
      } else if (taskType === "test_gen") {
        this.moonshot.runTestEvolutionContinuous(this.config.testGenMaxCandidatesPerBug);
      } else if (taskType === "memo_build") {
        this.moonshot.runCtoMemoWeekly();
      } else if (taskType === "graph_reindex") {
        this.moonshot.runGraphIndexerIncremental(task.repoPath ?? this.config.primaryRepoPath);
      } else if (taskType === "perf_baseline_nightly" || taskType === "perf_detect_change_smoke") {
        if (!this.perfScientist) {
          throw new Error("perf_scientist_not_configured");
        }
        const profile = task.profile ?? (taskType === "perf_detect_change_smoke" ? "smoke" : "standard");
        const runs = profile === "smoke" ? this.perfScientist.getConfig().smokeRuns : this.perfScientist.getConfig().standardRuns;
        const baseline = await this.perfScientist.runBaseline({
          runId: task.runId,
          profile,
          triggerSource: task.triggerSource ?? taskType,
          runs,
        });
        if (baseline.ok) {
          await this.queue.enqueue({
            dedupeKey: `perf_generate_candidates:${task.triggerSource ?? taskType}`,
            priority: "P1",
            payload: {
              taskType: "perf_generate_candidates",
              runId: `run_perf_generate_${Date.now()}`,
              cwd: this.config.primaryRepoPath,
              triggerSource: task.triggerSource ?? taskType,
              title: "Generate APS candidates",
            },
          });
        }
      } else if (taskType === "perf_generate_candidates") {
        if (!this.perfScientist) {
          throw new Error("perf_scientist_not_configured");
        }
        const generated = await this.perfScientist.generateCandidates({
          runId: task.runId,
          triggerSource: task.triggerSource ?? "scheduled",
          objective: "balanced_score",
          maxCandidates: 1,
        });
        for (const candidateId of generated.candidateIds) {
          await this.queue.enqueue({
            dedupeKey: `codex_mission:aps:${candidateId}`,
            priority: "P1",
            payload: {
              taskType: "codex_mission",
              runId: `run_codex_aps_${Date.now()}`,
              domain: "aps",
              objective: `Analyze APS candidate ${candidateId} and propose the safest perf patch strategy`,
              command: `Use current repo context to suggest patch approach for APS candidate ${candidateId}.`,
              repoPath: this.config.primaryRepoPath,
              cwd: this.config.primaryRepoPath,
              candidateId,
              title: `Codex APS analysis ${candidateId}`,
            },
          });
          await this.queue.enqueue({
            dedupeKey: `perf_run_candidate:${candidateId}`,
            priority: "P1",
            payload: {
              taskType: "perf_run_candidate",
              runId: `run_perf_candidate_${Date.now()}`,
              candidateId,
              profile: "standard",
              triggerSource: task.triggerSource ?? "scheduled",
              title: `Run APS candidate ${candidateId}`,
            },
          });
        }
      } else if (taskType === "perf_run_candidate") {
        if (!this.perfScientist) {
          throw new Error("perf_scientist_not_configured");
        }
        if (!task.candidateId) {
          throw new Error("missing_candidate_id");
        }
        const runResult = await this.perfScientist.runCandidate({
          runId: task.runId,
          candidateId: task.candidateId,
          profile: task.profile ?? "standard",
          runs: this.perfScientist.getConfig().standardRuns,
        });
        if (runResult.ok) {
          await this.queue.enqueue({
            dedupeKey: `perf_score_decide:${task.candidateId}`,
            priority: "P1",
            payload: {
              taskType: "perf_score_decide",
              runId: `run_perf_score_${Date.now()}`,
              candidateId: task.candidateId,
              title: `Score APS candidate ${task.candidateId}`,
            },
          });
        }
      } else if (taskType === "perf_score_decide") {
        if (!this.perfScientist) {
          throw new Error("perf_scientist_not_configured");
        }
        if (!task.candidateId) {
          throw new Error("missing_candidate_id");
        }
        const decision = await this.perfScientist.scoreDecision({ candidateId: task.candidateId });
        if (decision.shouldOpenPr) {
          await this.queue.enqueue({
            dedupeKey: `perf_open_draft_pr:${task.candidateId}`,
            priority: "P1",
            payload: {
              taskType: "perf_open_draft_pr",
              runId: `run_perf_pr_${Date.now()}`,
              candidateId: task.candidateId,
              title: `Open APS draft PR ${task.candidateId}`,
            },
          });
        }
      } else if (taskType === "perf_open_draft_pr") {
        if (!this.perfScientist) {
          throw new Error("perf_scientist_not_configured");
        }
        if (!task.candidateId) {
          throw new Error("missing_candidate_id");
        }
        await this.perfScientist.openDraftPr({ candidateId: task.candidateId, runId: task.runId });
      }
      await this.db.appendCommandAudit({
        id: crypto.randomUUID(),
        runId: task.runId,
        command: `internal:${taskType}`,
        cwd: task.cwd ?? this.config.primaryRepoPath,
        startedAt,
        finishedAt: this.now(),
        exitCode: 0,
        artifactRefs: [`taskType=${taskType}`],
      });
    } catch (error) {
      if (task.taskType === "codex_mission" && this.slack && task.responseChannel) {
        const text = `Run ${task.runId}: failed\n${String(error)}`;
        try {
          await this.slack.postMessage(task.responseChannel, text, { threadTs: task.responseThreadTs });
        } catch (postError) {
          console.error("[worker] failed to post Slack error reply:", postError);
        }
      }
      await this.db.appendCommandAudit({
        id: crypto.randomUUID(),
        runId: task.runId,
        command: `internal:${taskType}`,
        cwd: task.cwd ?? this.config.primaryRepoPath,
        startedAt,
        finishedAt: this.now(),
        exitCode: 1,
        artifactRefs: [String(error)],
      });
      throw error;
    }
  }

  private async enqueueScheduledJobs(now: Date): Promise<void> {
    const nowMs = now.getTime();
    if (nowMs - this.lastPortfolioAt >= 24 * 60 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "portfolio_ranker_daily",
        priority: "P1",
        payload: {
          taskType: "portfolio_eval",
          runId: `run_portfolio_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "Daily portfolio ranker",
        },
      });
      this.lastPortfolioAt = nowMs;
    }

    if (nowMs - this.lastTestEvolutionAt >= 10 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "test_evolution_continuous",
        priority: "P1",
        payload: {
          taskType: "test_gen",
          runId: `run_testgen_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "Continuous test evolution",
        },
      });
      this.lastTestEvolutionAt = nowMs;
    }

    const isMemoWindow = now.getDay() === this.config.memoWeekday && now.getHours() === this.config.memoHour;
    if (isMemoWindow && nowMs - this.lastMemoAt >= 20 * 60 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "cto_memo_weekly",
        priority: "P2",
        payload: {
          taskType: "memo_build",
          runId: `run_memo_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "Weekly CTO memo synthesis",
        },
      });
      this.lastMemoAt = nowMs;
    }

    if (nowMs - this.lastGraphAt >= this.config.graphReindexIntervalMinutes * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "graph_indexer_incremental",
        priority: "P2",
        payload: {
          taskType: "graph_reindex",
          runId: `run_graph_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          repoPath: this.config.primaryRepoPath,
          title: "Incremental architecture graph indexer",
        },
      });
      this.lastGraphAt = nowMs;
    }

    const apsEnabled = this.config.perfScientist.enabled && this.perfScientist;
    if (apsEnabled) {
      const currentHour = now.getHours();
      const nightlyHour = this.config.perfScientist.nightlyHour;
      const inNightlyWindow = currentHour === nightlyHour;
      if (inNightlyWindow && nowMs - this.lastPerfBaselineAt >= 20 * 60 * 60 * 1000) {
        await this.queue.enqueue({
          dedupeKey: "perf_baseline_nightly",
          priority: "P1",
          payload: {
            taskType: "perf_baseline_nightly",
            runId: `run_perf_nightly_${nowMs}`,
            profile: "standard",
            triggerSource: "nightly",
            title: "APS nightly baseline",
          },
        });
        this.lastPerfBaselineAt = nowMs;
      }

      if (this.config.perfScientist.smokeOnChange) {
        const change = this.perfScientist.detectQualifyingHeadChange();
        if (change.changed) {
          await this.queue.enqueue({
            dedupeKey: `perf_detect_change_smoke:${change.head}`,
            priority: "P1",
            payload: {
              taskType: "perf_detect_change_smoke",
              runId: `run_perf_smoke_${nowMs}`,
              profile: "smoke",
              triggerSource: "head_change",
              title: "APS smoke on qualifying code change",
            },
          });
        }
      }
    }
  }
}
