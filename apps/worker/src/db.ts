import { Database } from "@squidward/db";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CommandAuditRecord, QueueItem, QueueItemStatus, WorkerState } from "./types";

export interface WorkerDb {
  getWorkerMode(): Promise<"active" | "paused">;
  saveWorkerState(state: WorkerState): Promise<void>;
  saveQueueItem(item: QueueItem): Promise<void>;
  findCoalescibleQueueItem(dedupeKey: string, threshold: Date): Promise<QueueItem | null>;
  listReadyQueueItems(limit: number, now: Date): Promise<QueueItem[]>;
  countReadyQueueItems(now: Date): Promise<number>;
  updateQueueItemStatus(id: string, status: QueueItemStatus, updatedAt: Date): Promise<void>;
  appendCommandAudit(record: CommandAuditRecord): Promise<void>;
}

interface SqliteWorkerDbOptions {
  dbPath: string;
}

type SqlRecord = Record<string, unknown>;

const toPriorityInt = (priority: QueueItem["priority"]): number => {
  if (priority === "P0") return 1;
  if (priority === "P1") return 2;
  return 3;
};

const toPriority = (value: number): QueueItem["priority"] => {
  if (value <= 1) return "P0";
  if (value === 2) return "P1";
  return "P2";
};

const normalizeStatus = (status: string): QueueItemStatus => {
  if (status === "running") return "running";
  if (status === "done" || status === "completed") return "done";
  if (status === "failed") return "failed";
  return "queued";
};

const migrate = (db: Database): void => {
  const migrationPath = resolve(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
};

export class SqliteWorkerDb implements WorkerDb {
  readonly db: Database;

  constructor(options: SqliteWorkerDbOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { create: true, strict: false });
    migrate(this.db);
  }

  async getWorkerMode(): Promise<"active" | "paused"> {
    const row = this.db
      .query(`SELECT state FROM worker_state WHERE worker_id='global'`)
      .get() as SqlRecord | null;
    return row?.state === "paused" ? "paused" : "active";
  }

  async saveWorkerState(state: WorkerState): Promise<void> {
    this.db
      .query(
        `INSERT INTO worker_state (worker_id, state, heartbeat_at, metadata_json, updated_at)
         VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           state=excluded.state,
           heartbeat_at=excluded.heartbeat_at,
           metadata_json=excluded.metadata_json,
           updated_at=excluded.updated_at`
      )
      .run(
        state.mode,
        state.heartbeatAt.toISOString(),
        JSON.stringify({ queueDepth: state.queueDepth, activeSessionId: state.activeSessionId }),
        state.heartbeatAt.toISOString()
      );
  }

  async saveQueueItem(item: QueueItem): Promise<void> {
    this.db
      .query(
        `INSERT INTO task_queue
         (id, source_id, task_type, payload_json, priority, status, scheduled_for, attempts, created_at, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json=excluded.payload_json,
           priority=excluded.priority,
           status=excluded.status,
           scheduled_for=excluded.scheduled_for,
           attempts=excluded.attempts,
           updated_at=excluded.updated_at,
           last_error=excluded.last_error`
      )
      .run(
        item.id,
        (item.payload as { runId?: string }).runId ?? item.id,
        (item.payload as { taskType?: string }).taskType ?? "maintenance",
        JSON.stringify({
          dedupeKey: item.dedupeKey,
          payload: item.payload,
          coalescedCount: item.coalescedCount,
          title: (item.payload as { title?: string }).title,
        }),
        toPriorityInt(item.priority),
        item.status === "done" ? "completed" : item.status,
        item.availableAt.toISOString(),
        item.attempts,
        item.createdAt.toISOString(),
        item.updatedAt.toISOString(),
        item.status === "failed" ? "worker_failed" : null
      );
  }

  async findCoalescibleQueueItem(dedupeKey: string, threshold: Date): Promise<QueueItem | null> {
    const row = this.db
      .query(
        `SELECT id, source_id, payload_json, priority, status, scheduled_for, attempts, created_at, updated_at
         FROM task_queue
         WHERE status IN ('queued','running')
           AND json_extract(payload_json, '$.dedupeKey') = ?
           AND updated_at >= ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(dedupeKey, threshold.toISOString()) as SqlRecord | null;

    if (!row) {
      return null;
    }

    const payload = JSON.parse(String(row.payload_json)) as {
      payload: unknown;
      coalescedCount?: number;
    };

    return {
      id: String(row.id),
      dedupeKey,
      priority: toPriority(Number(row.priority)),
      payload: payload.payload,
      status: normalizeStatus(String(row.status)),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
      availableAt: new Date(String(row.scheduled_for)),
      attempts: Number(row.attempts ?? 0),
      coalescedCount: Number(payload.coalescedCount ?? 0),
    };
  }

  async listReadyQueueItems(limit: number, now: Date): Promise<QueueItem[]> {
    const rows = this.db
      .query(
        `SELECT id, source_id, payload_json, priority, status, scheduled_for, attempts, created_at, updated_at
         FROM task_queue
         WHERE status='queued'
           AND (scheduled_for IS NULL OR scheduled_for <= ?)
         ORDER BY priority ASC, created_at ASC
         LIMIT ?`
      )
      .all(now.toISOString(), limit) as SqlRecord[];

    return rows.map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as {
        dedupeKey: string;
        payload: unknown;
        coalescedCount?: number;
      };

      return {
        id: String(row.id),
        dedupeKey: String(payload.dedupeKey),
        priority: toPriority(Number(row.priority)),
        payload: payload.payload,
        status: "queued",
        createdAt: new Date(String(row.created_at)),
        updatedAt: new Date(String(row.updated_at)),
        availableAt: new Date(String(row.scheduled_for ?? row.created_at)),
        attempts: Number(row.attempts ?? 0),
        coalescedCount: Number(payload.coalescedCount ?? 0),
      };
    });
  }

  async countReadyQueueItems(now: Date): Promise<number> {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count
         FROM task_queue
         WHERE status='queued' AND (scheduled_for IS NULL OR scheduled_for <= ?)`
      )
      .get(now.toISOString()) as SqlRecord;

    return Number(row.count ?? 0);
  }

  async updateQueueItemStatus(id: string, status: QueueItemStatus, updatedAt: Date): Promise<void> {
    this.db
      .query(
        `UPDATE task_queue
         SET status=?,
             updated_at=?,
             attempts=CASE WHEN ?='running' THEN attempts + 1 ELSE attempts END,
             last_error=CASE WHEN ?='failed' THEN 'worker_failed' ELSE last_error END
         WHERE id=?`
      )
      .run(status === "done" ? "completed" : status, updatedAt.toISOString(), status, status, id);
  }

  async appendCommandAudit(record: CommandAuditRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO command_audit
         (id, run_id, command, cwd, started_at, finished_at, exit_code, artifact_refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.runId,
        record.command,
        record.cwd,
        record.startedAt.toISOString(),
        record.finishedAt.toISOString(),
        record.exitCode,
        JSON.stringify(record.artifactRefs)
      );
  }
}

