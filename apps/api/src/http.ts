import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { Database } from "@squidward/db";
import { file } from "bun";

import { createIntegrationsService, type CommandRunner, type FetchLike } from "./integrations";
import { createInMemoryServices } from "./services/inMemoryServices";
import type { Services } from "./services/interfaces";
import type { ActionRequest, HealthResponse, TaskAction } from "./types/contracts";

interface HandlerOptions {
  dbPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  runCommand?: CommandRunner;
}

const workspaceRoot = resolve(import.meta.dir, "../../..");
const resolveDbPath = (rawPath?: string): string => {
  if (!rawPath) {
    return normalize(resolve(workspaceRoot, ".data/agent.db"));
  }
  return normalize(isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath));
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });

const extractActionRequest = async (req: Request): Promise<ActionRequest> => {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return {};
  }

  const data = (await req.json()) as ActionRequest;
  return {
    taskId: data.taskId,
    action: data.action,
    reason: data.reason,
  };
};

const timingSafeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

const verifySlackSignature = (body: string, ts: string, signature: string, secret?: string): boolean => {
  if (!secret) {
    return false;
  }
  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds)) {
    return false;
  }
  const driftSeconds = Math.abs(Math.floor(Date.now() / 1000) - Math.floor(tsSeconds));
  if (driftSeconds > 300) {
    return false;
  }

  const raw = `v0:${ts}:${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return timingSafeEquals(expected, signature);
};

const dashboardDistDir = process.env.DASHBOARD_DIST_DIR
  ? normalize(process.env.DASHBOARD_DIST_DIR)
  : normalize(join(import.meta.dir, "../../dashboard/dist"));

const dashboardIndexPath = join(dashboardDistDir, "index.html");

const resolveStaticPath = (pathname: string): string => {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  return join(dashboardDistDir, normalized);
};

const serveDashboardAsset = (pathname: string): Response | null => {
  if (!existsSync(dashboardDistDir) || !existsSync(dashboardIndexPath)) {
    return null;
  }

  const candidatePath = resolveStaticPath(pathname);
  const requested = basename(candidatePath);
  const servesAsset = requested.includes(".");

  if (servesAsset && existsSync(candidatePath)) {
    return new Response(file(candidatePath));
  }

  return new Response(file(dashboardIndexPath));
};

const healthResponse = (): HealthResponse => ({
  ok: true,
  now: new Date().toISOString(),
});

const parseRetrievalFeedbackCommand = (
  text: string
): { queryId: string; feedbackType: "helpful" | "missed-context" | "wrong-priority"; notes?: string } | null => {
  const match = text
    .trim()
    .match(/^\/?(?:retrieval\s+)?(?:feedback|fb)\s+([a-zA-Z0-9_-]{8,})\s+(helpful|missed-context|wrong-priority)(?:\s+(.+))?$/i);
  if (!match) return null;
  return {
    queryId: match[1],
    feedbackType: match[2].toLowerCase() as "helpful" | "missed-context" | "wrong-priority",
    notes: match[3]?.trim(),
  };
};

const normalizeSlackText = (text: string): string =>
  text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isDirectMessageChannel = (channel: string): boolean => channel.startsWith("D") || channel.startsWith("G");
const isThreadReplyEvent = (threadTs?: string, ts?: string): boolean =>
  typeof threadTs === "string" && typeof ts === "string" && threadTs.length > 0 && ts.length > 0 && threadTs !== ts;

const parseSlackAllowedUsers = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const isAllowedSlackUser = (userId: string | undefined, allowedUserIds: string[]): boolean => {
  if (allowedUserIds.length === 0) return true;
  return typeof userId === "string" && allowedUserIds.includes(userId);
};

const isSelfMention = (text: string, selfUserId?: string): boolean => {
  if (!selfUserId) return false;
  return text.includes(`<@${selfUserId}>`);
};

const isLikelyHeavySlackRequest = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
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

const isSelfSlackEvent = (
  event: Record<string, unknown>,
  authorizedBotUsers: string[],
  selfUserId?: string
): boolean => {
  const botId = typeof event.bot_id === "string" ? event.bot_id : undefined;
  if (botId) return true;

  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  if (subtype) return true;

  const user = typeof event.user === "string" ? event.user : undefined;
  if (selfUserId && user === selfUserId) return true;
  if (user && authorizedBotUsers.includes(user)) return true;
  const username = typeof event.username === "string" ? event.username : undefined;
  if (selfUserId && username === selfUserId) return true;

  return false;
};

const shouldHandleSlackEvent = (event: {
  type: string;
  channel: string;
  text: string;
  user?: string;
  allowedUserIds: string[];
  allowAllChannelMessages: boolean;
  selfUserId?: string;
}): boolean => {
  if (!isAllowedSlackUser(event.user, event.allowedUserIds)) {
    return false;
  }

  if (event.type === "app_mention") return true;
  if (event.type !== "message") return false;
  if (isDirectMessageChannel(event.channel)) return true;
  if (event.allowAllChannelMessages) return true;
  return isSelfMention(event.text, event.selfUserId);
};

const parseLimitParam = (
  url: URL,
  key: string,
  fallback: number,
  min = 1,
  max = 100
): number => {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.trunc(parsed);
  return Math.max(min, Math.min(asInt, max));
};

const handleUnifiedAction = async (
  services: Services,
  action: TaskAction,
  input: ActionRequest
): Promise<Response> => {
  if (action === "pause") {
    return json(await services.actions.pause(input));
  }
  if (action === "resume") {
    return json(await services.actions.resume(input));
  }
  if (action === "retry") {
    return json(await services.actions.retryTask(input));
  }
  return json(await services.actions.stopTask(input));
};

export const createHandler = (options?: HandlerOptions) => {
  const env = options?.env ?? process.env;
  const dbPath = resolveDbPath(options?.dbPath ?? env.AGENT_DB_PATH);

  const services = createInMemoryServices({ dbPath });
  const integrations = createIntegrationsService({
    dbPath,
    env,
    fetchImpl: options?.fetchImpl,
    runCommand: options?.runCommand,
  });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

  if (req.method === "GET" && pathname === "/healthz") {
    return json(healthResponse());
  }

  if (req.method === "GET" && pathname === "/readyz") {
    return json(healthResponse());
  }

  if (req.method === "POST" && pathname === "/slack/events") {
    const body = await req.text();
    const ts = req.headers.get("x-slack-request-timestamp") ?? "";
    const signature = req.headers.get("x-slack-signature") ?? "";

    const verified = verifySlackSignature(body, ts, signature, env.SLACK_SIGNING_SECRET);
    if (!verified) {
      return json({ ok: false, error: "invalid_signature" }, 401);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return json({ challenge: payload.challenge });
    }

    const event = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : null;
    const eventType = event?.type ? String(event.type) : "";
    const subtype = event?.subtype ? String(event.subtype) : "";
    const channel = event?.channel ? String(event.channel) : "";
    const text = event?.text ? String(event.text) : "";
    const user = event?.user ? String(event.user) : undefined;
    const clientMsgId = event?.client_msg_id ? String(event.client_msg_id) : undefined;
    const eventTs = event?.ts ? String(event.ts) : undefined;
    const threadTs = event?.thread_ts ? String(event.thread_ts) : undefined;
    const normalizedText = normalizeSlackText(text) || text.trim();
    const selfUserId = env.SLACK_BOT_USER_ID?.trim();
    const allowAllChannelMessages = env.SLACK_ALLOW_ALL_CHANNEL_MESSAGES === "1";
    const allowedUserIds = parseSlackAllowedUsers(env.SLACK_TRIGGER_USER_IDS);
    const authorizedBotUsers = Array.isArray((payload as { authorizations?: unknown }).authorizations)
      ? ((payload as { authorizations?: Array<{ user_id?: unknown; is_bot?: unknown }> }).authorizations
          ?.map((authorization) =>
            authorization?.is_bot === true && typeof authorization.user_id === "string" ? authorization.user_id : undefined
          )
          .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [])
      : [];

    if (event && channel && text.trim().length > 0) {
      const db = new Database(dbPath, { create: true, strict: false });
      const now = new Date().toISOString();
      if (allowAllChannelMessages && allowedUserIds.length === 0) {
        db.close();
        return json({ ok: true, accepted: true }, 202);
      }
      if (isThreadReplyEvent(threadTs, eventTs)) {
        db.close();
        return json({ ok: true, accepted: true }, 202);
      }
      if (eventType === "message" && !clientMsgId) {
        db.close();
        return json({ ok: true, accepted: true }, 202);
      }
      if (!isAllowedSlackUser(user, allowedUserIds)) {
        db.close();
        return json({ ok: true, accepted: true }, 202);
      }
      const retrievalFeedback = parseRetrievalFeedbackCommand(normalizedText);
      if (retrievalFeedback) {
        const queryExists = db
          .query(`SELECT id FROM retrieval_queries WHERE id=? LIMIT 1`)
          .get(retrievalFeedback.queryId) as Record<string, unknown> | null;
        if (!queryExists) {
          db.close();
          return json(
            {
              ok: true,
              accepted: true,
              feedbackRecorded: false,
              reason: "unknown_query_id",
              receivedAt: new Date().toISOString(),
            },
            202
          );
        }
        db.query(
          `INSERT INTO retrieval_feedback
           (id, query_id, run_id, feedback_type, notes, created_at)
           VALUES (?, ?, NULL, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          retrievalFeedback.queryId,
          retrievalFeedback.feedbackType,
          retrievalFeedback.notes ?? null,
          now
        );
        db.close();
        return json(
          {
            ok: true,
            accepted: true,
            feedbackRecorded: true,
            receivedAt: new Date().toISOString(),
          },
          202
        );
      }
      if (
        isSelfSlackEvent(event, authorizedBotUsers, selfUserId) ||
        !shouldHandleSlackEvent({
          type: eventType,
          channel,
          text: normalizedText,
          user,
          allowedUserIds,
          allowAllChannelMessages,
          selfUserId,
        })
      ) {
        db.close();
        return json({ ok: true, accepted: true }, 202);
      }

      const heavy = eventType === "app_mention" || isLikelyHeavySlackRequest(normalizedText);
      const runId = `run_slack_${Date.now()}`;
      const dedupeKey = `slack:${heavy ? "heavy" : "chat"}:${channel}:${eventTs ?? Date.now()}`;
      db.query(
        `INSERT INTO task_queue
         (id, source_id, task_type, payload_json, priority, status, scheduled_for, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        runId,
        heavy ? "codex_mission" : "slack_chat_reply",
        JSON.stringify({
          dedupeKey,
          payload: {
            taskType: heavy ? "codex_mission" : "slack_chat_reply",
            runId,
            domain: heavy ? "slack" : "slack_chat",
            objective: heavy
              ? "Respond to Slack user request with memory-grounded answer and actions"
              : "Respond to Slack user message quickly and clearly",
            title: heavy ? "Slack codex mission" : "Slack chat reply",
            requestText: normalizedText,
            responseChannel: channel,
            repoPath: env.PRIMARY_REPO_PATH ?? "",
            cwd: env.PRIMARY_REPO_PATH ?? process.cwd(),
          },
          coalescedCount: 0,
          title: heavy ? "Slack codex mission" : "Slack chat reply",
        }),
        heavy ? 2 : 1,
        now,
        now,
        now
      );
      db.close();
    }

    return json({ ok: true, accepted: true, receivedAt: new Date().toISOString() }, 202);
  }

  // Native API endpoints.
  if (req.method === "GET" && pathname === "/api/dashboard/snapshot") {
    return json(await services.dashboard.getCockpit());
  }
  if (req.method === "GET" && pathname === "/api/runs") {
    return json(await services.runs.listRuns());
  }
  if (req.method === "GET" && pathname === "/api/queue") {
    return json(await services.queue.listQueue());
  }
  if (req.method === "GET" && pathname === "/api/audit") {
    return json(await services.audit.listAudit());
  }
  if (req.method === "GET" && pathname === "/api/persona/snapshot") {
    return json(await services.persona.listTraits());
  }
  if (req.method === "GET" && pathname === "/api/system/health") {
    return json(await services.system.getOverview());
  }
  if (req.method === "GET" && pathname === "/api/budget/brave") {
    return json(await services.budget.getBraveBudget());
  }
  if (req.method === "GET" && pathname === "/api/portfolio/top") {
    const limit = parseLimitParam(url, "limit", 5, 1, 100);
    return json(await services.portfolio.listTop(limit));
  }
  if (req.method === "GET" && pathname === "/api/portfolio/history") {
    return json(
      await services.portfolio.listHistory(
        url.searchParams.get("from") ?? undefined,
        url.searchParams.get("to") ?? undefined,
        url.searchParams.get("cursor") ?? undefined,
        parseLimitParam(url, "limit", 25, 1, 200)
      )
    );
  }
  if (req.method === "GET" && pathname === "/api/tests/evolution/stats") {
    return json(await services.testEvolution.getStats());
  }
  if (req.method === "GET" && pathname === "/api/tests/evolution/candidates") {
    return json(
      await services.testEvolution.listCandidates(
        url.searchParams.get("status") ?? undefined,
        url.searchParams.get("cursor") ?? undefined,
        parseLimitParam(url, "limit", 25, 1, 200)
      )
    );
  }
  if (req.method === "GET" && pathname === "/api/memos/latest") {
    return json(await services.memos.getLatest());
  }
  if (req.method === "GET" && pathname === "/api/memos/history") {
    return json(
      await services.memos.listHistory(
        url.searchParams.get("cursor") ?? undefined,
        parseLimitParam(url, "limit", 10, 1, 100)
      )
    );
  }
  if (req.method === "POST" && pathname === "/api/graph/impact") {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { query?: string })
      : {};
    return json(await services.graph.impact(body.query ?? ""));
  }
  if (req.method === "GET" && pathname === "/api/graph/hotspots") {
    return json(await services.graph.hotspots());
  }
  const graphExplainMatch = pathname.match(/^\/api\/graph\/explain\/([^/]+)$/);
  if (req.method === "GET" && graphExplainMatch) {
    return json(await services.graph.explain(graphExplainMatch[1]));
  }
  if (req.method === "GET" && pathname === "/api/perf-scientist/status") {
    return json(await services.perfScientist.getStatus());
  }
  if (req.method === "GET" && pathname === "/api/perf-scientist/experiments") {
    return json(
      await services.perfScientist.listExperiments({
        status: url.searchParams.get("status") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 20, 1, 100),
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/perf-scientist/candidates") {
    return json(
      await services.perfScientist.listCandidates({
        status: url.searchParams.get("status") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 20, 1, 100),
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/perf-scientist/baselines") {
    return json(await services.perfScientist.listBaselines(parseLimitParam(url, "limit", 10, 1, 100)));
  }
  if (req.method === "GET" && pathname === "/api/perf-scientist/leaderboard") {
    const windowParam = (url.searchParams.get("window") ?? "7d") as "7d" | "30d";
    return json(await services.perfScientist.leaderboard(windowParam));
  }
  const perfArtifactsMatch = pathname.match(/^\/api\/perf-scientist\/artifacts\/([^/]+)$/);
  if (req.method === "GET" && perfArtifactsMatch) {
    return json(await services.perfScientist.listArtifactsByRun(perfArtifactsMatch[1]));
  }
  const perfActionMatch = pathname.match(/^\/api\/perf-scientist\/actions\/([^/]+)$/);
  if (req.method === "POST" && perfActionMatch) {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { action?: "rerun" | "open_draft_pr" | "reject" | "promote_priority" })
      : {};
    const action = body.action ?? "rerun";
    return json(await services.perfScientist.action(perfActionMatch[1], action));
  }
  const policyActionMatch = pathname.match(/^\/api\/policy\/actions\/([^/]+)$/);
  if (req.method === "POST" && policyActionMatch) {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { action?: "retrain" | "rollback" | "set_exploration_rate"; value?: number })
      : {};
    return json(await services.policy.action(policyActionMatch[1], body.action ?? "retrain", body.value));
  }
  if (req.method === "GET" && pathname === "/api/memory/facts") {
    return json(
      await services.memory.listFacts({
        namespace: url.searchParams.get("namespace") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 25, 1, 100),
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/memory/episodes") {
    return json(
      await services.memory.listEpisodes({
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 25, 1, 100),
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/policy/status") {
    return json(await services.policy.getStatus(url.searchParams.get("domain") ?? undefined));
  }
  if (req.method === "GET" && pathname === "/api/policy/history") {
    return json(
      await services.policy.listHistory({
        domain: url.searchParams.get("domain") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 25, 1, 100),
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/repo-learning/status") {
    const repoPath = url.searchParams.get("repoPath") ?? process.env.PRIMARY_REPO_PATH ?? "";
    return json(await services.repoLearning.getStatus(repoPath));
  }
  if (req.method === "GET" && pathname === "/api/repo-learning/facts") {
    const repoPath = url.searchParams.get("repoPath") ?? process.env.PRIMARY_REPO_PATH ?? "";
    return json(
      await services.repoLearning.listFacts({
        repoPath,
        factType: url.searchParams.get("factType") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 25, 1, 100),
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/token-economy/status") {
    return json(await services.tokenEconomy.getStatus(url.searchParams.get("domain") ?? undefined));
  }
  if (req.method === "GET" && pathname === "/api/token-economy/usage") {
    return json(
      await services.tokenEconomy.listUsage({
        domain: url.searchParams.get("domain") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimitParam(url, "limit", 50, 1, 200),
      })
    );
  }
  if (req.method === "POST" && pathname === "/api/token-economy/actions") {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as {
          action?: "set_budget" | "enter_economy_mode" | "exit_economy_mode";
          domain?: string;
          softCap?: number;
          hardCap?: number;
        })
      : {};
    return json(
      await services.tokenEconomy.action(body.action ?? "set_budget", {
        domain: body.domain,
        softCap: body.softCap,
        hardCap: body.hardCap,
      })
    );
  }
  if (req.method === "GET" && pathname === "/api/retrieval/status") {
    return json(await services.retrieval.getStatus());
  }
  if (req.method === "GET" && pathname === "/api/retrieval/queries") {
    return json(
      await services.retrieval.listQueries(
        url.searchParams.get("cursor") ?? undefined,
        parseLimitParam(url, "limit", 25, 1, 100)
      )
    );
  }
  const retrievalResultsMatch = pathname.match(/^\/api\/retrieval\/results\/([^/]+)$/);
  if (req.method === "GET" && retrievalResultsMatch) {
    return json(await services.retrieval.getResults(retrievalResultsMatch[1]));
  }
  if (req.method === "POST" && pathname === "/api/retrieval/reindex") {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { repoPath?: string })
      : {};
    return json(await services.retrieval.reindex(body.repoPath));
  }
  if (req.method === "POST" && pathname === "/api/retrieval/feedback") {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { queryId?: string; runId?: string; feedbackType?: string; notes?: string })
      : {};
    if (!body.queryId || !body.feedbackType) {
      return json({ ok: false, error: "invalid_feedback_payload" }, 400);
    }
    return json(
      await services.retrieval.feedback({
        queryId: body.queryId,
        runId: body.runId,
        feedbackType: body.feedbackType as "helpful" | "missed-context" | "wrong-priority",
        notes: body.notes,
      })
    );
  }

  // Dashboard compatibility endpoints.
  if (req.method === "GET" && pathname === "/api/dashboard/cockpit") {
    return json(await services.dashboard.getCockpit());
  }
  if (req.method === "GET" && pathname === "/api/dashboard/runs") {
    return json(await services.runs.listRuns());
  }
  if (req.method === "GET" && pathname === "/api/dashboard/queue") {
    return json(await services.queue.listQueue());
  }
  if (req.method === "GET" && pathname === "/api/dashboard/audit") {
    return json(await services.audit.listAudit());
  }
  if (req.method === "GET" && pathname === "/api/dashboard/persona") {
    return json(await services.persona.listTraits());
  }
  if (req.method === "GET" && pathname === "/api/dashboard/system") {
    return json(await services.system.getOverview());
  }

  if (req.method === "POST" && pathname === "/api/actions/pause") {
    return json(await services.actions.pause(await extractActionRequest(req)));
  }
  if (req.method === "POST" && pathname === "/api/actions/resume") {
    return json(await services.actions.resume(await extractActionRequest(req)));
  }
  if (req.method === "POST" && pathname === "/api/actions/retry-task") {
    return json(await services.actions.retryTask(await extractActionRequest(req)));
  }
  if (req.method === "POST" && pathname === "/api/actions/stop-task") {
    return json(await services.actions.stopTask(await extractActionRequest(req)));
  }

  const runActionMatch = pathname.match(/^\/api\/dashboard\/runs\/([^/]+)\/actions$/);
  if (req.method === "POST" && runActionMatch) {
    const input = await extractActionRequest(req);
    const action = input.action ?? "pause";
    return handleUnifiedAction(services, action, { ...input, taskId: runActionMatch[1] });
  }

  const taskActionMatch = pathname.match(/^\/api\/dashboard\/tasks\/([^/]+)\/actions$/);
  if (req.method === "POST" && taskActionMatch) {
    const input = await extractActionRequest(req);
    const action = input.action ?? "retry";
    return handleUnifiedAction(services, action, { ...input, taskId: taskActionMatch[1] });
  }

    if (req.method === "GET" && pathname === "/api/integrations/status") {
      return integrations.getStatus();
    }

    if (pathname.startsWith("/oauth/")) {
      return json({ ok: false, error: "oauth_removed" }, 404);
    }

    if (req.method === "GET") {
      const staticResponse = serveDashboardAsset(pathname);
      if (staticResponse) {
        return staticResponse;
      }
    }

    return json({ ok: false, error: "not_found" }, 404);
  };
};

export const handler = createHandler();
