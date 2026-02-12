import { describe, expect, it } from "bun:test";
import { Database } from "@squidward/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MemoryGovernor } from "../src/memory-governor";

const migrate = (db: Database): void => {
  const migrationPath = resolve(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
};

describe("MemoryGovernor", () => {
  it("commits canonical proposals with citations", () => {
    const db = new Database(":memory:");
    migrate(db);
    const governor = new MemoryGovernor(db);
    const result = governor.commit(
      "run_1",
      [
        {
          layerHint: "canonical",
          type: "fact",
          key: "repo.build.command",
          value: { command: "bun run build" },
          confidence: 0.9,
          citations: ["command:audit_1"],
        },
      ],
      "unit_test"
    );
    expect(result.accepted).toBe(1);
    const fact = db.query(`SELECT namespace, fact_key FROM memory_facts LIMIT 1`).get() as { namespace: string; fact_key: string } | null;
    expect(fact).not.toBeNull();
    expect(fact!.namespace).toBe("canonical");
    expect(fact!.fact_key).toBe("repo.build.command");
  });

  it("rejects non-working proposals without citations", () => {
    const db = new Database(":memory:");
    migrate(db);
    const governor = new MemoryGovernor(db);
    const result = governor.commit(
      "run_2",
      [
        {
          layerHint: "canonical",
          type: "fact",
          key: "repo.fail.mode",
          value: { reason: "missing" },
          confidence: 0.95,
          citations: [],
        },
      ],
      "unit_test"
    );
    expect(result.rejected).toBe(1);
  });
});
