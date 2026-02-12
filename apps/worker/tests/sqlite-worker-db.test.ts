import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "@squidward/db";

import { SqliteWorkerDb } from "../src/db";

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sq-worker-db-"));
  return join(dir, "agent.db");
};

describe("SqliteWorkerDb queue compatibility", () => {
  it("recovers legacy payload_json rows and synthesizes runId", async () => {
    const dbPath = makeDbPath();
    const workerDb = new SqliteWorkerDb({ dbPath });

    const rawDb = new Database(dbPath, { create: true, strict: false });
    rawDb.query(
      `INSERT INTO task_queue
       (id, source_id, task_type, payload_json, priority, status, scheduled_for, attempts, created_at, updated_at, last_error)
       VALUES
       ('legacy_task_1', 'legacy_run_1', 'maintenance', '{"taskType":"maintenance","command":"echo hi"}', 3, 'queued', datetime('now'), 0, datetime('now'), datetime('now'), NULL)`
    ).run();

    const ready = await workerDb.listReadyQueueItems(10, new Date());
    const item = ready.find((entry) => entry.id === "legacy_task_1");
    expect(item).toBeTruthy();
    expect(item?.dedupeKey).toBe("legacy:legacy_task_1");
    expect((item?.payload as { runId?: string }).runId).toBe("legacy_run_1");
    expect((item?.payload as { taskType?: string }).taskType).toBe("maintenance");
  });
});
