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

const extractDraftedQuotedReply = (summary: string): string | null => {
  if (!/\b(prepared|draft|dispatch|reply|response)\b/i.test(summary)) {
    return null;
  }
  const quoteMatch = summary.match(/["“]([^"”\n]{1,500})["”]/);
  if (!quoteMatch) {
    return null;
  }
  const candidate = quoteMatch[1].trim();
  return candidate.length > 0 ? candidate : null;
};

const toSlackUserReply = (summary: string): string => {
  const trimmed = summary.trim();
  if (!trimmed) {
    return "Done.";
  }
  const quoted = extractDraftedQuotedReply(trimmed);
  if (quoted) {
    return quoted;
  }
  const firstLine = trimmed.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  const reply = firstLine ?? trimmed;
  return reply.length > 1200 ? `${reply.slice(0, 1197)}...` : reply;
};

const isCodexContractFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /invalid_json_payload|codex_command_failed|invalid_status|missing_summary/i.test(message);
};

const quickSlackReply = (requestText?: string): string | null => {
  const text = requestText?.trim().toLowerCase() ?? "";
  if (!text) return null;

  const normalized = text.replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
  if (
    /^(you there|u there|are you there|ping|yo|hey|hi|hello|sup|what'?s up)$/.test(normalized) ||
    /^(you there squidward|ping squidward|hey squidward|hi squidward)$/.test(normalized)
  ) {
    return "Yes, I'm here-how can I help?";
  }

  if (/^(thanks|thank you|thx)$/.test(normalized)) {
    return "Anytime.";
  }

  return null;
};

const isLikelyHeavyRequestText = (text?: string): boolean => {
  const normalized = (text ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 220) return true;
  if (normalized.includes("```") || normalized.includes("`")) return true;
  if (/(fix|implement|build|refactor|optimize|benchmark|run tests?|open pr|create pr|review|debug|investigate|deploy|rollback)\b/.test(normalized)) {
    return true;
  }
  if (/(\/users\/|~\/projects\/|\.ts\b|\.tsx\b|\.rs\b|\.sql\b|\.json\b|error:|stack:)/.test(normalized)) {
    return true;
  }
  return false;
};

interface SlackLatencyStats {
  sampleSize: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;
}

const computeAdaptiveRetrievalBudget = (
  baseBudget: number,
  domain: string,
  stats?: SlackLatencyStats | null
): number => {
  const avgLatency = Number(stats?.avgLatencyMs ?? 0);
  const p95Latency = Number(stats?.p95LatencyMs ?? 0);
  const errorRate = Number(stats?.errorRate ?? 0);
  const minBudget = domain === "slack_chat" ? 300 : 700;
  if (p95Latency > 12000 || errorRate > 0.2) return Math.max(minBudget, Math.floor(baseBudget * 0.55));
  if (avgLatency > 7000 || p95Latency > 9000) return Math.max(minBudget, Math.floor(baseBudget * 0.65));
  if (avgLatency > 4000 || p95Latency > 6500) return Math.max(minBudget, Math.floor(baseBudget * 0.8));
  if (avgLatency > 0 && avgLatency < 1800 && p95Latency < 3500 && errorRate < 0.08) {
    return Math.min(baseBudget, Math.floor(baseBudget * 1.1));
  }
  return baseBudget;
};

const computeAdaptiveCodexTimeoutMs = (
  baseTimeoutMs: number,
  kind: "chat" | "mission",
  stats?: SlackLatencyStats | null
): number => {
  const avgLatency = Number(stats?.avgLatencyMs ?? 0);
  const p95Latency = Number(stats?.p95LatencyMs ?? 0);
  const errorRate = Number(stats?.errorRate ?? 0);
  const min = kind === "chat" ? 15_000 : 25_000;
  const max = kind === "chat" ? 120_000 : 180_000;
  if (p95Latency > 12_000 || errorRate > 0.2) return Math.max(min, Math.floor(baseTimeoutMs * 0.72));
  if (avgLatency > 7000 || p95Latency > 9000) return Math.max(min, Math.floor(baseTimeoutMs * 0.82));
  if (avgLatency > 0 && avgLatency < 2000 && p95Latency < 3500 && errorRate < 0.08) {
    return Math.min(max, Math.floor(baseTimeoutMs * 1.12));
  }
  return Math.max(min, Math.min(max, baseTimeoutMs));
};

export type WorkerTaskType =
  | "maintenance"
  | "owner_control"
  | "slack_chat_reply"
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
  | "perf_open_draft_pr"
  | "replay_eval_nightly"
  | "ci_red_autopilot"
  | "memory_contradiction_scan"
  | "latency_governor";

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
  controlAction?: "approve" | "deny" | "why" | "stop" | "pause" | "resume" | "replace";
  controlTarget?: string;
  controlText?: string;
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
    slackReservedSlots?: number;
    slackChatTimeoutMs?: number;
    slackMissionTimeoutMs?: number;
    codexWorktreesEnabled?: boolean;
    ciAutopilotEnabled?: boolean;
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
  private readonly sqliteDb:
    | {
        query: (sql: string) => {
          run: (...args: unknown[]) => unknown;
          get: (...args: unknown[]) => unknown;
          all: (...args: unknown[]) => unknown;
        };
      }
    | null;
  private readonly config: Required<NonNullable<WorkerRuntimeDeps["config"]>>;
  private readonly now: () => Date;
  private slackStatsCache: { expiresAtMs: number; value: SlackLatencyStats | null } = {
    expiresAtMs: 0,
    value: null,
  };
  private lastPortfolioAt = 0;
  private lastTestEvolutionAt = 0;
  private lastMemoAt = 0;
  private lastGraphAt = 0;
  private lastPerfBaselineAt = 0;
  private lastReplayEvalAt = 0;
  private lastCiAutopilotAt = 0;
  private lastMemoryScanAt = 0;
  private lastLatencyGovernorAt = 0;

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
    this.sqliteDb =
      (this.db as {
        db?: {
          query: (sql: string) => {
            run: (...args: unknown[]) => unknown;
            get: (...args: unknown[]) => unknown;
            all: (...args: unknown[]) => unknown;
          };
        };
      }).db ?? null;
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
      slackReservedSlots: Math.max(0, Math.min(8, deps.config?.slackReservedSlots ?? 2)),
      slackChatTimeoutMs: Math.max(10_000, Math.min(180_000, deps.config?.slackChatTimeoutMs ?? 45_000)),
      slackMissionTimeoutMs: Math.max(15_000, Math.min(240_000, deps.config?.slackMissionTimeoutMs ?? 90_000)),
      codexWorktreesEnabled: deps.config?.codexWorktreesEnabled ?? true,
      ciAutopilotEnabled: deps.config?.ciAutopilotEnabled ?? true,
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
            const modeNow = await this.db.getWorkerMode();
            if (modeNow === "paused") {
              break;
            }
            let claimed =
              i < this.config.slackReservedSlots
                ? await this.queue.claimNextWhere((candidate) => {
                    const payload =
                      candidate.payload && typeof candidate.payload === "object"
                        ? (candidate.payload as WorkerTaskPayload)
                        : null;
                    const type = payload?.taskType ?? "maintenance";
                    return (
                      type === "slack_chat_reply" ||
                      (type === "codex_mission" &&
                        payload?.domain === "slack" &&
                        typeof payload?.responseChannel === "string" &&
                        payload.responseChannel.length > 0)
                    );
                  })
                : null;
            if (!claimed) {
              claimed = await this.queue.claimNext();
            }
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

  private getSlackLatencyStats(): SlackLatencyStats | null {
    if (!this.sqliteDb) return null;
    const nowMs = this.now().getTime();
    if (nowMs < this.slackStatsCache.expiresAtMs) {
      return this.slackStatsCache.value;
    }

    const aggregate = this.sqliteDb
      .query(
        `SELECT
           COUNT(*) AS total,
           AVG(COALESCE(response_latency, 0)) AS avg_latency,
           AVG(
             CASE
               WHEN action_taken IN ('error_reply','codex_contract_fallback','codex_runtime_fallback') THEN 1
               ELSE 0
             END
           ) AS error_rate
         FROM interaction_events
         WHERE channel='slack'
           AND message_type IN ('slack_chat_reply','codex_mission')
           AND created_at >= datetime('now', '-6 hours')`
      )
      .get() as Record<string, unknown> | null;

    const total = Number(aggregate?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) {
      this.slackStatsCache = { expiresAtMs: nowMs + 60_000, value: null };
      return null;
    }

    const latencyCountRow = this.sqliteDb
      .query(
        `SELECT COUNT(*) AS count
         FROM interaction_events
         WHERE channel='slack'
           AND message_type IN ('slack_chat_reply','codex_mission')
           AND response_latency IS NOT NULL
           AND created_at >= datetime('now', '-6 hours')`
      )
      .get() as Record<string, unknown> | null;
    const latencyCount = Number(latencyCountRow?.count ?? 0);

    let p95 = Number(aggregate?.avg_latency ?? 0);
    if (latencyCount > 0) {
      const p95Offset = Math.max(0, Math.min(latencyCount - 1, Math.floor((latencyCount - 1) * 0.95)));
      const p95Row = this.sqliteDb
        .query(
          `SELECT response_latency
           FROM interaction_events
           WHERE channel='slack'
             AND message_type IN ('slack_chat_reply','codex_mission')
             AND response_latency IS NOT NULL
             AND created_at >= datetime('now', '-6 hours')
           ORDER BY response_latency ASC
           LIMIT 1 OFFSET ?`
        )
        .get(p95Offset) as Record<string, unknown> | null;
      p95 = Number(p95Row?.response_latency ?? p95);
    }

    const stats: SlackLatencyStats = {
      sampleSize: total,
      avgLatencyMs: Number(aggregate?.avg_latency ?? 0),
      p95LatencyMs: Number.isFinite(p95) ? p95 : Number(aggregate?.avg_latency ?? 0),
      errorRate: Number(aggregate?.error_rate ?? 0),
    };
    this.slackStatsCache = {
      expiresAtMs: nowMs + 60_000,
      value: stats,
    };
    return stats;
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
      if (taskType === "owner_control") {
        const action = task.controlAction;
        const target = task.controlTarget?.trim();
        const nowIso = this.now().toISOString();
        let ack = "Command processed.";
        if (!this.sqliteDb) {
          ack = "Control command unavailable: DB not initialized.";
        } else if (!action) {
          ack = "Missing control action.";
        } else if (action === "pause") {
          this.sqliteDb
            .query(
              `INSERT INTO worker_state (worker_id, state, heartbeat_at, metadata_json, updated_at)
               VALUES ('global', 'paused', ?, '{}', ?)
               ON CONFLICT(worker_id) DO UPDATE SET state='paused', heartbeat_at=excluded.heartbeat_at, updated_at=excluded.updated_at`
            )
            .run(nowIso, nowIso);
          ack = "Paused worker scheduling.";
        } else if (action === "resume") {
          this.sqliteDb
            .query(
              `INSERT INTO worker_state (worker_id, state, heartbeat_at, metadata_json, updated_at)
               VALUES ('global', 'active', ?, '{}', ?)
               ON CONFLICT(worker_id) DO UPDATE SET state='active', heartbeat_at=excluded.heartbeat_at, updated_at=excluded.updated_at`
            )
            .run(nowIso, nowIso);
          ack = "Resumed worker scheduling.";
        } else if (action === "stop") {
          if (!target) {
            ack = "Stop requires a run id.";
          } else {
            this.sqliteDb
              .query(
                `UPDATE task_queue
                 SET status='failed', last_error='interrupted_by_owner', updated_at=?
                 WHERE status IN ('queued','running')
                   AND (source_id=? OR json_extract(payload_json, '$.payload.runId')=?)`
              )
              .run(nowIso, target, target);
            this.sqliteDb
              .query(`UPDATE agent_runs SET outcome='cancelled' WHERE id=?`)
              .run(target);
            ack = `Stopped queued/running tasks for ${target}.`;
          }
        } else if (action === "replace") {
          if (!target || !(task.controlText ?? "").trim()) {
            ack = "Replace requires: replace <runId> <new objective>.";
          } else {
            this.sqliteDb
              .query(
                `UPDATE task_queue
                 SET status='failed', last_error='replaced_by_owner', updated_at=?
                 WHERE status IN ('queued','running')
                   AND (source_id=? OR json_extract(payload_json, '$.payload.runId')=?)`
              )
              .run(nowIso, target, target);
            await this.queue.enqueue({
              dedupeKey: `owner_replace:${Date.now()}`,
              priority: "P0",
              payload: {
                taskType: "codex_mission",
                runId: `run_replace_${Date.now()}`,
                domain: "slack",
                objective: task.controlText?.trim() ?? "Owner replacement mission",
                requestText: task.controlText?.trim() ?? "",
                responseChannel: task.responseChannel,
                repoPath: this.config.primaryRepoPath,
                cwd: this.config.primaryRepoPath,
                title: "Owner replacement mission",
              },
            });
            ack = `Replaced ${target} with new mission.`;
          }
        } else if (action === "why") {
          if (!target) {
            ack = "Why requires a run id.";
          } else {
            const run = this.sqliteDb
              .query(
                `SELECT objective, outcome, created_at
                 FROM agent_runs
                 WHERE id=?
                 LIMIT 1`
              )
              .get(target) as Record<string, unknown> | null;
            const audits = this.sqliteDb
              .query(
                `SELECT command, exit_code, artifact_refs
                 FROM command_audit
                 WHERE run_id=?
                 ORDER BY started_at DESC
                 LIMIT 2`
              )
              .all(target) as Array<Record<string, unknown>>;
            if (!run) {
              ack = `No run found: ${target}`;
            } else {
              const highlights = audits
                .map((row) => {
                  const cmd = String(row.command ?? "").slice(0, 80);
                  const code = Number(row.exit_code ?? -1);
                  return `${cmd} [exit=${code}]`;
                })
                .join(" | ");
              ack = `Run ${target}: ${String(run.outcome)}. Objective: ${String(run.objective)}.${highlights ? ` Recent: ${highlights}` : ""}`;
            }
          }
        } else if (action === "approve" || action === "deny") {
          if (!target) {
            ack = `${action} requires a run id.`;
          } else {
            this.sqliteDb
              .query(
                `INSERT INTO owner_feedback_events
                 (id, channel, feedback_type, label, notes, run_id, created_at)
                 VALUES (?, 'slack', ?, ?, ?, ?, ?)`
              )
              .run(
                crypto.randomUUID(),
                action === "approve" ? "owner_approve" : "owner_deny",
                target,
                task.controlText ?? null,
                target,
                nowIso
              );
            const decision = this.sqliteDb
              .query(
                `SELECT pd.id
                 FROM memory_episodes me
                 JOIN policy_decisions pd
                   ON pd.domain = json_extract(me.context_json, '$.domain')
                  AND pd.context_hash = json_extract(me.context_json, '$.contextHash')
                 WHERE me.run_id=?
                 ORDER BY pd.created_at DESC
                 LIMIT 1`
              )
              .get(target) as Record<string, unknown> | null;
            if (decision?.id) {
              const ownerSignal = action === "approve" ? 1 : -1;
              this.sqliteDb
                .query(
                  `INSERT INTO policy_rewards
                   (id, policy_decision_id, reward_total, reward_components_json, latency_minutes, created_at)
                   VALUES (?, ?, ?, ?, 0, ?)`
                )
                .run(
                  crypto.randomUUID(),
                  String(decision.id),
                  ownerSignal,
                  JSON.stringify({
                    reliability: 0,
                    completion: 0,
                    perfGain: 0,
                    ownerFeedback: ownerSignal,
                    noisePenalty: 0,
                  }),
                  nowIso
                );
            }
            ack = action === "approve" ? `Approved ${target}.` : `Denied ${target}.`;
          }
        }
        if (this.slack && task.responseChannel) {
          await this.slack.postMessage(task.responseChannel, ack);
        }
      } else if (taskType === "slack_chat_reply") {
        const instant = quickSlackReply(task.requestText);
        if (this.slack && task.responseChannel && instant) {
          await this.slack.postMessage(task.responseChannel, instant);
          if (this.sqliteDb) {
            this.sqliteDb
              .query(
                `INSERT INTO interaction_events
                 (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                 VALUES (?, 'slack', 'slack_chat_reply', ?, 'fast_path_reply', NULL, ?)`
              )
              .run(crypto.randomUUID(), Math.max(0, this.now().getTime() - startedAt.getTime()), this.now().toISOString());
          }
        } else if (this.slack && task.responseChannel && this.codexHarness) {
          try {
            const objective = task.objective ?? task.title ?? "Respond to Slack user message";
            const domain = "slack_chat";
            const slackStats = this.getSlackLatencyStats();
            const tokenEnvelope = buildTokenEnvelope(this.sqliteDb as never, domain);
            const missionPack = buildMissionPack({
              db: this.sqliteDb as never,
              task: {
                ...task,
                taskType: "slack_chat_reply",
              },
              repoPath: task.repoPath ?? this.config.primaryRepoPath,
              objective,
              tokenEnvelope,
              retrievalBudgetTokens: computeAdaptiveRetrievalBudget(
                Math.min(900, this.config.retrievalBudgetTokens),
                "slack_chat",
                slackStats
              ),
            });
            const parsed = await this.codexHarness.run({
              missionPack,
              objectiveDetails:
                task.requestText ??
                "Respond directly in Slack. Keep concise. Do not describe internal steps unless asked.",
              cwd: task.cwd ?? this.config.primaryRepoPath,
              model: task.model,
              timeoutMs: computeAdaptiveCodexTimeoutMs(this.config.slackChatTimeoutMs, "chat", slackStats),
            });
            await this.slack.postMessage(task.responseChannel, toSlackUserReply(parsed.payload.summary));
            if (this.sqliteDb) {
              this.sqliteDb
                .query(
                  `INSERT INTO interaction_events
                   (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                   VALUES (?, 'slack', 'slack_chat_reply', ?, 'codex_chat_reply', NULL, ?)`
                )
                .run(crypto.randomUUID(), Math.max(0, this.now().getTime() - startedAt.getTime()), this.now().toISOString());
            }
          } catch (error) {
            console.error("[worker] slack chat codex path failed:", error);
            await this.slack.postMessage(task.responseChannel, "I hit a response formatting issue. Please resend in one line and I’ll retry.");
            if (this.sqliteDb) {
              this.sqliteDb
                .query(
                  `INSERT INTO interaction_events
                   (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                   VALUES (?, 'slack', 'slack_chat_reply', ?, ?, NULL, ?)`
                )
                .run(
                  crypto.randomUUID(),
                  Math.max(0, this.now().getTime() - startedAt.getTime()),
                  isCodexContractFailure(error) ? "codex_contract_fallback" : "codex_runtime_fallback",
                  this.now().toISOString()
                );
            }
          }
        } else if (this.slack && task.responseChannel) {
          await this.slack.postMessage(task.responseChannel, "I’m here. What do you need?");
          if (this.sqliteDb) {
            this.sqliteDb
              .query(
                `INSERT INTO interaction_events
                 (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                 VALUES (?, 'slack', 'slack_chat_reply', ?, 'fallback_chat_reply', NULL, ?)`
              )
              .run(crypto.randomUUID(), Math.max(0, this.now().getTime() - startedAt.getTime()), this.now().toISOString());
          }
        }
      } else if (taskType === "codex_mission") {
        if (this.slack && task.responseChannel && task.domain === "slack") {
          const fastReply = quickSlackReply(task.requestText);
          if (fastReply) {
            await this.slack.postMessage(task.responseChannel, fastReply);
            await this.db.appendCommandAudit({
              id: crypto.randomUUID(),
              runId: task.runId,
              command: "internal:codex_mission_fast_reply",
              cwd: task.cwd ?? this.config.primaryRepoPath,
              startedAt,
              finishedAt: this.now(),
              exitCode: 0,
              artifactRefs: ["fast_path=slack_presence"],
            });
            return;
          }
        }
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
        const slackStats = domain === "slack" ? this.getSlackLatencyStats() : null;
        const tokenEnvelope = buildTokenEnvelope(this.sqliteDb as never, domain);
        const objective = task.objective ?? task.title ?? "Execute codex mission";
        const missionPack = buildMissionPack({
          db: this.sqliteDb as never,
          task,
          repoPath: canonicalRepoPath,
          objective,
          tokenEnvelope,
          retrievalBudgetTokens: computeAdaptiveRetrievalBudget(
            this.config.retrievalBudgetTokens,
            domain,
            slackStats
          ),
        });
        const parsed = await this.codexHarness.run({
          missionPack,
          objectiveDetails: task.requestText ?? task.command ?? objective,
          cwd: executionCwd,
          model: task.model,
          timeoutMs:
            task.domain === "slack"
              ? computeAdaptiveCodexTimeoutMs(this.config.slackMissionTimeoutMs, "mission", slackStats)
              : undefined,
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
          const reply = toSlackUserReply(parsed.payload.summary);
          console.log(
            `[worker] slack mission reply runId=${task.runId} status=${parsed.payload.status} queryId=${missionPack.context.retrieval.queryId} tokens=${missionPack.context.retrieval.usedTokens}/${missionPack.context.retrieval.budgetTokens}`
          );
          await this.slack.postMessage(task.responseChannel, reply);
          if (this.sqliteDb) {
            this.sqliteDb
              .query(
                `INSERT INTO interaction_events
                 (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                 VALUES (?, 'slack', 'codex_mission', ?, ?, NULL, ?)`
              )
              .run(
                crypto.randomUUID(),
                Math.max(0, this.now().getTime() - startedAt.getTime()),
                parsed.payload.status,
                this.now().toISOString()
              );
          }
        }
        missionSucceeded = true;
        } catch (error) {
          if (this.slack && task.responseChannel) {
            const fallback = isCodexContractFailure(error)
              ? "I hit a formatting issue while preparing that. Please resend your request in one line and I’ll retry."
              : `I hit an execution error on that run (${task.runId}). Please retry in a moment.`;
            await this.slack.postMessage(task.responseChannel, fallback);
            if (this.sqliteDb) {
              this.sqliteDb
                .query(
                  `INSERT INTO interaction_events
                   (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                   VALUES (?, 'slack', 'codex_mission', ?, ?, NULL, ?)`
                )
                .run(
                  crypto.randomUUID(),
                  Math.max(0, this.now().getTime() - startedAt.getTime()),
                  isCodexContractFailure(error) ? "codex_contract_fallback" : "codex_runtime_fallback",
                  this.now().toISOString()
                );
            }
          }
          throw error;
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
      } else if (taskType === "replay_eval_nightly") {
        if (this.sqliteDb) {
          const sample = this.sqliteDb
            .query(
              `SELECT COUNT(*) AS total
               FROM task_queue
               WHERE source_id LIKE 'run_slack_%'
                 AND task_type IN ('slack_chat_reply', 'codex_mission')
                 AND created_at >= datetime('now', '-7 day')`
            )
            .get() as Record<string, unknown>;
          const latency = this.sqliteDb
            .query(
              `SELECT AVG(COALESCE(response_latency, 0)) AS avg_latency
               FROM interaction_events
               WHERE channel='slack'
                 AND created_at >= datetime('now', '-7 day')`
            )
            .get() as Record<string, unknown>;
          const laneRows = this.sqliteDb
            .query(
              `SELECT task_type, payload_json
               FROM task_queue
               WHERE source_id LIKE 'run_slack_%'
                 AND task_type IN ('slack_chat_reply', 'codex_mission')
                 AND created_at >= datetime('now', '-7 day')
               LIMIT 500`
            )
            .all() as Array<Record<string, unknown>>;
          let matched = 0;
          for (const row of laneRows) {
            const lane = String(row.task_type ?? "");
            let requestText = "";
            try {
              const payload = JSON.parse(String(row.payload_json ?? "{}")) as {
                payload?: { requestText?: string };
              };
              requestText = payload.payload?.requestText ?? "";
            } catch {
              requestText = "";
            }
            const likelyHeavy = isLikelyHeavyRequestText(requestText);
            if ((lane === "slack_chat_reply" && !likelyHeavy) || (lane === "codex_mission" && likelyHeavy)) {
              matched += 1;
            }
          }
          const laneAccuracy = laneRows.length > 0 ? matched / laneRows.length : 1;
          this.sqliteDb
            .query(
              `INSERT INTO replay_eval_runs
               (id, sample_size, avg_latency_ms, lane_accuracy, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
              task.runId,
              Number(sample.total ?? 0),
              Number(latency.avg_latency ?? 0),
              laneAccuracy,
              "nightly replay eval v1",
              this.now().toISOString()
            );
        }
      } else if (taskType === "ci_red_autopilot") {
        if (this.config.ciAutopilotEnabled) {
          const cmd = "gh run list --limit 1 --json conclusion,status,headSha,url,name,workflowName";
          const ci = await this.audit.runWithAudit(task.runId, cmd, this.config.primaryRepoPath);
          const raw = ci.artifactRefs.find((item) => item.trim().startsWith("[")) ?? "[]";
          let parsed: Array<Record<string, unknown>> = [];
          try {
            parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
          } catch {
            parsed = [];
          }
          const latest = parsed[0];
          const isFailed =
            latest &&
            String(latest.status ?? "").toLowerCase() === "completed" &&
            String(latest.conclusion ?? "").toLowerCase() === "failure";
          const headSha = String(latest?.headSha ?? "");
          const now = this.now().toISOString();
          let alreadyQueuedForHead = false;
          if (this.sqliteDb && headSha) {
            const existing = this.sqliteDb
              .query(
                `SELECT last_enqueued_at
                 FROM ci_red_autopilot_heads
                 WHERE head_sha=?
                 LIMIT 1`
              )
              .get(headSha) as Record<string, unknown> | null;
            if (isFailed && existing?.last_enqueued_at) {
              alreadyQueuedForHead = true;
            }
          }
          if (isFailed && !alreadyQueuedForHead) {
            await this.queue.enqueue({
              dedupeKey: `ci_red_autopilot:${headSha || Date.now()}`,
              priority: "P1",
              payload: {
                taskType: "codex_mission",
                runId: `run_ci_autopilot_${Date.now()}`,
                domain: "triage",
                objective: "Investigate latest failed CI run and propose or draft a fix",
                requestText: `Latest failed CI run: ${JSON.stringify(latest)}. Produce fix plan and code changes.`,
                repoPath: this.config.primaryRepoPath,
                cwd: this.config.primaryRepoPath,
                title: "CI red autopilot mission",
              },
            });
            if (this.sqliteDb && headSha) {
              this.sqliteDb
                .query(
                  `INSERT INTO ci_red_autopilot_heads
                   (head_sha, first_seen_at, last_seen_at, last_enqueued_at, last_state, last_run_url)
                   VALUES (?, ?, ?, ?, 'failure', ?)
                   ON CONFLICT(head_sha) DO UPDATE SET
                     last_seen_at=excluded.last_seen_at,
                     last_enqueued_at=excluded.last_enqueued_at,
                     last_state=excluded.last_state,
                     last_run_url=excluded.last_run_url`
                )
                .run(headSha, now, now, now, String(latest?.url ?? ""));
            }
          } else if (this.sqliteDb && headSha) {
            this.sqliteDb
              .query(
                `INSERT INTO ci_red_autopilot_heads
                 (head_sha, first_seen_at, last_seen_at, last_enqueued_at, last_state, last_run_url)
                 VALUES (?, ?, ?, NULL, 'ok', ?)
                 ON CONFLICT(head_sha) DO UPDATE SET
                   last_seen_at=excluded.last_seen_at,
                   last_state=excluded.last_state,
                   last_run_url=excluded.last_run_url`
              )
              .run(headSha, now, now, String(latest?.url ?? ""));
          }
        }
      } else if (taskType === "memory_contradiction_scan") {
        if (this.sqliteDb) {
          const rows = this.sqliteDb
            .query(
              `SELECT mf.fact_key AS fact_key,
                      mf.fact_value_json AS canonical_value_json,
                      rlf.fact_value_json AS repo_value_json
               FROM memory_facts mf
               JOIN repo_learning_facts rlf ON rlf.fact_key = mf.fact_key
               WHERE mf.namespace='canonical'
                 AND mf.state IN ('active', 'proposed')
                 AND mf.fact_value_json <> rlf.fact_value_json
               LIMIT 50`
            )
            .all() as Array<Record<string, unknown>>;
          for (const row of rows) {
            const factKey = String(row.fact_key ?? "");
            const existing = this.sqliteDb
              .query(
                `SELECT id FROM memory_contradictions
                 WHERE fact_key=? AND status='open'
                 LIMIT 1`
              )
              .get(factKey) as Record<string, unknown> | null;
            if (existing) continue;
            this.sqliteDb
              .query(
                `INSERT INTO memory_contradictions
                 (id, fact_key, canonical_value_json, repo_value_json, status, created_at)
                 VALUES (?, ?, ?, ?, 'open', ?)`
              )
              .run(
                crypto.randomUUID(),
                factKey,
                String(row.canonical_value_json ?? "{}"),
                String(row.repo_value_json ?? "{}"),
                this.now().toISOString()
              );
          }
        }
      } else if (taskType === "latency_governor") {
        if (this.sqliteDb) {
          const row = this.sqliteDb
            .query(
              `SELECT AVG(COALESCE(response_latency, 0)) AS avg_latency
               FROM interaction_events
               WHERE channel='slack'
                 AND created_at >= datetime('now', '-1 day')`
            )
            .get() as Record<string, unknown>;
          const avgLatency = Number(row.avg_latency ?? 0);
          const budget = this.sqliteDb
            .query(
              `SELECT id, soft_cap, hard_cap
               FROM token_budgets
               WHERE window='monthly' AND domain='slack_chat'
               LIMIT 1`
            )
            .get() as Record<string, unknown> | null;
          if (budget) {
            let soft = Number(budget.soft_cap ?? 12000);
            let hard = Number(budget.hard_cap ?? 22000);
            if (avgLatency > 6000) {
              soft = Math.max(4000, Math.floor(soft * 0.9));
              hard = Math.max(8000, Math.floor(hard * 0.9));
            } else if (avgLatency > 0 && avgLatency < 2500) {
              soft = Math.min(30000, Math.floor(soft * 1.05));
              hard = Math.min(50000, Math.floor(hard * 1.05));
            }
            this.sqliteDb
              .query(
                `UPDATE token_budgets
                 SET soft_cap=?, hard_cap=?, updated_at=?
                 WHERE id=?`
              )
              .run(soft, hard, this.now().toISOString(), String(budget.id));
          }
        }
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
      if ((task.taskType === "codex_mission" || task.taskType === "slack_chat_reply") && this.slack && task.responseChannel) {
        const text =
          (task.domain ?? "").startsWith("slack")
            ? "I hit an internal error handling that. Try again in a few seconds."
            : `Run ${task.runId}: failed\n${String(error)}`;
        try {
          await this.slack.postMessage(task.responseChannel, text);
          if (this.sqliteDb) {
            this.sqliteDb
              .query(
                `INSERT INTO interaction_events
                 (id, channel, message_type, response_latency, action_taken, sentiment_score, created_at)
                 VALUES (?, 'slack', ?, ?, 'error_reply', NULL, ?)`
              )
              .run(
                crypto.randomUUID(),
                task.taskType ?? "unknown",
                Math.max(0, this.now().getTime() - startedAt.getTime()),
                this.now().toISOString()
              );
          }
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

    if (nowMs - this.lastReplayEvalAt >= 24 * 60 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "replay_eval_nightly",
        priority: "P2",
        payload: {
          taskType: "replay_eval_nightly",
          runId: `run_replay_eval_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "Nightly replay eval",
        },
      });
      this.lastReplayEvalAt = nowMs;
    }

    if (nowMs - this.lastCiAutopilotAt >= 15 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "ci_red_autopilot",
        priority: "P1",
        payload: {
          taskType: "ci_red_autopilot",
          runId: `run_ci_red_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "CI red autopilot",
        },
      });
      this.lastCiAutopilotAt = nowMs;
    }

    if (nowMs - this.lastMemoryScanAt >= 60 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "memory_contradiction_scan",
        priority: "P2",
        payload: {
          taskType: "memory_contradiction_scan",
          runId: `run_memory_scan_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "Memory contradiction scan",
        },
      });
      this.lastMemoryScanAt = nowMs;
    }

    if (nowMs - this.lastLatencyGovernorAt >= 15 * 60 * 1000) {
      await this.queue.enqueue({
        dedupeKey: "latency_governor",
        priority: "P1",
        payload: {
          taskType: "latency_governor",
          runId: `run_latency_governor_${nowMs}`,
          cwd: this.config.primaryRepoPath,
          title: "Latency/token governor",
        },
      });
      this.lastLatencyGovernorAt = nowMs;
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
