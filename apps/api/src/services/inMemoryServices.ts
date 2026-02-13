import { buildHash64Embedding, Database } from "@squidward/db";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  ActionRequest,
  ActionResponse,
  AutonomyDecision,
  AutonomyFunnel,
  AutonomyStatus,
  AuditEntry,
  BraveBudgetResponse,
  CtoMemo,
  Conversation,
  ConversationMessage,
  ConversationRun,
  ConversationState,
  CockpitSnapshot,
  EvidencePath,
  GeneratedTestCandidate,
  ImpactReport,
  MemoryEpisode,
  MemoryFact,
  PerfArtifact,
  PerfBaseline,
  PerfCandidate,
  PerfDecision,
  PerfExperiment,
  PerfMetric,
  PerfRun,
  PerfScientistStatus,
  PolicyHistoryItem,
  PolicyStatus,
  RetrievalContextPack,
  RetrievalFeedbackEvent,
  RetrievalQueryLog,
  RetrievalResultItem,
  RetrievalStatus,
  MemoRecommendation,
  PersonaTrait,
  PortfolioCandidate,
  PortfolioDecision,
  QueueTask,
  RepoCompetenceSnapshot,
  RepoLearningFact,
  RegressionProof,
  RunSummary,
  SystemOverview,
  TokenEconomyStatus,
  TokenUsageItem,
  TaskAction,
  TestEvolutionResult,
} from "../types/contracts";
import type { Services } from "./interfaces";

interface ServiceOptions {
  dbPath: string;
}

const workspaceRoot = resolve(import.meta.dir, "../../../..");
const resolveDbPath = (rawPath?: string): string => {
  if (!rawPath) {
    return resolve(workspaceRoot, ".data/agent.db");
  }
  return isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath);
};

type SqlRecord = Record<string, unknown>;

const monthKey = (): string => new Date().toISOString().slice(0, 7);
const nowIso = (): string => new Date().toISOString();
const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonObject = <T extends object>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
};

const parseCursor = (cursor?: string): { createdAt: string; id: string } | null => {
  if (!cursor) return null;
  const [createdAt, id] = cursor.split("|");
  if (!createdAt || !id) return null;
  return { createdAt, id };
};

const toCursor = (createdAt: string, id: string): string => `${createdAt}|${id}`;

const autoTitleFromMessage = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 64);
const shouldAutoRetitleConversation = (title: string): boolean =>
  /^(new conversation|general|focus actions)$/i.test(title.trim());

const clampLimit = (value: number | undefined, fallback: number, max: number): number => {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  const bounded = Math.trunc(Number(value));
  return Math.max(1, Math.min(bounded, max));
};

const toQueuePriority = (priority: number): QueueTask["priority"] => {
  if (priority <= 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "normal";
  return "low";
};

const toQueueStatus = (status: string): QueueTask["status"] => {
  switch (status) {
    case "queued":
    case "running":
    case "paused":
    case "blocked":
    case "failed":
    case "completed":
      return status;
    case "done":
      return "completed";
    default:
      return "queued";
  }
};

const toRunStatus = (outcome: string): RunSummary["status"] => {
  switch (outcome) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "failed":
    case "failure":
      return "failed";
    case "cancelled":
      return "stopped";
    case "queued":
      return "queued";
    default:
      return "completed";
  }
};

const toAlertState = (consumed: number, cap: number): BraveBudgetResponse["alertState"] => {
  const ratio = cap > 0 ? consumed / cap : 0;
  if (ratio >= 1) return "blocked_100";
  if (ratio >= 0.9) return "warning_90";
  if (ratio >= 0.7) return "warning_70";
  return "normal";
};

const isSqliteLockedError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("database is locked") || message.includes("sqlite_busy");
};

const waitMs = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const withDbWriteRetry = async <T>(operation: () => T, retries = 6): Promise<T> => {
  let attempt = 0;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteLockedError(error) || attempt >= retries) {
        throw error;
      }
      const backoffMs = Math.min(750, 30 * 2 ** attempt);
      attempt += 1;
      await waitMs(backoffMs);
    }
  }
};

