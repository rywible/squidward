export type SchedulerMode = "active" | "idle" | "off-hours";

export type Priority = "P0" | "P1" | "P2";

export type QueueItemStatus = "queued" | "running" | "done" | "failed";

export interface QueueItem<T = unknown> {
  id: string;
  dedupeKey: string;
  priority: Priority;
  payload: T;
  status: QueueItemStatus;
  createdAt: Date;
  updatedAt: Date;
  availableAt: Date;
  attempts: number;
  coalescedCount: number;
}

export interface WorkerState {
  mode: SchedulerMode;
  heartbeatAt: Date;
  queueDepth: number;
  activeSessionId: string | null;
}

export interface CommandAuditRecord {
  id: string;
  runId: string;
  command: string;
  cwd: string;
  startedAt: Date;
  finishedAt: Date;
  exitCode: number;
  artifactRefs: string[];
}
