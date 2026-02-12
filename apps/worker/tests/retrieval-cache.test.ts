import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@squidward/db";

import { storeRetrievalCache } from "../src/retrieval-cache";

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sq-retrieval-cache-"));
  return join(dir, "agent.db");
};

describe("retrieval cache upsert", () => {
  it("updates existing cache key instead of throwing unique violations", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath, { create: true, strict: false });
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_cache (
        id TEXT PRIMARY KEY,
        cache_key TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        token_size INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_context_cache_key
      ON context_cache(cache_key);
    `);

    const cacheKey = "retrieval:v3:/Users/ryanwible/projects/wrela:ops:hash";
    storeRetrievalCache({
      db,
      cacheKey,
      sourceFingerprint: "fp_1",
      expiresAtExpr: "+10 minutes",
      payload: {
        queryId: "rq_1",
        intent: "ops",
        usedTokens: 200,
        budgetTokens: 4000,
        evidenceRefs: ["doc_1"],
        canonicalFacts: [],
        repoLearningFacts: [],
        recentEpisodes: [],
        snippets: [],
      },
    });

    storeRetrievalCache({
      db,
      cacheKey,
      sourceFingerprint: "fp_2",
      expiresAtExpr: "+10 minutes",
      payload: {
        queryId: "rq_2",
        intent: "ops",
        usedTokens: 180,
        budgetTokens: 4000,
        evidenceRefs: ["doc_2"],
        canonicalFacts: [],
        repoLearningFacts: [],
        recentEpisodes: [],
        snippets: [],
      },
    });

    const row = db
      .query(
        `SELECT cache_key, source_fingerprint, summary_text
         FROM context_cache
         WHERE cache_key=?`
      )
      .get(cacheKey) as Record<string, unknown> | null;
    expect(row).toBeTruthy();
    expect(row?.source_fingerprint).toBe("fp_2");
    const summary = JSON.parse(String(row?.summary_text ?? "{}")) as { queryId?: string; usedTokens?: number };
    expect(summary.queryId).toBe("rq_2");
    expect(summary.usedTokens).toBe(180);

    const count = db
      .query(`SELECT COUNT(*) AS count FROM context_cache WHERE cache_key=?`)
      .get(cacheKey) as Record<string, unknown> | null;
    expect(Number(count?.count ?? 0)).toBe(1);
  });
});