const migrate = (db: Database): void => {
  const migrationPath = resolve(import.meta.dir, "../../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
};

const ensureSeed = (db: Database): void => {
  const now = nowIso();
  const currentMonth = monthKey();

  db.query(
    `INSERT OR IGNORE INTO worker_state (worker_id, state, heartbeat_at, metadata_json, updated_at)
     VALUES ('global', 'active', ?, '{}', ?)`
  ).run(now, now);

  db.query(
    `INSERT OR IGNORE INTO provider_budget_usage
      (id, provider, month, consumed_units, cap_units, alert_state, updated_at)
     VALUES ('brave_' || ?, 'brave', ?, 0, 2000, 'normal', ?)`
  ).run(currentMonth, currentMonth, now);

  db.query(
    `INSERT OR IGNORE INTO autonomy_settings
     (id, enabled, hourly_budget, updated_at)
     VALUES ('global', 1, 2, ?)`
  ).run(now);

  const tokenBudgets: Array<{ domain: string; soft: number; hard: number }> = [
    { domain: "general", soft: 50000, hard: 100000 },
    { domain: "aps", soft: 40000, hard: 80000 },
    { domain: "memo", soft: 25000, hard: 45000 },
    { domain: "chat", soft: 20000, hard: 35000 },
    { domain: "triage", soft: 30000, hard: 60000 },
  ];
  for (const budget of tokenBudgets) {
    db.query(
      `INSERT OR IGNORE INTO token_budgets
       (id, window, domain, soft_cap, hard_cap, updated_at)
       VALUES (?, 'monthly', ?, ?, ?, ?)`
    ).run(`tok_${budget.domain}`, budget.domain, budget.soft, budget.hard, now);
  }

  const traits = [
    "verbosity",
    "directness",
    "challenge_level",
    "proactivity",
    "notification_frequency",
    "decision_framing",
    "risk_tolerance_within_policy",
    "supportiveness",
  ];

  for (const trait of traits) {
    db.query(
      `INSERT OR IGNORE INTO persona_traits (id, trait_name, value, confidence, source, updated_at)
       VALUES (?, ?, 0.7, 0.8, 'seed', ?)`
    ).run(`trait_${trait}`, trait, now);
  }

  const existingRun = db.query("SELECT id FROM agent_runs LIMIT 1").get() as SqlRecord | null;
  if (!existingRun) {
    const runId = `run_${Date.now()}`;
    db.query(
      `INSERT INTO agent_runs (id, trigger_type, objective, actions, outcome, rollback_flag, duration, created_at)
       VALUES (?, 'manual', 'Initial bootstrap run', '[]', 'completed', 0, 0, ?)`
    ).run(runId, now);

    db.query(
      `INSERT INTO task_queue
       (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
       VALUES (?, ?, 'maintenance', '{"title":"Bootstrap queue item"}', 3, 'queued', ?, ?, ?)`
    ).run(`task_${Date.now()}`, runId, now, now, now);
  }
};

const actionMessage = (action: TaskAction, input: ActionRequest): string => {
  if (action === "retry") {
    return input.taskId ? `Task ${input.taskId} scheduled for retry.` : "Retry accepted.";
  }
  if (action === "stop") {
    return input.taskId ? `Task ${input.taskId} marked as stopped.` : "Stop accepted.";
  }
  if (action === "pause") return "Worker paused.";
  return "Worker resumed.";
};

export const createInMemoryServices = (options?: ServiceOptions): Services => {
  const dbPath = resolveDbPath(options?.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: false });
  migrate(db);
  ensureSeed(db);

  const getRuns = (): RunSummary[] => {
    const rows = db
      .query(
        `SELECT id, trigger_type, objective, outcome, duration, rollback_flag, created_at
         FROM agent_runs
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .all() as SqlRecord[];

    return rows.map((row) => ({
      id: String(row.id),
      objective: String(row.objective),
      triggerType: String(row.trigger_type),
      status: toRunStatus(String(row.outcome)),
      startedAt: String(row.created_at),
      updatedAt: String(row.created_at),
      durationMs: Number(row.duration ?? 0),
      rollbackFlag: Boolean(row.rollback_flag),
    }));
  };

  const getQueue = (): QueueTask[] => {
    const rows = db
      .query(
        `SELECT id, source_id, payload_json, priority, status, created_at, updated_at
         FROM task_queue
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, priority ASC, created_at ASC
         LIMIT 500`
      )
      .all() as SqlRecord[];

    return rows.map((row) => {
      const payload = parseJsonObject<{
        title?: string;
        payload?: { title?: string; command?: string };
      }>(String(row.payload_json), {});
      const titleFromPayload =
        payload.title ??
        payload.payload?.title ??
        (payload.payload?.command ? `Cmd: ${payload.payload.command}` : undefined);

      return {
        id: String(row.id),
        runId: String(row.source_id),
        title: titleFromPayload ?? `Task ${String(row.id).slice(0, 8)}`,
        priority: toQueuePriority(Number(row.priority ?? 3)),
        status: toQueueStatus(String(row.status)),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  };

  const getAudit = (): AuditEntry[] => {
    const rows = db
      .query(
        `SELECT id, COALESCE(run_id, '') AS run_id, command, cwd, started_at, finished_at, exit_code
         FROM command_audit
         ORDER BY started_at DESC
         LIMIT 500`
      )
      .all() as SqlRecord[];

    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      command: String(row.command),
      cwd: String(row.cwd),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      exitCode: row.exit_code === null ? undefined : Number(row.exit_code),
    }));
  };

  const buildMemoById = (id: string): CtoMemo | null => {
    const row = db
      .query(
        `SELECT id, week_start, week_end, summary_md, evidence_links, created_at
         FROM cto_memos
         WHERE id = ?
         LIMIT 1`
      )
      .get(id) as SqlRecord | null;
    if (!row) return null;
    const recommendations = (db
      .query(
        `SELECT id, recommendation_type, title, rationale, expected_value, evidence_links
         FROM memo_recommendations
         WHERE memo_id = ?
         ORDER BY created_at DESC`
      )
      .all(id) as SqlRecord[]).map(
      (rec): MemoRecommendation => ({
        id: String(rec.id),
        recommendationType: String(rec.recommendation_type),
        title: String(rec.title),
        rationale: String(rec.rationale),
        expectedValue: Number(rec.expected_value ?? 0),
        evidenceLinks: parseJsonObject<string[]>(rec.evidence_links, []),
      })
    );
    const asks = (db
      .query(`SELECT id, prompt, impact, due_hint FROM decision_asks WHERE memo_id = ? ORDER BY created_at DESC`)
      .all(id) as SqlRecord[]).map((ask) => ({
      id: String(ask.id),
      prompt: String(ask.prompt),
      impact: String(ask.impact),
      dueHint: ask.due_hint ? String(ask.due_hint) : undefined,
    }));
    return {
      id: String(row.id),
      weekStart: String(row.week_start),
      weekEnd: String(row.week_end),
      summaryMd: String(row.summary_md),
      evidenceLinks: parseJsonObject<string[]>(row.evidence_links, []),
      recommendations,
      asks,
      createdAt: String(row.created_at),
    };
  };

  const mapConversation = (row: SqlRecord): Conversation => ({
    id: String(row.id),
    title: String(row.title),
    status: (String(row.status) === "archived" ? "archived" : "active") as Conversation["status"],
    lastMessageAt: row.last_message_at ? String(row.last_message_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  const mapConversationMessage = (row: SqlRecord): ConversationMessage => ({
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: (["user", "assistant", "system"].includes(String(row.role)) ? String(row.role) : "assistant") as ConversationMessage["role"],
    mode: (String(row.mode) === "mission" ? "mission" : "chat") as ConversationMessage["mode"],
    status: (["queued", "running", "done", "blocked", "failed"].includes(String(row.status)) ? String(row.status) : "done") as ConversationMessage["status"],
    content: String(row.content ?? ""),
    runId: row.run_id ? String(row.run_id) : undefined,
    retrievalQueryId: row.retrieval_query_id ? String(row.retrieval_query_id) : undefined,
    evidenceRefs: parseJsonObject<string[]>(row.evidence_refs_json, []),
    tokenInput: row.token_input === null || row.token_input === undefined ? undefined : Number(row.token_input),
    tokenOutput: row.token_output === null || row.token_output === undefined ? undefined : Number(row.token_output),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? undefined : Number(row.latency_ms),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  const mapConversationRun = (row: SqlRecord): ConversationRun => ({
    id: String(row.id),
    conversationId: String(row.conversation_id),
    userMessageId: String(row.user_message_id),
    assistantMessageId: row.assistant_message_id ? String(row.assistant_message_id) : undefined,
    runId: String(row.run_id),
    lane: (String(row.lane) === "mission" ? "mission" : "chat") as ConversationRun["lane"],
    status: (["queued", "running", "done", "blocked", "failed"].includes(String(row.status)) ? String(row.status) : "queued") as ConversationRun["status"],
    errorText: row.error_text ? String(row.error_text) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  const compactConversationMessages = (rows: ConversationMessage[], keepRaw = 8): { summary: string; turns: number } => {
    const bounded = rows.slice(0, Math.max(0, rows.length - keepRaw));
    if (bounded.length === 0) {
      return { summary: "", turns: 0 };
    }
    const lines = bounded.map((message) => {
      const who = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
      const compact = message.content.replace(/\s+/g, " ").trim().slice(0, 220);
      return `${who}: ${compact}`;
    });
    return {
      summary: lines.join("\n"),
      turns: bounded.length,
    };
  };

  return {
    dashboard: {
      async getCockpit(): Promise<CockpitSnapshot> {
        const runs = getRuns();
        const queue = getQueue();
        const activeRuns = runs.filter((run) => run.status === "running").length;
        const queuedTasks = queue.filter((task) => task.status === "queued" || task.status === "running").length;

        return {
          generatedAt: nowIso(),
          activeRuns,
          queuedTasks,
          incidentsOpen: 0,
          approvalsPending: queue.filter((task) => task.status === "blocked").length,
          health: "ok",
          latestRun: runs[0],
        };
      },
    },

    runs: {
      async listRuns() {
        return getRuns();
      },
    },

    queue: {
      async listQueue() {
        return getQueue();
      },
    },

    audit: {
      async listAudit() {
        return getAudit();
      },
    },

    persona: {
      async listTraits(): Promise<PersonaTrait[]> {
        const rows = db
          .query(
            `SELECT trait_name, value, confidence, source, updated_at
             FROM persona_traits
             ORDER BY trait_name ASC`
          )
          .all() as SqlRecord[];

        return rows.map((row) => ({
          name: String(row.trait_name),
          value: Number(row.value).toFixed(2),
          confidence: Number(row.confidence),
          source: String(row.source),
          updatedAt: String(row.updated_at),
        }));
      },
    },

    system: {
      async getOverview(): Promise<SystemOverview> {
        const state = db
          .query(
            `SELECT state, heartbeat_at
             FROM worker_state
             WHERE worker_id = 'global'`
          )
          .get() as SqlRecord | null;

        const queueDepthRow = db
          .query(`SELECT COUNT(*) AS count FROM task_queue WHERE status IN ('queued','running')`)
          .get() as SqlRecord;

        return {
          generatedAt: nowIso(),
          mode: state?.state === "paused" ? "idle" : "active",
          uptimeSeconds: Number(process.uptime()),
          memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          cpuPercent: 0,
          queueDepth: Number(queueDepthRow.count ?? 0),
          activeIncidents: 0,
          policyDenialsLastHour: 0,
        };
      },
    },

    budget: {
      async getBraveBudget(): Promise<BraveBudgetResponse> {
        const row = db
          .query(
            `SELECT consumed_units, cap_units
             FROM provider_budget_usage
             WHERE provider='brave' AND month=?`
          )
          .get(monthKey()) as SqlRecord | null;

        const consumedUnits = Number(row?.consumed_units ?? 0);
        const capUnits = Number(row?.cap_units ?? 2000);

        return {
          provider: "brave",
          month: monthKey(),
          consumedUnits,
          capUnits,
          percentUsed: capUnits > 0 ? Math.round((consumedUnits / capUnits) * 100) : 0,
          alertState: toAlertState(consumedUnits, capUnits),
        };
      },
    },

    actions: {
      async pause(): Promise<ActionResponse> {
        const now = nowIso();
        db.query(
          `UPDATE worker_state
           SET state='paused', updated_at=?, heartbeat_at=?
           WHERE worker_id='global'`
        ).run(now, now);

        return { ok: true, message: actionMessage("pause", {}), updatedAt: now };
      },

      async resume(): Promise<ActionResponse> {
        const now = nowIso();
        db.query(
          `UPDATE worker_state
           SET state='active', updated_at=?, heartbeat_at=?
           WHERE worker_id='global'`
        ).run(now, now);

        return { ok: true, message: actionMessage("resume", {}), updatedAt: now };
      },

      async retryTask(input: ActionRequest): Promise<ActionResponse> {
        const now = nowIso();
        if (input.taskId) {
          db.query(
            `UPDATE task_queue
             SET status='queued', last_error=NULL, updated_at=?
             WHERE id=?`
          ).run(now, input.taskId);
        }

        return { ok: true, message: actionMessage("retry", input), updatedAt: now };
      },

      async stopTask(input: ActionRequest): Promise<ActionResponse> {
        const now = nowIso();
        if (input.taskId) {
          db.query(
            `UPDATE task_queue
             SET status='failed', last_error='stopped_by_user', updated_at=?
             WHERE id=?`
          ).run(now, input.taskId);
        }

        return { ok: true, message: actionMessage("stop", input), updatedAt: now };
      },
    },

    portfolio: {
      async listTop(limit: number): Promise<PortfolioCandidate[]> {
        const rows = db
          .query(
            `WITH latest_scores AS (
               SELECT candidate_id, MAX(scored_at) AS scored_at
               FROM portfolio_scores
               GROUP BY candidate_id
             )
             SELECT pc.id, pc.source_type, pc.source_ref, pc.title, pc.summary, pc.risk_class, pc.effort_class, pc.evidence_links,
                    ps.impact, ps.confidence, ps.urgency, ps.risk, ps.effort, ps.ev, ps.scored_at
             FROM latest_scores ls
             JOIN portfolio_scores ps
               ON ps.candidate_id = ls.candidate_id
              AND ps.scored_at = ls.scored_at
             JOIN portfolio_candidates pc
               ON pc.id = ls.candidate_id
             ORDER BY ps.ev DESC, ps.scored_at DESC
             LIMIT ?`
          )
          .all(Math.max(1, Math.min(limit || 5, 100))) as SqlRecord[];

        return rows.map((row) => ({
          id: String(row.id),
          sourceType: String(row.source_type),
          sourceRef: String(row.source_ref),
          title: String(row.title),
          summary: String(row.summary),
          riskClass: String(row.risk_class),
          effortClass: String(row.effort_class),
          evidenceLinks: parseJsonObject<string[]>(row.evidence_links, []),
          score: {
            impact: Number(row.impact ?? 0),
            confidence: Number(row.confidence ?? 0),
            urgency: Number(row.urgency ?? 0),
            risk: Number(row.risk ?? 0),
            effort: Number(row.effort ?? 0),
            ev: Number(row.ev ?? 0),
          },
          scoredAt: String(row.scored_at),
        }));
      },
      async listHistory(from?: string, to?: string, cursor?: string, limit = 25): Promise<{
        items: PortfolioDecision[];
        nextCursor?: string;
      }> {
        const parsedCursor = parseCursor(cursor);
        const params: Array<string | number> = [];
        let whereClause = "WHERE 1=1";
        if (from) {
          whereClause += " AND pd.created_at >= ?";
          params.push(from);
        }
        if (to) {
          whereClause += " AND pd.created_at <= ?";
          params.push(to);
        }
        if (parsedCursor) {
          whereClause += " AND (pd.created_at < ? OR (pd.created_at = ? AND pd.id < ?))";
          params.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        params.push(Math.max(1, Math.min(limit, 200)) + 1);

        const rows = db
          .query(
            `SELECT pd.id, pd.decision, pd.reason, pd.threshold, pd.created_at, ps.candidate_id
             FROM portfolio_decisions pd
             JOIN portfolio_scores ps ON ps.id = pd.score_id
             ${whereClause}
             ORDER BY pd.created_at DESC, pd.id DESC
             LIMIT ?`
          )
          .all(...params) as SqlRecord[];

        const hasMore = rows.length > Math.max(1, Math.min(limit, 200));
        const itemsRows = hasMore ? rows.slice(0, limit) : rows;
        const items = itemsRows.map((row) => ({
          id: String(row.id),
          candidateId: String(row.candidate_id),
          decision: String(row.decision),
          reason: String(row.reason),
          threshold: Number(row.threshold ?? 0),
          createdAt: String(row.created_at),
        }));

        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
    },

    testEvolution: {
      async getStats(): Promise<TestEvolutionResult> {
        const row = db
          .query(
            `SELECT COALESCE(SUM(candidates_generated),0) AS generated,
                    COALESCE(SUM(candidates_accepted),0) AS accepted,
                    MAX(created_at) AS last_run_at
             FROM test_evolution_runs`
          )
          .get() as SqlRecord;

        const generated = Number(row.generated ?? 0);
        const accepted = Number(row.accepted ?? 0);
        return {
          generated,
          accepted,
          acceptanceRate: generated > 0 ? Number((accepted / generated).toFixed(4)) : 0,
          lastRunAt: row.last_run_at ? String(row.last_run_at) : undefined,
        };
      },
      async listCandidates(status?: string, cursor?: string, limit = 25): Promise<{
        items: GeneratedTestCandidate[];
        provenance: RegressionProof[];
        nextCursor?: string;
      }> {
        const parsedCursor = parseCursor(cursor);
        const params: Array<string | number> = [];
        let whereClause = "WHERE 1=1";
        if (status) {
          whereClause += " AND tc.status = ?";
          params.push(status);
        }
        if (parsedCursor) {
          whereClause += " AND (tc.created_at < ? OR (tc.created_at = ? AND tc.id < ?))";
          params.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        params.push(Math.max(1, Math.min(limit, 200)) + 1);

        const rows = db
          .query(
            `SELECT tc.id, tc.bug_ref, tc.language, tc.framework, tc.test_path, tc.status, tc.score, tc.validation_notes, tc.created_at
             FROM test_candidates tc
             ${whereClause}
             ORDER BY tc.created_at DESC, tc.id DESC
             LIMIT ?`
          )
          .all(...params) as SqlRecord[];

        const hasMore = rows.length > Math.max(1, Math.min(limit, 200));
        const itemsRows = hasMore ? rows.slice(0, limit) : rows;

        const items = itemsRows.map((row) => ({
          id: String(row.id),
          bugRef: String(row.bug_ref),
          language: String(row.language),
          framework: String(row.framework),
          testPath: String(row.test_path),
          status: String(row.status),
          score: Number(row.score ?? 0),
          validationNotes: String(row.validation_notes ?? ""),
          createdAt: String(row.created_at),
        }));

        const ids = items.map((item) => item.id);
        let provenance: RegressionProof[] = [];
        if (ids.length > 0) {
          const ph = ids.map(() => "?").join(",");
          const provRows = db
            .query(
              `SELECT test_candidate_id, source_type, source_ref
               FROM test_provenance_links
               WHERE test_candidate_id IN (${ph})`
            )
            .all(...ids) as SqlRecord[];
          provenance = provRows.map((row) => ({
            candidateId: String(row.test_candidate_id),
            bugRef: items.find((item) => item.id === String(row.test_candidate_id))?.bugRef ?? "",
            sourceType: String(row.source_type),
            sourceRef: String(row.source_ref),
          }));
        }

        return {
          items,
          provenance,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
    },

    memos: {
      async getLatest(): Promise<CtoMemo | null> {
        const row = db
          .query(
            `SELECT id, week_start, week_end, summary_md, evidence_links, created_at
             FROM cto_memos
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get() as SqlRecord | null;
        if (!row) return null;
        return buildMemoById(String(row.id));
      },
      async listHistory(cursor?: string, limit = 10): Promise<{ items: CtoMemo[]; nextCursor?: string }> {
        const parsedCursor = parseCursor(cursor);
        const params: Array<string | number> = [];
        let whereClause = "";
        if (parsedCursor) {
          whereClause = "WHERE (created_at < ? OR (created_at = ? AND id < ?))";
          params.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        params.push(Math.max(1, Math.min(limit, 100)) + 1);

        const rows = db
          .query(
            `SELECT id, week_start, week_end, summary_md, evidence_links, created_at
             FROM cto_memos
             ${whereClause}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          )
          .all(...params) as SqlRecord[];

        const hasMore = rows.length > Math.max(1, Math.min(limit, 100));
        const memoRows = hasMore ? rows.slice(0, limit) : rows;
        const items: CtoMemo[] = [];
        for (const row of memoRows) {
          const memo = buildMemoById(String(row.id));
          if (memo) items.push(memo);
        }

        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
    },

    graph: {
      async impact(query: string): Promise<ImpactReport> {
        const nodes = db
          .query(
            `SELECT id, node_type, ref, label
             FROM graph_nodes
             WHERE ref LIKE ? OR label LIKE ?
             ORDER BY created_at DESC
             LIMIT 40`
          )
          .all(`%${query}%`, `%${query}%`) as SqlRecord[];
        const nodeIds = nodes.map((row) => String(row.id));
        const edges =
          nodeIds.length === 0
            ? []
            : ((db
                .query(
                  `SELECT id, from_node_id, to_node_id, edge_type, weight, evidence_ref
                   FROM graph_edges
                   WHERE from_node_id IN (${nodeIds.map(() => "?").join(",")})
                      OR to_node_id IN (${nodeIds.map(() => "?").join(",")})
                   LIMIT 200`
                )
                .all(...nodeIds, ...nodeIds) as SqlRecord[]) ?? []);

        const hotspots = db
          .query(
            `SELECT n.ref, COUNT(*) AS count
             FROM graph_edges e
             JOIN graph_nodes n ON n.id = e.to_node_id
             GROUP BY n.ref
             ORDER BY count DESC
             LIMIT 20`
          )
          .all() as SqlRecord[];

        db.query(
          `INSERT INTO graph_queries (id, query_type, params_json, result_size, duration_ms, created_at)
           VALUES (?, 'impact', ?, ?, 0, ?)`
        ).run(crypto.randomUUID(), JSON.stringify({ query }), nodes.length, nowIso());

        return {
          query,
          touchedNodes: nodes.map((row) => ({
            id: String(row.id),
            nodeType: String(row.node_type),
            ref: String(row.ref),
            label: String(row.label),
          })),
          edges: edges.map((row) => ({
            id: String(row.id),
            fromNodeId: String(row.from_node_id),
            toNodeId: String(row.to_node_id),
            edgeType: String(row.edge_type),
            weight: Number(row.weight ?? 1),
            evidenceRef: row.evidence_ref ? String(row.evidence_ref) : undefined,
          })),
          hotspots: hotspots.map((row) => ({ ref: String(row.ref), count: Number(row.count ?? 0) })),
          generatedAt: nowIso(),
        };
      },
      async hotspots(): Promise<Array<{ ref: string; count: number }>> {
        const rows = db
          .query(
            `SELECT n.ref, COUNT(*) AS count
             FROM graph_edges e
             JOIN graph_nodes n ON n.id = e.to_node_id
             GROUP BY n.ref
             ORDER BY count DESC
             LIMIT 20`
          )
          .all() as SqlRecord[];
        return rows.map((row) => ({ ref: String(row.ref), count: Number(row.count ?? 0) }));
      },
      async explain(recommendationId: string): Promise<EvidencePath> {
        const recommendation = db
          .query(
            `SELECT id, title, rationale
             FROM memo_recommendations
             WHERE id = ?
             LIMIT 1`
          )
          .get(recommendationId) as SqlRecord | null;

        if (!recommendation) {
          return {
            recommendationId,
            path: [{ nodeRef: "missing", nodeType: "memo_recommendation", reason: "Recommendation not found" }],
          };
        }

        const candidate = db
          .query(
            `SELECT id, source_ref, title
             FROM portfolio_candidates
             WHERE title = ?
             ORDER BY updated_at DESC
             LIMIT 1`
          )
          .get(String(recommendation.title)) as SqlRecord | null;

        const path: EvidencePath["path"] = [
          { nodeRef: String(recommendation.id), nodeType: "memo_recommendation", reason: String(recommendation.rationale) },
        ];
        if (candidate) {
          path.push({
            nodeRef: String(candidate.id),
            nodeType: "portfolio_candidate",
            reason: `Matched recommendation title ${String(candidate.title)}`,
          });
          path.push({ nodeRef: String(candidate.source_ref), nodeType: "source_ref", reason: "Underlying source reference" });
        }

        return { recommendationId, path };
      },
    },

    perfScientist: {
      async getStatus(): Promise<PerfScientistStatus> {
        const lastBaseline = db
          .query(`SELECT created_at FROM perf_baselines ORDER BY created_at DESC LIMIT 1`)
          .get() as SqlRecord | null;
        const lastExperiment = db
          .query(`SELECT started_at FROM perf_experiments ORDER BY started_at DESC LIMIT 1`)
          .get() as SqlRecord | null;
        const queued = db
          .query(
            `SELECT COUNT(*) AS count
             FROM task_queue
             WHERE status='queued' AND task_type IN ('perf_baseline_nightly','perf_detect_change_smoke','perf_generate_candidates','perf_run_candidate','perf_score_decide','perf_open_draft_pr')`
          )
          .get() as SqlRecord;
        const running = db
          .query(`SELECT COUNT(*) AS count FROM perf_experiments WHERE status='running'`)
          .get() as SqlRecord;

        return {
          enabled: process.env.PERF_SCIENTIST_ENABLED === "1",
          repoPath:
            process.env.PERF_SCIENTIST_REPO_PATH ??
            process.env.PRIMARY_REPO_PATH ??
            resolve(process.env.HOME ?? process.cwd(), "projects/wrela"),
          lastBaselineAt: lastBaseline?.created_at ? String(lastBaseline.created_at) : undefined,
          lastExperimentAt: lastExperiment?.started_at ? String(lastExperiment.started_at) : undefined,
          queuedTasks: Number(queued.count ?? 0),
          runningExperiments: Number(running.count ?? 0),
          nextNightlyHour: Number(process.env.PERF_SCIENTIST_NIGHTLY_HOUR ?? 2),
        };
      },
      async listExperiments(params?: {
        status?: string;
        cursor?: string;
        limit?: number;
      }): Promise<{ items: PerfExperiment[]; nextCursor?: string }> {
        const limit = Math.max(1, Math.min(params?.limit ?? 20, 100));
        const parsedCursor = parseCursor(params?.cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (params?.status) {
          where += " AND e.status = ?";
          values.push(params.status);
        }
        if (parsedCursor) {
          where += " AND (e.started_at < ? OR (e.started_at = ? AND e.id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);

        const rows = db
          .query(
            `SELECT e.id, e.objective, e.status, e.trigger_source, e.base_commit_sha, e.branch_name, e.started_at, e.finished_at, e.error,
                    COUNT(c.id) AS candidate_count
             FROM perf_experiments e
             LEFT JOIN perf_candidates c ON c.experiment_id = e.id
             ${where}
             GROUP BY e.id
             ORDER BY e.started_at DESC, e.id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];

        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const items: PerfExperiment[] = selected.map((row) => ({
          id: String(row.id),
          objective: String(row.objective),
          status: String(row.status),
          triggerSource: String(row.trigger_source),
          baseCommitSha: String(row.base_commit_sha),
          branchName: row.branch_name ? String(row.branch_name) : undefined,
          startedAt: String(row.started_at),
          finishedAt: row.finished_at ? String(row.finished_at) : undefined,
          error: row.error ? String(row.error) : undefined,
          candidateCount: Number(row.candidate_count ?? 0),
        }));

        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].startedAt, items[items.length - 1].id) : undefined,
        };
      },
      async listCandidates(params?: {
        status?: string;
        cursor?: string;
        limit?: number;
      }): Promise<{ items: PerfCandidate[]; nextCursor?: string }> {
        const limit = Math.max(1, Math.min(params?.limit ?? 20, 100));
        const parsedCursor = parseCursor(params?.cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (params?.status) {
          where += " AND c.status = ?";
          values.push(params.status);
        }
        if (parsedCursor) {
          where += " AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);

        const rows = db
          .query(
            `SELECT c.id, c.experiment_id, c.title, c.hypothesis, c.change_class, c.target_paths_json, c.risk_class, c.status, c.created_at, c.updated_at
             FROM perf_candidates c
             ${where}
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];

        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;

        const items: PerfCandidate[] = selected.map((row) => {
          const latestDecision = db
            .query(
              `SELECT id, candidate_id, decision, score, reason, created_at
               FROM perf_decisions
               WHERE candidate_id=?
               ORDER BY created_at DESC
               LIMIT 1`
            )
            .get(String(row.id)) as SqlRecord | null;

          return {
            id: String(row.id),
            experimentId: String(row.experiment_id),
            title: String(row.title),
            hypothesis: String(row.hypothesis),
            changeClass: String(row.change_class),
            targetPaths: parseJsonObject<string[]>(row.target_paths_json, []),
            riskClass: String(row.risk_class),
            status: String(row.status),
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            latestDecision: latestDecision
              ? {
                  id: String(latestDecision.id),
                  candidateId: String(latestDecision.candidate_id),
                  decision: String(latestDecision.decision),
                  score: Number(latestDecision.score ?? 0),
                  reason: String(latestDecision.reason),
                  createdAt: String(latestDecision.created_at),
                }
              : undefined,
          };
        });

        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
      async listBaselines(limit = 10): Promise<PerfBaseline[]> {
        const rows = db
          .query(
            `SELECT id, repo_path, commit_sha, profile, manifest_path, baseline_json_path, summary_json, created_at
             FROM perf_baselines
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(Math.max(1, Math.min(limit, 100))) as SqlRecord[];
        return rows.map((row) => ({
          id: String(row.id),
          repoPath: String(row.repo_path),
          commitSha: String(row.commit_sha),
          profile: String(row.profile),
          manifestPath: String(row.manifest_path),
          baselineJsonPath: String(row.baseline_json_path),
          summary: parseJsonObject<Record<string, unknown>>(row.summary_json, {}),
          createdAt: String(row.created_at),
        }));
      },
      async leaderboard(window: "7d" | "30d" = "7d"): Promise<
        Array<{
          candidate: PerfCandidate;
          decision: PerfDecision;
        }>
      > {
        const since = window === "30d" ? "datetime('now', '-30 day')" : "datetime('now', '-7 day')";
        const rows = db
          .query(
            `SELECT d.id AS decision_id, d.candidate_id, d.decision, d.score, d.reason, d.created_at,
                    c.experiment_id, c.title, c.hypothesis, c.change_class, c.target_paths_json, c.risk_class, c.status, c.created_at AS candidate_created_at, c.updated_at
             FROM perf_decisions d
             JOIN perf_candidates c ON c.id = d.candidate_id
             WHERE d.created_at >= ${since}
               AND d.decision IN ('recommend','draft_pr_opened')
             ORDER BY d.score DESC, d.created_at DESC
             LIMIT 50`
          )
          .all() as SqlRecord[];

        return rows.map((row) => ({
          candidate: {
            id: String(row.candidate_id),
            experimentId: String(row.experiment_id),
            title: String(row.title),
            hypothesis: String(row.hypothesis),
            changeClass: String(row.change_class),
            targetPaths: parseJsonObject<string[]>(row.target_paths_json, []),
            riskClass: String(row.risk_class),
            status: String(row.status),
            createdAt: String(row.candidate_created_at),
            updatedAt: String(row.updated_at),
          },
          decision: {
            id: String(row.decision_id),
            candidateId: String(row.candidate_id),
            decision: String(row.decision),
            score: Number(row.score ?? 0),
            reason: String(row.reason),
            createdAt: String(row.created_at),
          },
        }));
      },
      async listArtifactsByRun(runId: string): Promise<{
        run?: PerfRun;
        metrics: PerfMetric[];
        artifacts: PerfArtifact[];
      }> {
        const run = db
          .query(
            `SELECT id, candidate_id, run_kind, profile, runs, command, cwd, artifact_path, exit_code, started_at, finished_at
             FROM perf_runs
             WHERE id=?
             LIMIT 1`
          )
          .get(runId) as SqlRecord | null;

        const metrics = (db
          .query(
            `SELECT id, run_id, scenario_id, runtime_p50_ns, runtime_p95_ns, runtime_p99_ns, compile_throughput_tps, allocs_per_request, dispatch_hit_ratio, cv_pct, confidence_pct, effect_pct, created_at
             FROM perf_metrics
             WHERE run_id=?
             ORDER BY created_at DESC`
          )
          .all(runId) as SqlRecord[]).map((row): PerfMetric => ({
          id: String(row.id),
          runId: String(row.run_id),
          scenarioId: String(row.scenario_id),
          runtimeP50Ns: row.runtime_p50_ns !== null ? Number(row.runtime_p50_ns) : undefined,
          runtimeP95Ns: row.runtime_p95_ns !== null ? Number(row.runtime_p95_ns) : undefined,
          runtimeP99Ns: row.runtime_p99_ns !== null ? Number(row.runtime_p99_ns) : undefined,
          compileThroughputTps: row.compile_throughput_tps !== null ? Number(row.compile_throughput_tps) : undefined,
          allocsPerRequest: row.allocs_per_request !== null ? Number(row.allocs_per_request) : undefined,
          dispatchHitRatio: row.dispatch_hit_ratio !== null ? Number(row.dispatch_hit_ratio) : undefined,
          cvPct: row.cv_pct !== null ? Number(row.cv_pct) : undefined,
          confidencePct: row.confidence_pct !== null ? Number(row.confidence_pct) : undefined,
          effectPct: row.effect_pct !== null ? Number(row.effect_pct) : undefined,
          createdAt: String(row.created_at),
        }));

        const artifacts = (db
          .query(
            `SELECT id, owner_type, owner_id, artifact_type, path, digest, created_at
             FROM perf_artifacts
             WHERE owner_type='candidate'
               AND owner_id IN (
                 SELECT candidate_id
                 FROM perf_runs
                 WHERE id=?
               )
             ORDER BY created_at DESC`
          )
          .all(runId) as SqlRecord[]).map((row): PerfArtifact => ({
          id: String(row.id),
          ownerType: String(row.owner_type),
          ownerId: String(row.owner_id),
          artifactType: String(row.artifact_type),
          path: String(row.path),
          digest: row.digest ? String(row.digest) : undefined,
          createdAt: String(row.created_at),
        }));

        return {
          run: run
            ? {
                id: String(run.id),
                candidateId: run.candidate_id ? String(run.candidate_id) : undefined,
                runKind: String(run.run_kind),
                profile: String(run.profile),
                runs: Number(run.runs ?? 0),
                command: String(run.command),
                cwd: String(run.cwd),
                artifactPath: run.artifact_path ? String(run.artifact_path) : undefined,
                exitCode: run.exit_code !== null ? Number(run.exit_code) : undefined,
                startedAt: String(run.started_at),
                finishedAt: run.finished_at ? String(run.finished_at) : undefined,
              }
            : undefined,
          metrics,
          artifacts,
        };
      },
      async action(
        candidateId: string,
        action: "rerun" | "open_draft_pr" | "reject" | "promote_priority"
      ): Promise<{ ok: boolean; message: string }> {
        const candidate = db
          .query(`SELECT id, status FROM perf_candidates WHERE id=? LIMIT 1`)
          .get(candidateId) as SqlRecord | null;
        if (!candidate) {
          return { ok: false, message: "candidate_not_found" };
        }

        if (action === "reject") {
          db.query(`UPDATE perf_candidates SET status='rejected', updated_at=? WHERE id=?`).run(nowIso(), candidateId);
          db.query(
            `INSERT INTO perf_decisions (id, candidate_id, decision, score, reason, created_at)
             VALUES (?, ?, 'reject_noise', 0, 'rejected_by_user', ?)`
          ).run(crypto.randomUUID(), candidateId, nowIso());
          return { ok: true, message: "candidate_rejected" };
        }

        if (action === "promote_priority") {
          const taskId = `task_perf_priority_${Date.now()}`;
          db.query(
            `INSERT INTO task_queue
             (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
             VALUES (?, ?, 'perf_score_decide', ?, 1, 'queued', ?, ?, ?)`
          ).run(
            taskId,
            candidateId,
            JSON.stringify({
              dedupeKey: `perf_score_decide:${candidateId}`,
              payload: {
                taskType: "perf_score_decide",
                candidateId,
                runId: `run_perf_priority_${Date.now()}`,
              },
              coalescedCount: 0,
              title: `Score APS candidate ${candidateId}`,
            }),
            nowIso(),
            nowIso(),
            nowIso()
          );
          return { ok: true, message: "candidate_priority_promoted" };
        }

        if (action === "rerun") {
          const taskId = `task_perf_rerun_${Date.now()}`;
          db.query(
            `INSERT INTO task_queue
             (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
             VALUES (?, ?, 'perf_run_candidate', ?, 2, 'queued', ?, ?, ?)`
          ).run(
            taskId,
            candidateId,
            JSON.stringify({
              dedupeKey: `perf_run_candidate:${candidateId}`,
              payload: {
                taskType: "perf_run_candidate",
                candidateId,
                profile: "standard",
                runId: `run_perf_rerun_${Date.now()}`,
              },
              coalescedCount: 0,
              title: `Re-run APS candidate ${candidateId}`,
            }),
            nowIso(),
            nowIso(),
            nowIso()
          );
          return { ok: true, message: "candidate_rerun_queued" };
        }

        const taskId = `task_perf_pr_${Date.now()}`;
        db.query(
          `INSERT INTO task_queue
           (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
           VALUES (?, ?, 'perf_open_draft_pr', ?, 2, 'queued', ?, ?, ?)`
        ).run(
          taskId,
          candidateId,
          JSON.stringify({
            dedupeKey: `perf_open_draft_pr:${candidateId}`,
            payload: {
              taskType: "perf_open_draft_pr",
              candidateId,
              runId: `run_perf_pr_action_${Date.now()}`,
            },
            coalescedCount: 0,
            title: `Open APS draft PR ${candidateId}`,
          }),
          nowIso(),
          nowIso(),
          nowIso()
        );
        return { ok: true, message: "candidate_pr_open_queued" };
      },
    },

    memory: {
      async listFacts(params?: { namespace?: string; state?: string; cursor?: string; limit?: number }): Promise<{
        items: MemoryFact[];
        nextCursor?: string;
      }> {
        const limit = Math.max(1, Math.min(params?.limit ?? 25, 100));
        const parsedCursor = parseCursor(params?.cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (params?.namespace) {
          where += " AND namespace = ?";
          values.push(params.namespace);
        }
        if (params?.state) {
          where += " AND state = ?";
          values.push(params.state);
        }
        if (parsedCursor) {
          where += " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);
        const rows = db
          .query(
            `SELECT id, namespace, fact_key, fact_value_json, state, confidence, source, updated_at
             FROM memory_facts
             ${where}
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const items = selected.map((row): MemoryFact => ({
          id: String(row.id),
          namespace: String(row.namespace),
          key: String(row.fact_key),
          value: parseJsonObject<Record<string, unknown>>(row.fact_value_json, {}),
          state: String(row.state),
          confidence: Number(row.confidence ?? 0),
          source: String(row.source),
          updatedAt: String(row.updated_at),
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].updatedAt, items[items.length - 1].id) : undefined,
        };
      },
      async listEpisodes(params?: { cursor?: string; limit?: number }): Promise<{
        items: MemoryEpisode[];
        nextCursor?: string;
      }> {
        const limit = Math.max(1, Math.min(params?.limit ?? 25, 100));
        const parsedCursor = parseCursor(params?.cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (parsedCursor) {
          where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);
        const rows = db
          .query(
            `SELECT id, run_id, trigger_type, context_json, actions_json, outcome_json, created_at
             FROM memory_episodes
             ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const items = selected.map((row): MemoryEpisode => ({
          id: String(row.id),
          runId: String(row.run_id),
          triggerType: String(row.trigger_type),
          context: parseJsonObject<Record<string, unknown>>(row.context_json, {}),
          actions: parseJsonObject<Array<Record<string, unknown>>>(row.actions_json, []),
          outcome: parseJsonObject<Record<string, unknown>>(row.outcome_json, {}),
          createdAt: String(row.created_at),
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
    },

    policy: {
      async getStatus(domain?: string): Promise<PolicyStatus[]> {
        const rows = db
          .query(
            `SELECT domain, MAX(version) AS latest_version, MAX(created_at) AS last_created, AVG(exploration_rate) AS exploration_rate
             FROM policy_bandit_state
             ${domain ? "WHERE domain=?" : ""}
             GROUP BY domain`
          )
          .all(...(domain ? [domain] : [])) as SqlRecord[];
        return rows.map((row) => {
          const rewardRow = db
            .query(
              `SELECT COALESCE(SUM(pr.reward_total), 0) AS total
               FROM policy_rewards pr
               JOIN policy_decisions pd ON pd.id = pr.policy_decision_id
               WHERE pd.domain = ? AND pr.created_at >= datetime('now', '-7 day')`
            )
            .get(String(row.domain)) as SqlRecord;
          return {
            domain: String(row.domain),
            explorationRate: Number(row.exploration_rate ?? 0.1),
            latestVersion: row.latest_version !== null ? Number(row.latest_version) : undefined,
            lastDecisionAt: row.last_created ? String(row.last_created) : undefined,
            totalRewards7d: Number(rewardRow.total ?? 0),
          };
        });
      },
      async listHistory(params?: { domain?: string; cursor?: string; limit?: number }): Promise<{
        items: PolicyHistoryItem[];
        nextCursor?: string;
      }> {
        const limit = Math.max(1, Math.min(params?.limit ?? 25, 100));
        const parsedCursor = parseCursor(params?.cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (params?.domain) {
          where += " AND pd.domain = ?";
          values.push(params.domain);
        }
        if (parsedCursor) {
          where += " AND (pd.created_at < ? OR (pd.created_at = ? AND pd.id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);
        const rows = db
          .query(
            `SELECT pd.id, pd.domain, pd.arm_id, pd.decision_reason, pd.explore_flag, pd.created_at,
                    pr.reward_total
             FROM policy_decisions pd
             LEFT JOIN policy_rewards pr ON pr.policy_decision_id = pd.id
             ${where}
             ORDER BY pd.created_at DESC, pd.id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const items = selected.map((row): PolicyHistoryItem => ({
          id: String(row.id),
          domain: String(row.domain),
          armId: String(row.arm_id),
          reason: String(row.decision_reason),
          exploreFlag: Number(row.explore_flag ?? 0) === 1,
          createdAt: String(row.created_at),
          reward: row.reward_total !== null ? Number(row.reward_total) : undefined,
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
      async action(
        domain: string,
        action: "retrain" | "rollback" | "set_exploration_rate",
        value?: number
      ): Promise<{ ok: boolean; message: string }> {
        if (action === "retrain") {
          const latest = db
            .query(`SELECT COALESCE(MAX(version), 0) AS version FROM policy_bandit_state WHERE domain=?`)
            .get(domain) as SqlRecord;
          const nextVersion = Number(latest.version ?? 0) + 1;
          const latestExploration = db
            .query(
              `SELECT exploration_rate
               FROM policy_bandit_state
               WHERE domain=?
               ORDER BY version DESC
               LIMIT 1`
            )
            .get(domain) as SqlRecord | null;
          db.query(
            `INSERT INTO policy_bandit_state
             (id, domain, model_json, exploration_rate, version, created_at, rollback_of)
             VALUES (?, ?, '{}', ?, ?, ?, NULL)`
          ).run(
            crypto.randomUUID(),
            domain,
            Number(latestExploration?.exploration_rate ?? 0.1),
            nextVersion,
            nowIso()
          );
          return { ok: true, message: "policy_retrained" };
        }
        if (action === "set_exploration_rate") {
          const rate = Math.max(0, Math.min(0.5, Number(value ?? 0.1)));
          const latest = db
            .query(`SELECT COALESCE(MAX(version), 0) AS version FROM policy_bandit_state WHERE domain=?`)
            .get(domain) as SqlRecord;
          const nextVersion = Number(latest.version ?? 0) + 1;
          db.query(
            `INSERT INTO policy_bandit_state
             (id, domain, model_json, exploration_rate, version, created_at, rollback_of)
             VALUES (?, ?, '{}', ?, ?, ?, NULL)`
          ).run(crypto.randomUUID(), domain, rate, nextVersion, nowIso());
          return { ok: true, message: "exploration_rate_updated" };
        }

        const latest = db
          .query(
            `SELECT version, rollback_of
             FROM policy_bandit_state
             WHERE domain=?
             ORDER BY version DESC
             LIMIT 1`
          )
          .get(domain) as SqlRecord | null;
        if (!latest || Number(latest.version ?? 0) <= 1) {
          return { ok: false, message: "rollback_unavailable" };
        }
        const fromVersion = Number(latest.version);
        const toVersion = fromVersion - 1;
        const target = db
          .query(
            `SELECT exploration_rate
             FROM policy_bandit_state
             WHERE domain=? AND version=? LIMIT 1`
          )
          .get(domain, toVersion) as SqlRecord | null;
        const nextVersion = fromVersion + 1;
        db.query(
          `INSERT INTO policy_bandit_state
           (id, domain, model_json, exploration_rate, version, created_at, rollback_of)
           VALUES (?, ?, '{}', ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), domain, Number(target?.exploration_rate ?? 0.1), nextVersion, nowIso(), fromVersion);
        db.query(
          `INSERT INTO policy_rollbacks
           (id, domain, from_version, to_version, reason, created_at)
           VALUES (?, ?, ?, ?, 'manual_rollback', ?)`
        ).run(crypto.randomUUID(), domain, fromVersion, toVersion, nowIso());
        return { ok: true, message: "policy_rolled_back" };
      },
    },

    repoLearning: {
      async getStatus(repoPath: string): Promise<RepoCompetenceSnapshot | null> {
        const row = db
          .query(
            `SELECT id, repo_path, score_total, subscores_json, top_risks_json, top_strengths_json, created_at
             FROM repo_competence_snapshots
             WHERE repo_path=?
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get(repoPath) as SqlRecord | null;
        if (!row) return null;
        return {
          id: String(row.id),
          repoPath: String(row.repo_path),
          scoreTotal: Number(row.score_total ?? 0),
          subscores: parseJsonObject<Record<string, unknown>>(row.subscores_json, {}),
          topRisks: parseJsonObject<string[]>(row.top_risks_json, []),
          topStrengths: parseJsonObject<string[]>(row.top_strengths_json, []),
          createdAt: String(row.created_at),
        };
      },
      async listFacts(params: { repoPath: string; factType?: string; cursor?: string; limit?: number }): Promise<{
        items: RepoLearningFact[];
        nextCursor?: string;
      }> {
        const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
        const parsedCursor = parseCursor(params.cursor);
        const values: Array<string | number> = [params.repoPath];
        let where = "WHERE repo_path = ?";
        if (params.factType) {
          where += " AND fact_type = ?";
          values.push(params.factType);
        }
        if (parsedCursor) {
          where += " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);
        const rows = db
          .query(
            `SELECT id, repo_path, fact_type, fact_key, fact_value_json, confidence, evidence_count, updated_at
             FROM repo_learning_facts
             ${where}
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const items = selected.map((row): RepoLearningFact => ({
          id: String(row.id),
          repoPath: String(row.repo_path),
          factType: String(row.fact_type),
          key: String(row.fact_key),
          value: parseJsonObject<Record<string, unknown>>(row.fact_value_json, {}),
          confidence: Number(row.confidence ?? 0),
          evidenceCount: Number(row.evidence_count ?? 0),
          updatedAt: String(row.updated_at),
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].updatedAt, items[items.length - 1].id) : undefined,
        };
      },
    },

    retrieval: {
      async getStatus(): Promise<RetrievalStatus> {
        const latest = db
          .query(
            `SELECT created_at
             FROM retrieval_queries
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get() as SqlRecord | null;
        const aggregate = db
          .query(
            `SELECT
               COALESCE(AVG(used_tokens), 0) AS avg_tokens,
               COALESCE(AVG(cache_hit), 0) AS cache_hit_rate
             FROM retrieval_queries
             WHERE created_at >= datetime('now', '-7 day')`
          )
          .get() as SqlRecord;
        const countRow = db
          .query(
            `SELECT COUNT(*) AS count
             FROM retrieval_queries
             WHERE created_at >= datetime('now', '-7 day')`
          )
          .get() as SqlRecord;
        const total = Number(countRow.count ?? 0);
        const p95Index = total > 0 ? Math.max(0, Math.ceil(total * 0.95) - 1) : 0;
        const p95Row = db
          .query(
            `SELECT latency_ms
             FROM retrieval_queries
             WHERE created_at >= datetime('now', '-7 day')
             ORDER BY latency_ms ASC
             LIMIT 1 OFFSET ?`
          )
          .get(p95Index) as SqlRecord | null;
        return {
          enabled: true,
          lastQueryAt: latest?.created_at ? String(latest.created_at) : undefined,
          p95LatencyMs: Number(p95Row?.latency_ms ?? 0),
          cacheHitRate: Number(aggregate.cache_hit_rate ?? 0),
          avgUsedTokens: Number(aggregate.avg_tokens ?? 0),
        };
      },
      async listQueries(cursor?: string, limit?: number): Promise<{ items: RetrievalQueryLog[]; nextCursor?: string }> {
        const bounded = clampLimit(limit, 25, 100);
        const parsedCursor = parseCursor(cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (parsedCursor) {
          where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(bounded + 1);
        const rows = db
          .query(
            `SELECT id, intent, repo_path, candidate_count, selected_count, budget_tokens, used_tokens, cache_hit, latency_ms, created_at
             FROM retrieval_queries
             ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > bounded;
        const selected = hasMore ? rows.slice(0, bounded) : rows;
        const items = selected.map((row): RetrievalQueryLog => ({
          id: String(row.id),
          intent: String(row.intent),
          repoPath: String(row.repo_path),
          candidateCount: Number(row.candidate_count ?? 0),
          selectedCount: Number(row.selected_count ?? 0),
          budgetTokens: Number(row.budget_tokens ?? 0),
          usedTokens: Number(row.used_tokens ?? 0),
          cacheHit: Number(row.cache_hit ?? 0) === 1,
          latencyMs: Number(row.latency_ms ?? 0),
          createdAt: String(row.created_at),
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
      async getResults(queryId: string): Promise<{ items: RetrievalResultItem[]; contextPack: RetrievalContextPack }> {
        const rows = db
          .query(
            `SELECT id, query_id, source_class, source_ref, score, included, token_estimate, excerpt, created_at
             FROM retrieval_results
             WHERE query_id=?
             ORDER BY score DESC, created_at DESC`
          )
          .all(queryId) as SqlRecord[];
        const items = rows.map((row): RetrievalResultItem => ({
          id: String(row.id),
          queryId: String(row.query_id),
          sourceClass: String(row.source_class),
          sourceRef: String(row.source_ref),
          score: Number(row.score ?? 0),
          included: Number(row.included ?? 0) === 1,
          tokenEstimate: Number(row.token_estimate ?? 0),
          excerpt: String(row.excerpt ?? ""),
          createdAt: String(row.created_at),
        }));
        const queryRow = db
          .query(
            `SELECT selected_count, budget_tokens, used_tokens
             FROM retrieval_queries
             WHERE id=?
             LIMIT 1`
          )
          .get(queryId) as SqlRecord | null;
        return {
          items,
          contextPack: {
            queryId,
            selectedCount: Number(queryRow?.selected_count ?? items.length),
            budgetTokens: Number(queryRow?.budget_tokens ?? 4000),
            usedTokens: Number(queryRow?.used_tokens ?? items.reduce((acc, item) => acc + item.tokenEstimate, 0)),
            evidenceRefs: [...new Set(items.filter((item) => item.included).map((item) => item.sourceRef))],
            snippets: items
              .filter((item) => item.included)
              .slice(0, 20)
              .map((item) => ({
                sourceClass: item.sourceClass,
                sourceRef: item.sourceRef,
                score: item.score,
                excerpt: item.excerpt,
              })),
          },
        };
      },
      async reindex(repoPath?: string): Promise<{ ok: boolean; indexedDocuments: number }> {
        const targetRepo = repoPath ?? process.env.PRIMARY_REPO_PATH ?? process.cwd();
        const now = nowIso();
        db.query(`DELETE FROM context_cache WHERE cache_key LIKE ?`).run(`retrieval:v3:${targetRepo}:%`);
        db.query(
          `DELETE FROM retrieval_embeddings
           WHERE document_id IN (SELECT id FROM retrieval_documents WHERE repo_path=?)`
        ).run(targetRepo);
        db.query(`DELETE FROM retrieval_documents WHERE repo_path=?`).run(targetRepo);
        db.query(
          `INSERT INTO retrieval_documents
           (id, doc_type, source_ref, repo_path, title, content, metadata_json, updated_at, created_at)
           SELECT
             'mf:' || id,
             'canonical',
             'memory_facts:' || id,
             ?,
             'fact:' || fact_key,
             fact_value_json,
             json_object('namespace', namespace, 'source', source),
             updated_at,
             created_at
           FROM memory_facts
           WHERE state='active'`
        ).run(targetRepo);
        db.query(
          `INSERT INTO retrieval_documents
           (id, doc_type, source_ref, repo_path, title, content, metadata_json, updated_at, created_at)
           SELECT
             'rl:' || id,
             'repo_learning',
             'repo_learning_facts:' || id,
             repo_path,
             'repo:' || fact_type || ':' || fact_key,
             fact_value_json,
             json_object('confidence', confidence, 'evidenceCount', evidence_count),
             updated_at,
             created_at
           FROM repo_learning_facts
           WHERE repo_path=?`
        ).run(targetRepo);
        db.query(
          `INSERT INTO retrieval_documents
           (id, doc_type, source_ref, repo_path, title, content, metadata_json, updated_at, created_at)
           SELECT
             'ep:' || me.id,
             'episodic',
             'memory_episodes:' || me.id,
             ?,
             'episode:' || me.run_id,
             COALESCE(mes.summary_md, me.outcome_json),
             json_object('triggerType', me.trigger_type),
             me.created_at,
             me.created_at
           FROM memory_episodes me
           LEFT JOIN memory_episode_summaries mes ON mes.episode_id=me.id`
        ).run(targetRepo);
        db.query(
          `INSERT INTO retrieval_documents
           (id, doc_type, source_ref, repo_path, title, content, metadata_json, updated_at, created_at)
           SELECT
             'ca:' || id,
             'evidence',
             'command_audit:' || id,
             ?,
             'audit:' || COALESCE(run_id, ''),
             command || ' cwd=' || cwd,
             json_object('exitCode', exit_code),
             started_at,
             started_at
           FROM command_audit`
        ).run(targetRepo);
        const docs = db
          .query(
            `SELECT id, title, content, updated_at
             FROM retrieval_documents
             WHERE repo_path=?`
          )
          .all(targetRepo) as SqlRecord[];
        for (const doc of docs) {
          const text = `${String(doc.title)}\n${String(doc.content)}`;
          db.query(
            `INSERT INTO retrieval_embeddings
             (id, document_id, embedding, model, created_at)
             VALUES (?, ?, ?, 'hash64', ?)
             ON CONFLICT(document_id) DO UPDATE SET
               embedding=excluded.embedding,
               model=excluded.model,
               created_at=excluded.created_at`
          ).run(
            crypto.randomUUID(),
            String(doc.id),
            JSON.stringify(buildHash64Embedding(text)),
            String(doc.updated_at ?? now)
          );
        }
        db.query(
          `INSERT INTO retrieval_queries
           (id, query_text, intent, repo_path, candidate_count, selected_count, budget_tokens, used_tokens, cache_hit, latency_ms, created_at)
           VALUES (?, 'manual_reindex', 'meta', ?, 0, 0, 0, 0, 0, 0, ?)`
        ).run(crypto.randomUUID(), targetRepo, now);
        const row = db
          .query(`SELECT COUNT(*) AS count FROM retrieval_documents WHERE repo_path=?`)
          .get(targetRepo) as SqlRecord;
        return { ok: true, indexedDocuments: Number(row.count ?? 0) };
      },
      async feedback(event: RetrievalFeedbackEvent): Promise<{ ok: boolean }> {
        const queryExists = db
          .query(`SELECT id FROM retrieval_queries WHERE id=? LIMIT 1`)
          .get(event.queryId) as SqlRecord | null;
        if (!queryExists) {
          return { ok: false };
        }
        db.query(
          `INSERT INTO retrieval_feedback
           (id, query_id, run_id, feedback_type, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          event.queryId,
          event.runId ?? null,
          event.feedbackType,
          event.notes ?? null,
          nowIso()
        );
        return { ok: true };
      },
    },

    chat: {
      async listConversations(cursor?: string, limit?: number): Promise<{ items: Conversation[]; nextCursor?: string }> {
        const boundedLimit = clampLimit(limit, 30, 100);
        const parsedCursor = parseCursor(cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (parsedCursor) {
          where += " AND (updated_at < ? OR (updated_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(boundedLimit + 1);
        const rows = db
          .query(
            `SELECT id, title, status, last_message_at, created_at, updated_at
             FROM conversations
             ${where}
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > boundedLimit;
        const selected = hasMore ? rows.slice(0, boundedLimit) : rows;
        const items = selected.map(mapConversation);
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].updatedAt, items[items.length - 1].id) : undefined,
        };
      },
      async createConversation(title?: string): Promise<Conversation> {
        const now = nowIso();
        const id = crypto.randomUUID();
        const normalizedTitle = (title ?? "").trim() || "New conversation";
        await withDbWriteRetry(() =>
          db.query(
            `INSERT INTO conversations
             (id, title, status, pinned_facts_json, created_at, updated_at)
             VALUES (?, ?, 'active', '[]', ?, ?)`
          ).run(id, normalizedTitle.slice(0, 120), now, now)
        );
        await withDbWriteRetry(() =>
          db.query(
            `INSERT OR REPLACE INTO conversation_state
             (conversation_id, summary_text, summary_turn_count, compacted_at, last_intent, token_budget, updated_at)
             VALUES (?, '', 0, NULL, NULL, 4000, ?)`
          ).run(id, now)
        );
        const row = db
          .query(
            `SELECT id, title, status, last_message_at, created_at, updated_at
             FROM conversations
             WHERE id=?`
          )
          .get(id) as SqlRecord;
        return mapConversation(row);
      },
      async getConversation(conversationId: string): Promise<{
        conversation: Conversation;
        state: ConversationState | null;
        messages: ConversationMessage[];
      } | null> {
        const row = db
          .query(
            `SELECT id, title, status, last_message_at, created_at, updated_at
             FROM conversations
             WHERE id=?
             LIMIT 1`
          )
          .get(conversationId) as SqlRecord | null;
        if (!row) {
          return null;
        }
        const stateRow = db
          .query(
            `SELECT conversation_id, summary_text, summary_turn_count, compacted_at, last_intent, token_budget, updated_at
             FROM conversation_state
             WHERE conversation_id=?`
          )
          .get(conversationId) as SqlRecord | null;
        const messageRows = db
          .query(
            `SELECT id, conversation_id, role, mode, status, content, run_id, retrieval_query_id, evidence_refs_json, token_input, token_output, latency_ms, created_at, updated_at
             FROM conversation_messages
             WHERE conversation_id=?
             ORDER BY created_at ASC, id ASC
             LIMIT 1000`
          )
          .all(conversationId) as SqlRecord[];
        return {
          conversation: mapConversation(row),
          state: stateRow
            ? {
                conversationId: String(stateRow.conversation_id),
                summaryText: String(stateRow.summary_text ?? ""),
                summaryTurnCount: Number(stateRow.summary_turn_count ?? 0),
                compactedAt: stateRow.compacted_at ? String(stateRow.compacted_at) : undefined,
                lastIntent: stateRow.last_intent ? String(stateRow.last_intent) : undefined,
                tokenBudget: Number(stateRow.token_budget ?? 4000),
                updatedAt: String(stateRow.updated_at),
              }
            : null,
          messages: messageRows.map(mapConversationMessage),
        };
      },
      async sendMessage(input: {
        conversationId: string;
        content: string;
        mode?: "chat" | "mission";
        repoPath?: string;
      }): Promise<{
        conversation: Conversation;
        userMessage: ConversationMessage;
        assistantMessage: ConversationMessage;
        run: ConversationRun;
      }> {
        const conversationRow = db
          .query(`SELECT id, title, status, created_at, updated_at, last_message_at FROM conversations WHERE id=? LIMIT 1`)
          .get(input.conversationId) as SqlRecord | null;
        if (!conversationRow) {
          throw new Error("conversation_not_found");
        }
        const now = nowIso();
        const lane = input.mode === "mission" ? "mission" : "chat";
        const normalized = input.content.trim();
        if (!normalized) {
          throw new Error("empty_message");
        }
        const runId = `run_web_${Date.now()}`;
        const userMessageId = crypto.randomUUID();
        const assistantMessageId = crypto.randomUUID();
        const runRowId = crypto.randomUUID();
        const existingTitle = String(conversationRow.title ?? "");
        const inferredTitle = autoTitleFromMessage(normalized);
        const shouldRetitle = inferredTitle.length > 0 && shouldAutoRetitleConversation(existingTitle);
        await withDbWriteRetry(() => {
          db.exec("BEGIN IMMEDIATE TRANSACTION");
          try {
            db.query(
              `INSERT INTO conversation_messages
               (id, conversation_id, role, mode, status, content, run_id, evidence_refs_json, created_at, updated_at)
               VALUES (?, ?, 'user', ?, 'done', ?, ?, '[]', ?, ?)`
            ).run(userMessageId, input.conversationId, lane, normalized, runId, now, now);
            db.query(
              `INSERT INTO conversation_messages
               (id, conversation_id, role, mode, status, content, run_id, evidence_refs_json, created_at, updated_at)
               VALUES (?, ?, 'assistant', ?, 'queued', '', ?, '[]', ?, ?)`
            ).run(assistantMessageId, input.conversationId, lane, runId, now, now);
            db.query(
              `INSERT INTO conversation_runs
               (id, conversation_id, user_message_id, assistant_message_id, run_id, lane, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
            ).run(runRowId, input.conversationId, userMessageId, assistantMessageId, runId, lane, now, now);
            if (shouldRetitle) {
              db.query(
                `UPDATE conversations
                 SET title=?, last_message_at=?, updated_at=?
                 WHERE id=?`
              ).run(inferredTitle, now, now, input.conversationId);
            } else {
              db.query(
                `UPDATE conversations
                 SET last_message_at=?, updated_at=?
                 WHERE id=?`
              ).run(now, now, input.conversationId);
            }
            db.query(
              `INSERT INTO task_queue
               (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
               VALUES (?, ?, ?, ?, 0, 'queued', ?, ?, ?)`
            ).run(
              crypto.randomUUID(),
              runId,
              lane === "chat" ? "chat_reply" : "codex_mission",
              JSON.stringify({
                dedupeKey: `web:${input.conversationId}:${userMessageId}`,
                payload: {
                  taskType: lane === "chat" ? "chat_reply" : "codex_mission",
                  runId,
                  domain: lane === "chat" ? "chat" : "general",
                  objective: lane === "chat" ? "Respond to web chat message" : "Execute heavy mission requested via web chat",
                  title: lane === "chat" ? "Web chat reply" : "Web heavy mission",
                  requestText: normalized,
                  repoPath: input.repoPath ?? process.env.PRIMARY_REPO_PATH ?? "",
                  cwd: input.repoPath ?? process.env.PRIMARY_REPO_PATH ?? process.cwd(),
                  conversationId: input.conversationId,
                  userMessageId,
                  assistantMessageId,
                  responseMode: lane,
                },
                coalescedCount: 0,
                title: lane === "chat" ? "Web chat reply" : "Web heavy mission",
              }),
              now,
              now,
              now
            );
            db.exec("COMMIT");
          } catch (error) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // no-op
            }
            throw error;
          }
        });
        const conversation = mapConversation(
          db
            .query(`SELECT id, title, status, last_message_at, created_at, updated_at FROM conversations WHERE id=?`)
            .get(input.conversationId) as SqlRecord
        );
        const userMessage = mapConversationMessage(
          db
            .query(
              `SELECT id, conversation_id, role, mode, status, content, run_id, retrieval_query_id, evidence_refs_json, token_input, token_output, latency_ms, created_at, updated_at
               FROM conversation_messages WHERE id=?`
            )
            .get(userMessageId) as SqlRecord
        );
        const assistantMessage = mapConversationMessage(
          db
            .query(
              `SELECT id, conversation_id, role, mode, status, content, run_id, retrieval_query_id, evidence_refs_json, token_input, token_output, latency_ms, created_at, updated_at
               FROM conversation_messages WHERE id=?`
            )
            .get(assistantMessageId) as SqlRecord
        );
        const run = mapConversationRun(
          db
            .query(
              `SELECT id, conversation_id, user_message_id, assistant_message_id, run_id, lane, status, error_text, created_at, updated_at
               FROM conversation_runs
               WHERE id=?`
            )
            .get(runRowId) as SqlRecord
        );
        return { conversation, userMessage, assistantMessage, run };
      },
      async listRuns(conversationId: string): Promise<{ items: ConversationRun[] }> {
        const rows = db
          .query(
            `SELECT id, conversation_id, user_message_id, assistant_message_id, run_id, lane, status, error_text, created_at, updated_at
             FROM conversation_runs
             WHERE conversation_id=?
             ORDER BY created_at DESC
             LIMIT 200`
          )
          .all(conversationId) as SqlRecord[];
        return { items: rows.map(mapConversationRun) };
      },
      async compactConversation(conversationId: string): Promise<{ ok: boolean; summaryText: string }> {
        const rows = db
          .query(
            `SELECT id, conversation_id, role, mode, status, content, run_id, retrieval_query_id, evidence_refs_json, token_input, token_output, latency_ms, created_at, updated_at
             FROM conversation_messages
             WHERE conversation_id=?
             ORDER BY created_at ASC, id ASC
             LIMIT 1000`
          )
          .all(conversationId) as SqlRecord[];
        const messages = rows.map(mapConversationMessage);
        const compacted = compactConversationMessages(messages, 8);
        const now = nowIso();
        await withDbWriteRetry(() =>
          db.query(
            `INSERT INTO conversation_state
             (conversation_id, summary_text, summary_turn_count, compacted_at, last_intent, token_budget, updated_at)
             VALUES (?, ?, ?, ?, NULL, 4000, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
               summary_text=excluded.summary_text,
               summary_turn_count=excluded.summary_turn_count,
               compacted_at=excluded.compacted_at,
               token_budget=excluded.token_budget,
               updated_at=excluded.updated_at`
          ).run(conversationId, compacted.summary, compacted.turns, now, now)
        );
        return { ok: true, summaryText: compacted.summary };
      },
    },

    autonomy: {
      async getFunnel(window: "24h" | "7d"): Promise<AutonomyFunnel> {
        const sinceExpr = window === "7d" ? "datetime('now', '-7 day')" : "datetime('now', '-24 hour')";
        const createdRow = db
          .query(
            `SELECT
               (SELECT COUNT(*) FROM portfolio_candidates WHERE created_at >= ${sinceExpr}) +
               (SELECT COUNT(*) FROM perf_candidates WHERE created_at >= ${sinceExpr}) AS count`
          )
          .get() as SqlRecord;
        const scoredRow = db
          .query(
            `SELECT
               (SELECT COUNT(DISTINCT candidate_id) FROM portfolio_scores WHERE scored_at >= ${sinceExpr}) +
               (SELECT COUNT(DISTINCT candidate_id) FROM perf_decisions WHERE created_at >= ${sinceExpr}) AS count`
          )
          .get() as SqlRecord;
        const eligibleRow = db
          .query(
            `SELECT COUNT(*) AS count
             FROM autonomy_decisions
             WHERE created_at >= ${sinceExpr}
               AND reason IN ('queued_for_execution', 'budget_exhausted')`
          )
          .get() as SqlRecord;
        const queuedRow = db
          .query(
            `SELECT COUNT(*) AS count
             FROM autonomy_decisions
             WHERE created_at >= ${sinceExpr}
               AND decision='queued_for_execution'`
          )
          .get() as SqlRecord;
        const startedRow = db
          .query(
            `SELECT COUNT(*) AS count
             FROM task_queue
             WHERE task_type='codex_mission'
               AND status IN ('running','completed')
               AND created_at >= ${sinceExpr}
               AND json_extract(payload_json, '$.payload.autonomous') = 1`
          )
          .get() as SqlRecord;
        const completedRow = db
          .query(
            `SELECT COUNT(*) AS count
             FROM task_queue
             WHERE task_type='codex_mission'
               AND status='completed'
               AND created_at >= ${sinceExpr}
               AND json_extract(payload_json, '$.payload.autonomous') = 1`
          )
          .get() as SqlRecord;
        const prOpenedRow = db
          .query(
            `SELECT COUNT(*) AS count
             FROM perf_decisions
             WHERE decision='draft_pr_opened'
               AND created_at >= ${sinceExpr}`
          )
          .get() as SqlRecord;
        const dropoffsRows = db
          .query(
            `SELECT reason, COUNT(*) AS count, MAX(created_at) AS last_seen
             FROM autonomy_decisions
             WHERE created_at >= ${sinceExpr}
               AND reason <> 'queued_for_execution'
             GROUP BY reason
             ORDER BY count DESC, last_seen DESC
             LIMIT 10`
          )
          .all() as SqlRecord[];

        return {
          window,
          generatedAt: nowIso(),
          candidatesCreated: asNumber(createdRow.count, 0),
          candidatesScored: asNumber(scoredRow.count, 0),
          candidatesEligible: asNumber(eligibleRow.count, 0),
          missionsQueued: asNumber(queuedRow.count, 0),
          missionsStarted: asNumber(startedRow.count, 0),
          missionsCompleted: asNumber(completedRow.count, 0),
          draftPrOpened: asNumber(prOpenedRow.count, 0),
          dropoffs: dropoffsRows.map((row) => ({
            reason: String(row.reason),
            count: asNumber(row.count, 0),
            lastSeenAt: row.last_seen ? String(row.last_seen) : undefined,
          })),
        };
      },
      async listDecisions(cursor?: string, limit = 25): Promise<{ items: AutonomyDecision[]; nextCursor?: string }> {
        const bounded = Math.max(1, Math.min(limit, 200));
        const parsedCursor = parseCursor(cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (parsedCursor) {
          where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(bounded + 1);
        const rows = db
          .query(
            `SELECT id, candidate_ref, source, decision, reason, ev, risk_class, budget_window, queued_task_id, created_at
             FROM autonomy_decisions
             ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > bounded;
        const selected = hasMore ? rows.slice(0, bounded) : rows;
        const items = selected.map((row): AutonomyDecision => ({
          id: String(row.id),
          candidateRef: String(row.candidate_ref),
          source: String(row.source),
          decision: String(row.decision),
          reason: String(row.reason),
          ev: asNumber(row.ev, 0),
          riskClass: String(row.risk_class ?? "medium"),
          budgetWindow: String(row.budget_window),
          queuedTaskId: row.queued_task_id ? String(row.queued_task_id) : undefined,
          createdAt: String(row.created_at),
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
      async getStatus(): Promise<AutonomyStatus> {
        const settings = db
          .query(`SELECT enabled, hourly_budget FROM autonomy_settings WHERE id='global' LIMIT 1`)
          .get() as SqlRecord | null;
        const queued = db
          .query(
            `SELECT COUNT(*) AS count
             FROM task_queue
             WHERE task_type='codex_mission'
               AND status='queued'
               AND json_extract(payload_json, '$.payload.autonomous') = 1`
          )
          .get() as SqlRecord;
        const running = db
          .query(
            `SELECT COUNT(*) AS count
             FROM task_queue
             WHERE task_type='codex_mission'
               AND status='running'
               AND json_extract(payload_json, '$.payload.autonomous') = 1`
          )
          .get() as SqlRecord;
        const lastPlanner = db
          .query(`SELECT MAX(created_at) AS ts FROM autonomy_decisions`)
          .get() as SqlRecord;
        const lastReadiness = db
          .query(
            `SELECT reason, created_at
             FROM autonomy_failures
             WHERE stage='aps_readiness'
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get() as SqlRecord | null;

        return {
          enabled: asNumber(settings?.enabled, 1) === 1,
          hourlyBudget: asNumber(settings?.hourly_budget, 2),
          queuedMissions: asNumber(queued.count, 0),
          runningMissions: asNumber(running.count, 0),
          lastPlannerRunAt: lastPlanner.ts ? String(lastPlanner.ts) : undefined,
          lastApsReadinessAt: lastReadiness?.created_at ? String(lastReadiness.created_at) : undefined,
          lastApsReadinessReason: lastReadiness?.reason ? String(lastReadiness.reason) : undefined,
        };
      },
      async action(
        action: "run_planner_now" | "pause_autonomy" | "resume_autonomy" | "set_hourly_budget",
        payload?: { hourlyBudget: number }
      ): Promise<{ ok: boolean; message: string }> {
        const now = nowIso();
        db.query(
          `INSERT OR IGNORE INTO autonomy_settings (id, enabled, hourly_budget, updated_at)
           VALUES ('global', 1, 2, ?)`
        ).run(now);

        if (action === "pause_autonomy") {
          db.query(`UPDATE autonomy_settings SET enabled=0, updated_at=? WHERE id='global'`).run(now);
          return { ok: true, message: "autonomy_paused" };
        }
        if (action === "resume_autonomy") {
          db.query(`UPDATE autonomy_settings SET enabled=1, updated_at=? WHERE id='global'`).run(now);
          return { ok: true, message: "autonomy_resumed" };
        }
        if (action === "set_hourly_budget") {
          const budget = Math.max(0, Math.min(20, asNumber(payload?.hourlyBudget, 2)));
          db.query(`UPDATE autonomy_settings SET hourly_budget=?, updated_at=? WHERE id='global'`).run(budget, now);
          return { ok: true, message: "autonomy_budget_updated" };
        }

        db.query(
          `INSERT INTO task_queue
           (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
           VALUES (?, ?, 'autonomy_mission_planner', ?, 1, 'queued', ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          `api_autonomy_${Date.now()}`,
          JSON.stringify({
            dedupeKey: `autonomy_mission_planner:manual:${Date.now()}`,
            payload: {
              taskType: "autonomy_mission_planner",
              runId: `run_autonomy_manual_${Date.now()}`,
              title: "Manual autonomy planner run",
            },
            coalescedCount: 0,
            title: "Manual autonomy planner run",
          }),
          now,
          now,
          now
        );
        return { ok: true, message: "autonomy_planner_queued" };
      },
    },

    tokenEconomy: {
      async getStatus(domain?: string): Promise<TokenEconomyStatus[]> {
        const budgetRows = db
          .query(
            `SELECT domain, soft_cap, hard_cap
             FROM token_budgets
             WHERE window='monthly' ${domain ? "AND domain=?" : ""}
             ORDER BY domain ASC`
          )
          .all(...(domain ? [domain] : [])) as SqlRecord[];
        const since = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
        return budgetRows.map((row) => {
          const used = db
            .query(
              `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
               FROM token_usage_events
               WHERE domain=? AND created_at >= ?`
            )
            .get(String(row.domain), since) as SqlRecord;
          const monthlyUsedTokens = Number(used.used ?? 0);
          const softCap = Number(row.soft_cap ?? 0);
          const hardCap = Number(row.hard_cap ?? 0);
          return {
            domain: String(row.domain),
            monthlyUsedTokens,
            softCap,
            hardCap,
            economyMode: monthlyUsedTokens >= Math.round(softCap * 0.9) || monthlyUsedTokens >= hardCap,
          };
        });
      },
      async listUsage(params?: { domain?: string; cursor?: string; limit?: number }): Promise<{
        items: TokenUsageItem[];
        nextCursor?: string;
      }> {
        const limit = Math.max(1, Math.min(params?.limit ?? 50, 200));
        const parsedCursor = parseCursor(params?.cursor);
        const values: Array<string | number> = [];
        let where = "WHERE 1=1";
        if (params?.domain) {
          where += " AND domain = ?";
          values.push(params.domain);
        }
        if (parsedCursor) {
          where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          values.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
        }
        values.push(limit + 1);
        const rows = db
          .query(
            `SELECT id, run_id, domain, model, input_tokens, output_tokens, cache_hit, created_at
             FROM token_usage_events
             ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          )
          .all(...values) as SqlRecord[];
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const items = selected.map((row): TokenUsageItem => ({
          id: String(row.id),
          runId: String(row.run_id),
          domain: String(row.domain),
          model: String(row.model),
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          cacheHit: Number(row.cache_hit ?? 0) === 1,
          createdAt: String(row.created_at),
        }));
        return {
          items,
          nextCursor:
            hasMore && items.length > 0 ? toCursor(items[items.length - 1].createdAt, items[items.length - 1].id) : undefined,
        };
      },
      async action(
        action: "set_budget" | "enter_economy_mode" | "exit_economy_mode",
        payload?: { domain?: string; softCap?: number; hardCap?: number }
      ): Promise<{ ok: boolean; message: string }> {
        const domain = payload?.domain ?? "general";
        if (action === "set_budget") {
          const softCap = Math.max(1000, Number(payload?.softCap ?? 50000));
          const hardCap = Math.max(softCap, Number(payload?.hardCap ?? 100000));
          db.query(
            `INSERT INTO token_budgets (id, window, domain, soft_cap, hard_cap, updated_at)
             VALUES (?, 'monthly', ?, ?, ?, ?)
             ON CONFLICT(window, domain) DO UPDATE SET
               soft_cap=excluded.soft_cap,
               hard_cap=excluded.hard_cap,
               updated_at=excluded.updated_at`
          ).run(`tok_monthly_${domain}`, domain, softCap, hardCap, nowIso());
          return { ok: true, message: "token_budget_updated" };
        }
        if (action === "enter_economy_mode") {
          const row = db
            .query(`SELECT soft_cap, hard_cap FROM token_budgets WHERE window='monthly' AND domain=? LIMIT 1`)
            .get(domain) as SqlRecord | null;
          const hardCap = Number(row?.hard_cap ?? 100000);
          const forcedSoft = Math.max(1000, Math.floor(hardCap * 0.5));
          db.query(
            `INSERT INTO token_budgets (id, window, domain, soft_cap, hard_cap, updated_at)
             VALUES (?, 'monthly', ?, ?, ?, ?)
             ON CONFLICT(window, domain) DO UPDATE SET
               soft_cap=excluded.soft_cap,
               updated_at=excluded.updated_at`
          ).run(`tok_monthly_${domain}`, domain, forcedSoft, hardCap, nowIso());
          return { ok: true, message: "economy_mode_enabled" };
        }
        const row = db
          .query(`SELECT hard_cap FROM token_budgets WHERE window='monthly' AND domain=? LIMIT 1`)
          .get(domain) as SqlRecord | null;
        const hardCap = Number(row?.hard_cap ?? 100000);
        const normalSoft = Math.max(1000, Math.floor(hardCap * 0.7));
        db.query(
          `INSERT INTO token_budgets (id, window, domain, soft_cap, hard_cap, updated_at)
           VALUES (?, 'monthly', ?, ?, ?, ?)
           ON CONFLICT(window, domain) DO UPDATE SET
             soft_cap=excluded.soft_cap,
             updated_at=excluded.updated_at`
        ).run(`tok_monthly_${domain}`, domain, normalSoft, hardCap, nowIso());
        return { ok: true, message: "economy_mode_disabled" };
      },
    },
  };
};
