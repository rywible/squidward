import { describe, expect, it } from "bun:test";
import { Database } from "@squidward/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyPersonaSignal } from "../src/persona-feedback";

const migrate = (db: Database): void => {
  const migrationPath = resolve(import.meta.dir, "../../../packages/db/migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
};

describe("applyPersonaSignal", () => {
  it("updates traits and writes persona snapshots", () => {
    const db = new Database(":memory:");
    migrate(db);

    applyPersonaSignal(db, {
      source: "test_suite",
      confidence: 0.9,
      adjustments: [
        { trait: "proactivity", delta: 0.05 },
        { trait: "directness", delta: -0.03 },
      ],
      context: { run: "unit" },
    });

    const trait = db
      .query(`SELECT value, confidence, source FROM persona_traits WHERE trait_name='proactivity' LIMIT 1`)
      .get() as { value: number; confidence: number; source: string } | null;
    expect(trait).not.toBeNull();
    expect(trait!.value).toBeGreaterThan(0.7);
    expect(trait!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(trait!.source).toBe("test_suite");

    const snapshot = db
      .query(`SELECT version, traits_json, policy_bindings_json FROM persona_snapshots ORDER BY version DESC LIMIT 1`)
      .get() as { version: number; traits_json: string; policy_bindings_json: string } | null;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.version).toBe(1);
    expect(snapshot!.traits_json).toContain("proactivity");
    expect(snapshot!.policy_bindings_json).toContain("test_suite");
  });

  it("clamps trait values to [0,1]", () => {
    const db = new Database(":memory:");
    migrate(db);

    applyPersonaSignal(db, {
      source: "test_suite",
      adjustments: [{ trait: "challenge_level", delta: 2 }],
    });
    applyPersonaSignal(db, {
      source: "test_suite",
      adjustments: [{ trait: "challenge_level", delta: -4 }],
    });

    const trait = db
      .query(`SELECT value FROM persona_traits WHERE trait_name='challenge_level' LIMIT 1`)
      .get() as { value: number } | null;
    expect(trait).not.toBeNull();
    expect(trait!.value).toBeGreaterThanOrEqual(0);
    expect(trait!.value).toBeLessThanOrEqual(1);
  });
});
