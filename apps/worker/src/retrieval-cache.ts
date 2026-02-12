import type { Database } from "@squidward/db";

export interface RetrievalCachedPayload {
  queryId?: string;
  intent: string;
  usedTokens: number;
  budgetTokens: number;
  evidenceRefs: string[];
  canonicalFacts: Array<{ key: string; value: Record<string, unknown>; source: string }>;
  repoLearningFacts: Array<{ key: string; value: Record<string, unknown>; confidence: number }>;
  recentEpisodes: Array<{ runId: string; summary: string }>;
  snippets: Array<{ sourceClass: string; citation: string; text: string; score: number }>;
}

interface LookupInput {
  db: Database;
  cacheKey: string;
  sourceFingerprint: string;
  nowIso: string;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const lookupRetrievalCache = (input: LookupInput): RetrievalCachedPayload | null => {
  const row = input.db
    .query(
      `SELECT summary_text
       FROM context_cache
       WHERE cache_key=? AND source_fingerprint=? AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(input.cacheKey, input.sourceFingerprint, input.nowIso) as Record<string, unknown> | null;
  if (!row?.summary_text) {
    return null;
  }
  const parsed = parseJson<RetrievalCachedPayload | null>(row.summary_text, null);
  return parsed;
};

interface StoreInput {
  db: Database;
  cacheKey: string;
  sourceFingerprint: string;
  payload: RetrievalCachedPayload;
  expiresAtExpr: string;
}

export const storeRetrievalCache = (input: StoreInput): void => {
  const summary = JSON.stringify(input.payload);
  input.db
    .query(
      `INSERT INTO context_cache
       (id, cache_key, summary_text, source_fingerprint, token_size, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?), datetime('now'))`
    )
    .run(
      crypto.randomUUID(),
      input.cacheKey,
      summary,
      input.sourceFingerprint,
      Math.ceil(summary.length / 4),
      input.expiresAtExpr
    );
};