export class InMemoryWorkerDb implements WorkerDb {
  private queue = new Map<string, QueueItem>();
  private commandAudit: CommandAuditRecord[] = [];
  private workerState: WorkerState | null = null;

  async getWorkerMode(): Promise<"active" | "paused"> {
    return "active";
  }

  async saveWorkerState(state: WorkerState): Promise<void> {
    this.workerState = { ...state };
  }

  async saveQueueItem(item: QueueItem): Promise<void> {
    this.queue.set(item.id, { ...item });
  }

  async findCoalescibleQueueItem(dedupeKey: string, threshold: Date): Promise<QueueItem | null> {
    let match: QueueItem | null = null;
    for (const item of this.queue.values()) {
      const isCandidate =
        item.dedupeKey === dedupeKey &&
        (item.status === "queued" || item.status === "running") &&
        item.updatedAt >= threshold;
      if (!isCandidate) {
        continue;
      }
      if (!match || item.updatedAt > match.updatedAt) {
        match = item;
      }
    }
    return match ? { ...match } : null;
  }

  async listReadyQueueItems(limit: number, now: Date): Promise<QueueItem[]> {
    return [...this.queue.values()]
      .filter((item) => item.status === "queued" && item.availableAt <= now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((item) => ({ ...item }));
  }

  async countReadyQueueItems(now: Date): Promise<number> {
    return [...this.queue.values()].filter((item) => item.status === "queued" && item.availableAt <= now).length;
  }

  async updateQueueItemStatus(id: string, status: QueueItemStatus, updatedAt: Date): Promise<void> {
    const current = this.queue.get(id);
    if (!current) return;
    this.queue.set(id, {
      ...current,
      status,
      updatedAt,
      attempts: status === "running" ? current.attempts + 1 : current.attempts,
    });
  }

  async appendCommandAudit(record: CommandAuditRecord): Promise<void> {
    this.commandAudit.push({ ...record });
  }

  getQueueSnapshot(): QueueItem[] {
    return [...this.queue.values()].map((item) => ({ ...item }));
  }

  getWorkerState(): WorkerState | null {
    return this.workerState ? { ...this.workerState } : null;
  }

  getAuditSnapshot(): CommandAuditRecord[] {
    return this.commandAudit.map((item) => ({ ...item }));
  }
}
