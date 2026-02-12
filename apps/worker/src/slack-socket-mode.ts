import type { Database } from "@squidward/db";

import type { SerializedTaskProcessor } from "./queue";
import type { WorkerTaskPayload } from "./runtime";

interface SlackSocketModeListenerDeps {
  appToken: string;
  primaryRepoPath: string;
  queue: SerializedTaskProcessor<WorkerTaskPayload>;
  db: Database;
  selfUserId?: string;
  allowAllChannelMessages?: boolean;
  allowedUserIds?: string[];
  onTaskQueued?: () => void | Promise<void>;
  now?: () => Date;
}

interface SlackEnvelope {
  type?: string;
  envelope_id?: string;
  authorizations?: Array<{
    user_id?: string;
    is_bot?: boolean;
  }>;
  payload?: {
      event?: {
        type?: string;
        subtype?: string;
        bot_id?: string;
        user?: string;
        username?: string;
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

const normalizeSlackText = (text: string): string =>
  text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
const isSlackSelfEvent = (event: {
  bot_id?: string;
  user?: string;
  username?: string;
  subtype?: string;
  type?: string;
  selfUserId?: string;
  authorizedBotUsers?: string[];
}): boolean => {
  if (event.bot_id) {
    return true;
  }

  if (event.subtype) {
    return true;
  }

  const botUserId = event.selfUserId?.trim() ?? process.env.SLACK_BOT_USER_ID?.trim();
  if (botUserId && (event.user === botUserId || event.username === botUserId)) {
    return true;
  }
  if (event.authorizedBotUsers) {
    const hasAuthorizedBot = event.authorizedBotUsers.some((candidate) => candidate && candidate === event.user);
    if (hasAuthorizedBot) {
      return true;
    }
  }
  return false;
};

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

  const shouldHandleSlackMessage = (
  eventType: string,
  channel: string,
  normalizedText: string,
  userId: string | undefined,
  allowedUserIds: string[],
  allowAllChannelMessages: boolean,
  selfUserId?: string
): boolean => {
  if (!isAllowedSlackUser(userId, allowedUserIds)) {
    return false;
  }

  if (eventType === "app_mention") {
    return true;
  }

  if (eventType !== "message") return false;
  if (isDirectMessageChannel(channel)) return true;
  if (allowAllChannelMessages) return true;
  return isSelfMention(normalizedText, selfUserId);
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
    const channel = event.channel ?? "";
    const text = event.text ?? "";
    const user = event.user;
    const clientMsgId = event.client_msg_id;
    const ts = event.ts;
    const threadTs = event.thread_ts;
    const normalizedText = normalizeSlackText(text) || text.trim();
    if (!channel || !text.trim()) return;
    const allowedUserIds = this.deps.allowedUserIds ?? [];
    const allowAllChannelMessages = this.deps.allowAllChannelMessages ?? false;

    if (allowAllChannelMessages && allowedUserIds.length === 0) {
      return;
    }

    if (isThreadReplyEvent(threadTs, ts)) {
      return;
    }

    if (eventType === "message" && !clientMsgId) {
      return;
    }
    const authorizedBotUsers =
      envelope.authorizations
        ?.filter((authorization) => authorization?.is_bot === true)
        .map((authorization) => authorization.user_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [];
    if (
      isSlackSelfEvent({
        ...event,
        selfUserId: this.deps.selfUserId,
        authorizedBotUsers,
      })
    ) {
      return;
    }
    if (eventType === "message" && subtype === "bot_message") return;

    if (!isAllowedSlackUser(user, allowedUserIds)) {
      return;
    }

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

    if (
      !shouldHandleSlackMessage(
        eventType,
        channel,
        normalizedText,
        user,
        allowedUserIds,
        allowAllChannelMessages,
        this.deps.selfUserId
      )
    ) {
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

export const __testOnly = {
  isSlackSelfEvent,
  shouldHandleSlackMessage,
  isDirectMessageChannel,
  isThreadReplyEvent,
  isSelfMention,
  parseSlackAllowedUsers,
  isAllowedSlackUser,
  normalizeSlackText,
};
