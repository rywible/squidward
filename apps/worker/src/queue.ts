import type { WorkerDb } from "./db";
import type { Priority, QueueItem } from "./types";

export interface QueueTaskHandler<T = unknown> {
  (task: QueueItem<T>): Promise<void>;
}

export interface EnqueueInput<T = unknown> {
  dedupeKey: string;
  priority: Priority;
  payload: T;
  availableAt?: Date;
}

const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

export class SerializedTaskProcessor<T = unknown> {
  private readonly db: WorkerDb;
  private readonly coalesceWindowMs: number;
  private readonly now: () => Date;

  constructor(db: WorkerDb, options?: { coalesceWindowMs?: number; now?: () => Date }) {
    this.db = db;
    this.coalesceWindowMs = options?.coalesceWindowMs ?? 30_000;
    this.now = options?.now ?? (() => new Date());
  }

  async enqueue(input: EnqueueInput<T>): Promise<{ id: string; coalesced: boolean }> {
    const now = this.now();
    const threshold = new Date(now.getTime() - this.coalesceWindowMs);

    const existing = await this.db.findCoalescibleQueueItem(input.dedupeKey, threshold);
    if (existing) {
      const merged: QueueItem = {
        ...existing,
        priority: prioritize(existing.priority, input.priority),
        payload: input.payload,
        updatedAt: now,
        coalescedCount: existing.coalescedCount + 1,
      };
      await this.db.saveQueueItem(merged);
      return { id: existing.id, coalesced: true };
    }

    const item: QueueItem = {
      id: crypto.randomUUID(),
      dedupeKey: input.dedupeKey,
      priority: input.priority,
      payload: input.payload,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      availableAt: input.availableAt ?? now,
      attempts: 0,
      coalescedCount: 0,
    };

    await this.db.saveQueueItem(item);
    return { id: item.id, coalesced: false };
  }

  async processNext(handler: QueueTaskHandler<T>): Promise<QueueItem<T> | null> {
    const next = await this.claimNext();
    if (!next) {
      return null;
    }

    try {
      await handler(next as QueueItem<T>);
      await this.finalize(next.id, true);
    } catch (error) {
      await this.finalize(next.id, false);
      throw error;
    }

    return next as QueueItem<T>;
  }

  async claimNext(): Promise<QueueItem<T> | null> {
    const next = await this.pickNextReadyTask();
    if (!next) {
      return null;
    }
    await this.db.updateQueueItemStatus(next.id, "running", this.now());
    return next as QueueItem<T>;
  }

  async finalize(taskId: string, success: boolean): Promise<void> {
    await this.db.updateQueueItemStatus(taskId, success ? "done" : "failed", this.now());
  }

  private async pickNextReadyTask(): Promise<QueueItem | null> {
    const ready = await this.db.listReadyQueueItems(100, this.now());
    if (ready.length === 0) {
      return null;
    }

    ready.sort((a, b) => {
      const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return ready[0] ?? null;
  }
}

function prioritize(current: Priority, incoming: Priority): Priority {
  return PRIORITY_RANK[incoming] < PRIORITY_RANK[current] ? incoming : current;
}
