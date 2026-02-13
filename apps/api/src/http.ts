import { existsSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
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

const unauthorized = (): Response =>
  new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="squidward", charset="UTF-8"',
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

const decodeBasicAuth = (headerValue: string): { username: string; password: string } | null => {
  if (!headerValue.toLowerCase().startsWith("basic ")) return null;
  const encoded = headerValue.slice(6).trim();
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return {
      username: decoded.slice(0, sep),
      password: decoded.slice(sep + 1),
    };
  } catch {
    return null;
  }
};

const shouldBypassWebAuth = (pathname: string): boolean =>
  pathname === "/healthz" || pathname === "/readyz";

const isAuthorizedWebRequest = (
  req: Request,
  env: Record<string, string | undefined>,
  pathname: string
): boolean => {
  const requiredPassword = env.WEB_PASSWORD?.trim();
  if (!requiredPassword) return true;
  if (shouldBypassWebAuth(pathname)) return true;
  const expectedUser = (env.WEB_USERNAME?.trim() || "admin").trim();
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const parsed = decodeBasicAuth(auth);
  if (!parsed) return false;
  return timingSafeEquals(parsed.username, expectedUser) && timingSafeEquals(parsed.password, requiredPassword);
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

    if (!isAuthorizedWebRequest(req, env, pathname)) {
      return unauthorized();
    }

  if (req.method === "GET" && pathname === "/healthz") {
    return json(healthResponse());
  }

  if (req.method === "GET" && pathname === "/readyz") {
    return json(healthResponse());
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
  if (req.method === "GET" && pathname === "/api/chat/conversations") {
    return json(
      await services.chat.listConversations(
        url.searchParams.get("cursor") ?? undefined,
        parseLimitParam(url, "limit", 30, 1, 100)
      )
    );
  }
  if (req.method === "POST" && pathname === "/api/chat/conversations") {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { title?: string })
      : {};
    return json(await services.chat.createConversation(body.title));
  }
  const chatConversationMatch = pathname.match(/^\/api\/chat\/conversations\/([^/]+)$/);
  if (req.method === "GET" && chatConversationMatch) {
    const result = await services.chat.getConversation(chatConversationMatch[1]);
    if (!result) return json({ ok: false, error: "not_found" }, 404);
    return json(result);
  }
  const chatMessageMatch = pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/messages$/);
  if (req.method === "POST" && chatMessageMatch) {
    const body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { content?: string; mode?: "chat" | "mission"; repoPath?: string })
      : {};
    if (!body.content || !body.content.trim()) {
      return json({ ok: false, error: "empty_message" }, 400);
    }
    return json(
      await services.chat.sendMessage({
        conversationId: chatMessageMatch[1],
        content: body.content,
        mode: body.mode,
        repoPath: body.repoPath,
      })
    );
  }
  const chatCompactMatch = pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/compact$/);
  if (req.method === "POST" && chatCompactMatch) {
    return json(await services.chat.compactConversation(chatCompactMatch[1]));
  }
  const chatRunsMatch = pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/runs$/);
  if (req.method === "GET" && chatRunsMatch) {
    return json(await services.chat.listRuns(chatRunsMatch[1]));
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
