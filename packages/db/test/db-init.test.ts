import { afterEach, describe, expect, test } from "bun:test";

import { PlatformDb } from "../src/db";

const dbs: PlatformDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
});

describe("PlatformDb", () => {
  test("initializes required schema", () => {
    const db = new PlatformDb();
    dbs.push(db);
    db.init();

    const requiredTables = [
      "services",
      "work_items",
      "agent_runs",
      "provider_budget_usage",
      "secret_records",
      "codex_sessions",
      "session_events",
      "worker_state",
      "task_queue"
    ];

    for (const tableName of requiredTables) {
      const result = db.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;"
        )
        .get(tableName) as { name: string } | null;

      expect(result?.name).toBe(tableName);
    }
  });

  test("reports busy timeout in health()", () => {
    const db = new PlatformDb();
    dbs.push(db);

    const health = db.health();
    expect(health.busyTimeoutMs).toBe(5000);
  });
});
