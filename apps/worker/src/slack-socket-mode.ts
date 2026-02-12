import type { Database } from "@squidward/db";

import type { SerializedTaskProcessor } from "./queue";
import type { WorkerTaskPayload } from "./runtime";

interface SlackSocketModeListenerDeps {
  appToken: string;
  primaryRepoPath: string;
  queue: SerializedTaskProcessor<WorkerTaskPayload>;
  db: Database;
  onTaskQueued?: () => void | Promise<void>;
  now?: () => Date;
}

interface SlackEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: {
    event?: {
      type?: string;
      subtype?: string;
      app_id?: string;
      bot_id?: string;
      user?: string;
      client_msg_id?: string;
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
    };
  };
}

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

const normalizeSlackText = (text: string): string => text.replace(/<@[A-Z0-9]+>/g, "").trim();
const parseAllowedUsers = (): string[] =>
  (process.env.SLACK_TRIGGER_USER_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const shouldIgnoreSelfOrBotEvent = (event: {
  subtype?: string;
  app_id?: string;
  bot_id?: string;
  user?: string;
}): boolean => {
  if (event.subtype) return true;
  if (event.app_id) return true;
  if (event.bot_id) return true;
  const selfUserId = (process.env.SLACK_BOT_USER_ID ?? "").trim();
  if (selfUserId && event.user === selfUserId) return true;
  return false;
};

export class SlackSocketModeListener {
  private readonly deps: SlackSocketModeListenerDeps;
  private running = false;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;

  constructor(deps: SlackSocketModeListenerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.open();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async open(): Promise<void> {
    if (!this.running) return;

    try {
      const response = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const payload = (await response.json()) as { ok?: boolean; url?: string; error?: string };
      if (!response.ok || payload.ok !== true || !payload.url) {
        throw new Error(`apps.connections.open failed: ${payload.error ?? response.statusText}`);
      }
      console.log("[slack-socket] connected");
      this.connectSocket(payload.url);
    } catch (error) {
      console.error("[slack-socket] open failed:", error);
      this.scheduleReconnect();
    }
  }

  private connectSocket(url: string): void {
    if (!this.running) return;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("message", (event) => {
      void this.handleEnvelope(String(event.data ?? ""));
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, 2000);
  }

  private async handleEnvelope(raw: string): Promise<void> {
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(raw) as SlackEnvelope;
    } catch {
      return;
    }

    if (envelope.envelope_id && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    if (envelope.type !== "events_api") return;
    const event = envelope.payload?.event;
    if (!event) return;

    const eventType = event.type ?? "";
    const subtype = event.subtype ?? "";
    const user = event.user;
    const clientMsgId = event.client_msg_id;
    const channel = event.channel ?? "";
    const text = event.text ?? "";
    if (!channel || !text.trim()) return;
    if (shouldIgnoreSelfOrBotEvent(event)) return;
    if (eventType === "message" && !clientMsgId) return;
    if (eventType === "message" && subtype === "bot_message") return;
    if (eventType !== "message" && eventType !== "app_mention") return;
    const threadTs = event.thread_ts;
    const eventTs = event.ts;
    if (threadTs && eventTs && threadTs !== eventTs) return;

    const allowedUsers = parseAllowedUsers();
    if (allowedUsers.length > 0 && (!user || !allowedUsers.includes(user))) {
      return;
    }

    const normalizedText = normalizeSlackText(text) || text.trim();
    const feedback = parseRetrievalFeedbackCommand(normalizedText);
    if (feedback) {
      const now = this.now().toISOString();
      const queryExists = this.deps.db
        .query(`SELECT id FROM retrieval_queries WHERE id=? LIMIT 1`)
        .get(feedback.queryId) as Record<string, unknown> | null;
      if (queryExists) {
        this.deps.db
          .query(
            `INSERT INTO retrieval_feedback
             (id, query_id, run_id, feedback_type, notes, created_at)
             VALUES (?, ?, NULL, ?, ?, ?)`
          )
          .run(crypto.randomUUID(), feedback.queryId, feedback.feedbackType, feedback.notes ?? null, now);
      }
      return;
    }

    const runId = `run_slack_${Date.now()}`;
    const enqueueResult = await this.deps.queue.enqueue({
      dedupeKey: `slack:${channel}:${event.ts ?? Date.now()}`,
      priority: "P0",
      payload: {
        taskType: "codex_mission",
        runId,
        domain: "slack",
        objective: "Respond to Slack user request with memory-grounded answer and actions",
        title: "Slack codex mission",
        requestText: normalizedText,
        responseChannel: channel,
        repoPath: this.deps.primaryRepoPath,
        cwd: this.deps.primaryRepoPath,
      },
    });
    console.log(
      `[slack-socket] queued mission for channel=${channel} ts=${event.ts ?? "n/a"} coalesced=${enqueueResult.coalesced}`
    );

    if (this.deps.onTaskQueued) {
      await this.deps.onTaskQueued();
    }
  }
}
