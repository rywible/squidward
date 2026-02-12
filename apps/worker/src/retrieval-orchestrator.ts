import { createHash } from "node:crypto";
import type { Database } from "@squidward/db";

import { lexicalOverlap, reindexRetrievalDocuments, semanticSimilarity } from "./retrieval-indexer";
import {
  rankRetrievalCandidates,
  sourceClassOrder,
  type RankedRetrievalCandidate,
  type RetrievalCandidate,
  type RetrievalSourceClass,
} from "./retrieval-ranker";
import { lookupRetrievalCache, storeRetrievalCache, type RetrievalCachedPayload } from "./retrieval-cache";

export interface RetrievalContextPack {
  queryId: string;
  intent: "ops" | "code" | "perf" | "incident" | "policy" | "meta";
  usedTokens: number;
  budgetTokens: number;
  cacheHit: boolean;
  evidenceRefs: string[];
  canonicalFacts: Array<{ key: string; value: Record<string, unknown>; source: string }>;
  repoLearningFacts: Array<{ key: string; value: Record<string, unknown>; confidence: number }>;
  recentEpisodes: Array<{ runId: string; summary: string }>;
  snippets: Array<{ sourceClass: RetrievalSourceClass; citation: string; text: string; score: number }>;
}

interface BuildInput {
  db: Database;
  repoPath: string;
  objective: string;
  requestText: string;
  taskType?: string;
  budgetTokens?: number;
}

type SqlRecord = Record<string, unknown>;

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalize = (value: string): string => value.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 500);

const nowIso = (): string => new Date().toISOString();

const classifyIntent = (text: string): RetrievalContextPack["intent"] => {
  const normalized = normalize(text);
  if (/incident|outage|error|failure|rollback|pager/.test(normalized)) return "incident";
  if (/perf|latency|throughput|benchmark|hotspot/.test(normalized)) return "perf";
  if (/policy|rule|safety|guardrail|risk/.test(normalized)) return "policy";
  if (/code|refactor|bug|test|compile|typescript|rust|wr/.test(normalized)) return "code";
  if (/ops|deploy|queue|task|infra|runtime/.test(normalized)) return "ops";
  return "meta";
};

const freshnessScore = (isoDate: string | undefined): number => {
  if (!isoDate) return 0.2;
  const ageMs = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= 24) return 1;
  if (ageHours <= 7 * 24) return 0.85;
  if (ageHours <= 30 * 24) return 0.65;
  if (ageHours <= 90 * 24) return 0.4;
  return 0.2;
};

const sourceQuality = (sourceClass: RetrievalSourceClass): number => {
  if (sourceClass === "policy") return 1;
  if (sourceClass === "canonical") return 0.95;
  if (sourceClass === "repo_learning") return 0.85;
  if (sourceClass === "episodic") return 0.7;
  return 0.6;
};

const canonicalPriority = (sourceClass: RetrievalSourceClass): number => {
  if (sourceClass === "policy") return 1;
  if (sourceClass === "canonical") return 0.9;
  if (sourceClass === "repo_learning") return 0.75;
  if (sourceClass === "episodic") return 0.5;
  return 0.35;
};

const taskMatch = (sourceClass: RetrievalSourceClass, intent: RetrievalContextPack["intent"]): number => {
  if (intent === "policy") return sourceClass === "policy" || sourceClass === "canonical" ? 1 : 0.5;
  if (intent === "perf") {
    if (sourceClass === "repo_learning" || sourceClass === "evidence") return 0.9;
    if (sourceClass === "canonical") return 0.8;
    return 0.6;
  }
  if (intent === "code") {
    if (sourceClass === "repo_learning" || sourceClass === "canonical") return 0.9;
    return 0.7;
  }
  if (intent === "incident") {
    if (sourceClass === "episodic" || sourceClass === "evidence") return 0.9;
    return 0.7;
  }
  return 0.7;
};

const toCandidate = (input: {
  sourceClass: RetrievalSourceClass;
  sourceRef: string;
  citation: string;
  text: string;
  semantic: number;
  confidence: number;
  createdAt?: string;
  intent: RetrievalContextPack["intent"];
  metadata?: Record<string, unknown>;
}): RetrievalCandidate => ({
  sourceClass: input.sourceClass,
  sourceRef: input.sourceRef,
  citation: input.citation,
  text: input.text,
  semantic: input.semantic,
  freshness: freshnessScore(input.createdAt),
  confidence: input.confidence,
  sourceQuality: sourceQuality(input.sourceClass),
  taskMatch: taskMatch(input.sourceClass, input.intent),
  canonicalPriority: canonicalPriority(input.sourceClass),
  createdAt: input.createdAt,
  metadata: input.metadata,
});

const buildSourceFingerprint = (db: Database, repoPath: string): string => {
  const parts: string[] = [repoPath];
  const stampQueries: Array<{ table: string; stampSql: string }> = [
    { table: "memory_facts", stampSql: "MAX(updated_at)" },
    { table: "repo_learning_facts", stampSql: "MAX(updated_at)" },
    { table: "memory_episodes", stampSql: "MAX(created_at)" },
    { table: "memory_episode_summaries", stampSql: "MAX(created_at)" },
    { table: "retrieval_feedback", stampSql: "MAX(created_at)" },
    { table: "policy_rules", stampSql: "MAX(updated_at)" },
  ];
  for (const query of stampQueries) {
    const row = db
      .query(`SELECT COALESCE(${query.stampSql}, '') AS stamp, COUNT(*) AS count FROM ${query.table}`)
      .get() as SqlRecord;
    parts.push(`${query.table}:${String(row.stamp ?? "")}:${Number(row.count ?? 0)}`);
  }
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
};

const hasFreshRetrievalIndex = (db: Database, repoPath: string): boolean => {
  const sourceRow = db
    .query(
      `SELECT
         COALESCE(MAX(updated_at), '') AS facts_max,
         (SELECT COALESCE(MAX(updated_at), '') FROM repo_learning_facts WHERE repo_path=?) AS repo_max,
         (SELECT COALESCE(MAX(created_at), '') FROM memory_episodes) AS episodes_max,
         (SELECT COALESCE(MAX(created_at), '') FROM command_audit) AS audit_max
       FROM memory_facts`
    )
    .get(repoPath) as SqlRecord;
  const docsRow = db
    .query(
      `SELECT
         COUNT(*) AS count,
         COALESCE(MAX(updated_at), '') AS docs_max
       FROM retrieval_documents
       WHERE repo_path=?`
    )
    .get(repoPath) as SqlRecord;

  const docsCount = Number(docsRow.count ?? 0);
  if (docsCount === 0) {
    return false;
  }
  const sourceMax = [sourceRow.facts_max, sourceRow.repo_max, sourceRow.episodes_max, sourceRow.audit_max]
    .map((value) => String(value ?? ""))
    .sort()
    .at(-1) ?? "";
  const docsMax = String(docsRow.docs_max ?? "");
  if (docsMax < sourceMax) {
    return false;
  }

  const sourceCounts = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM memory_facts WHERE state='active') AS canonical_count,
         (SELECT COUNT(*) FROM repo_learning_facts WHERE repo_path=?) AS repo_count,
         (SELECT COUNT(*) FROM memory_episodes) AS episodic_count,
         (SELECT COUNT(*) FROM command_audit) AS evidence_count`
    )
    .get(repoPath) as SqlRecord;
  const docCounts = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type='canonical' THEN 1 ELSE 0 END), 0) AS canonical_docs,
         COALESCE(SUM(CASE WHEN doc_type='repo_learning' THEN 1 ELSE 0 END), 0) AS repo_docs,
         COALESCE(SUM(CASE WHEN doc_type='episodic' THEN 1 ELSE 0 END), 0) AS episodic_docs,
         COALESCE(SUM(CASE WHEN doc_type='evidence' THEN 1 ELSE 0 END), 0) AS evidence_docs
       FROM retrieval_documents
       WHERE repo_path=?`
    )
    .get(repoPath) as SqlRecord;

  const expectedCanonical = Math.min(Number(sourceCounts.canonical_count ?? 0), 300);
  const expectedRepo = Math.min(Number(sourceCounts.repo_count ?? 0), 300);
  const expectedEpisodic = Math.min(Number(sourceCounts.episodic_count ?? 0), 200);
  const expectedEvidence = Math.min(Number(sourceCounts.evidence_count ?? 0), 300);

  if (Number(docCounts.canonical_docs ?? 0) < expectedCanonical) return false;
  if (Number(docCounts.repo_docs ?? 0) < expectedRepo) return false;
  if (Number(docCounts.episodic_docs ?? 0) < expectedEpisodic) return false;
  if (Number(docCounts.evidence_docs ?? 0) < expectedEvidence) return false;
  return true;
};

const loadFeedbackBias = (db: Database): Record<RetrievalSourceClass, number> => {
  const base: Record<RetrievalSourceClass, number> = {
    policy: 0,
    canonical: 0,
    repo_learning: 0,
    episodic: 0,
    evidence: 0,
  };
  const rows = db
    .query(
      `WITH distinct_feedback_sources AS (
         SELECT DISTINCT rf.id AS feedback_id, rr.source_class, rf.feedback_type
         FROM retrieval_feedback rf
         JOIN retrieval_results rr ON rr.query_id = rf.query_id
         WHERE rr.included = 1
           AND rf.created_at >= datetime('now', '-14 day')
       )
       SELECT source_class, feedback_type, COUNT(*) AS count
       FROM distinct_feedback_sources
       GROUP BY source_class, feedback_type`
    )
    .all() as SqlRecord[];

  for (const row of rows) {
    const sourceClass = String(row.source_class) as RetrievalSourceClass;
    const feedbackType = String(row.feedback_type);
    const count = Number(row.count ?? 0);
    if (!(sourceClass in base) || count <= 0) continue;

    if (feedbackType === "helpful") {
      base[sourceClass] += Math.min(0.06, count * 0.006);
    } else if (feedbackType === "missed-context") {
      if (sourceClass === "canonical" || sourceClass === "repo_learning" || sourceClass === "evidence") {
        base[sourceClass] += Math.min(0.08, count * 0.01);
      }
    } else if (feedbackType === "wrong-priority") {
      if (sourceClass === "episodic" || sourceClass === "evidence") {
        base[sourceClass] -= Math.min(0.1, count * 0.012);
      } else {
        base[sourceClass] -= Math.min(0.03, count * 0.004);
      }
    }
  }
  return base;
};

const applyFeedbackBias = (
  ranked: RankedRetrievalCandidate[],
  bias: Record<RetrievalSourceClass, number>
): RankedRetrievalCandidate[] => {
  for (const candidate of ranked) {
    const adjusted = candidate.score + (bias[candidate.sourceClass] ?? 0);
    candidate.score = Math.max(0, Math.min(1.5, Number(adjusted.toFixed(6))));
  }
  ranked.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    const classDiff = sourceClassOrder.indexOf(a.sourceClass) - sourceClassOrder.indexOf(b.sourceClass);
    if (classDiff !== 0) return classDiff;
    return a.sourceRef.localeCompare(b.sourceRef);
  });
  return ranked;
};

const stageTwoRerank = (ranked: RankedRetrievalCandidate[], intent: RetrievalContextPack["intent"]): RankedRetrievalCandidate[] => {
  if (ranked.length <= 80) return ranked;
  const topWindow = ranked.slice(0, 120);
  const recencyIntentBoost = intent === "incident" || intent === "perf";
  for (const candidate of topWindow) {
    let bonus = 0;
    if (recencyIntentBoost && candidate.freshness >= 0.85) bonus += 0.03;
    if (candidate.sourceClass === "policy") bonus += 0.05;
    if (candidate.sourceClass === "canonical") bonus += 0.03;
    candidate.score = Number((candidate.score + bonus).toFixed(6));
  }
  topWindow.sort((a, b) => b.score - a.score);
  return [...topWindow, ...ranked.slice(120)];
};

const gatherCandidates = (db: Database, input: {
  intent: RetrievalContextPack["intent"];
  repoPath: string;
  query: string;
}): { mandatory: RetrievalCandidate[]; all: RetrievalCandidate[] } => {
  const mandatory: RetrievalCandidate[] = [];
  const all: RetrievalCandidate[] = [];

  const policyRows = db
    .query(
      `SELECT id, fact_key, fact_value_json, confidence, updated_at
       FROM memory_facts
       WHERE state='active' AND (namespace IN ('policy','safety') OR fact_key LIKE 'policy.%')
       ORDER BY updated_at DESC
       LIMIT 20`
    )
    .all() as SqlRecord[];
  for (const row of policyRows) {
    const text = `Policy ${String(row.fact_key)}: ${JSON.stringify(parseJson<Record<string, unknown>>(row.fact_value_json, {}))}`.slice(
      0,
      220
    );
    const candidate = toCandidate({
      sourceClass: "policy",
      sourceRef: `memory_facts:${String(row.id)}`,
      citation: `memory_facts:${String(row.id)}`,
      text,
      semantic: 1,
      confidence: Math.max(0.7, Number(row.confidence ?? 0.7)),
      createdAt: String(row.updated_at),
      intent: input.intent,
    });
    mandatory.push(candidate);
    all.push(candidate);
  }

  const canonicalRows = db
    .query(
      `SELECT id, fact_key, fact_value_json, source, confidence, updated_at
       FROM memory_facts
       WHERE state='active'
       ORDER BY updated_at DESC
       LIMIT 120`
    )
    .all() as SqlRecord[];
  for (const row of canonicalRows) {
    const text = `${String(row.fact_key)} ${JSON.stringify(parseJson<Record<string, unknown>>(row.fact_value_json, {}))}`;
    all.push(
      toCandidate({
        sourceClass: "canonical",
        sourceRef: `memory_facts:${String(row.id)}`,
        citation: `memory_facts:${String(row.id)}`,
        text,
        semantic: lexicalOverlap(input.query, text),
        confidence: Number(row.confidence ?? 0.75),
        createdAt: String(row.updated_at),
        intent: input.intent,
        metadata: { source: String(row.source) },
      })
    );
  }

  const repoRows = db
    .query(
      `SELECT id, fact_key, fact_value_json, confidence, updated_at
       FROM repo_learning_facts
       WHERE repo_path=?
       ORDER BY updated_at DESC
       LIMIT 120`
    )
    .all(input.repoPath) as SqlRecord[];
  for (const row of repoRows) {
    const text = `${String(row.fact_key)} ${JSON.stringify(parseJson<Record<string, unknown>>(row.fact_value_json, {}))}`;
    all.push(
      toCandidate({
        sourceClass: "repo_learning",
        sourceRef: `repo_learning_facts:${String(row.id)}`,
        citation: `repo_learning_facts:${String(row.id)}`,
        text,
        semantic: lexicalOverlap(input.query, text),
        confidence: Number(row.confidence ?? 0.6),
        createdAt: String(row.updated_at),
        intent: input.intent,
      })
    );
  }

  const episodicRows = db
    .query(
      `SELECT me.id, me.run_id, me.created_at, mes.summary_md, me.outcome_json
       FROM memory_episodes me
       LEFT JOIN memory_episode_summaries mes ON mes.episode_id = me.id
       ORDER BY me.created_at DESC
       LIMIT 80`
    )
    .all() as SqlRecord[];
  for (const row of episodicRows) {
    const summary = row.summary_md
      ? String(row.summary_md)
      : String(parseJson<Record<string, unknown>>(row.outcome_json, {}).summary ?? "episode");
    all.push(
      toCandidate({
        sourceClass: "episodic",
        sourceRef: `memory_episodes:${String(row.id)}`,
        citation: `memory_episodes:${String(row.id)}`,
        text: summary,
        semantic: lexicalOverlap(input.query, summary),
        confidence: 0.65,
        createdAt: String(row.created_at),
        intent: input.intent,
        metadata: { runId: String(row.run_id) },
      })
    );
  }

  const evidenceRows = db
    .query(
      `SELECT d.id, d.source_ref, d.title, d.content, d.updated_at, e.embedding
       FROM retrieval_documents d
       LEFT JOIN retrieval_embeddings e ON e.document_id = d.id
       WHERE d.repo_path=?
       ORDER BY d.updated_at DESC
       LIMIT 220`
    )
    .all(input.repoPath) as SqlRecord[];
  for (const row of evidenceRows) {
    const text = `${String(row.title)}\n${String(row.content)}`.slice(0, 1200);
    const semantic = row.embedding ? semanticSimilarity(input.query, String(row.embedding)) : lexicalOverlap(input.query, text);
    const lexical = lexicalOverlap(input.query, text);
    const blended = Math.max(semantic, lexical * 0.8);
    if (blended < 0.04) {
      continue;
    }
    all.push(
      toCandidate({
        sourceClass: "evidence",
        sourceRef: String(row.source_ref),
        citation: String(row.source_ref),
        text,
        semantic: blended,
        confidence: 0.55,
        createdAt: String(row.updated_at),
        intent: input.intent,
      })
    );
  }

  return { mandatory, all };
};

const selectUnderBudget = (ranked: RankedRetrievalCandidate[], mandatoryIds: Set<string>, budgetTokens: number): RankedRetrievalCandidate[] => {
  const byClassCap = new Map<RetrievalSourceClass, number>();
  const selected: RankedRetrievalCandidate[] = [];
  let used = 0;

  const mandatory = ranked
    .filter((candidate) => mandatoryIds.has(candidate.id))
    .sort((a, b) => {
      const classDiff = sourceClassOrder.indexOf(a.sourceClass) - sourceClassOrder.indexOf(b.sourceClass);
      if (classDiff !== 0) return classDiff;
      return b.score - a.score;
    });
  for (const candidate of mandatory) {
    if (used + candidate.estimatedTokens > budgetTokens) {
      if (selected.length > 0) continue;
      const forced = {
        ...candidate,
        estimatedTokens: Math.min(candidate.estimatedTokens, budgetTokens),
      };
      selected.push(forced);
      used = forced.estimatedTokens;
      byClassCap.set(candidate.sourceClass, (byClassCap.get(candidate.sourceClass) ?? 0) + 1);
      continue;
    }
    selected.push(candidate);
    used += candidate.estimatedTokens;
    byClassCap.set(candidate.sourceClass, (byClassCap.get(candidate.sourceClass) ?? 0) + 1);
  }

  for (const sourceClass of sourceClassOrder) {
    const classItems = ranked.filter((candidate) => candidate.sourceClass === sourceClass && !mandatoryIds.has(candidate.id));
    for (const candidate of classItems) {
      const cap = byClassCap.get(sourceClass) ?? 0;
      if (cap >= 3) continue;
      if (used + candidate.estimatedTokens > budgetTokens) continue;
      selected.push(candidate);
      used += candidate.estimatedTokens;
      byClassCap.set(sourceClass, cap + 1);
    }
  }

  return selected.sort((a, b) => {
    const classDiff = sourceClassOrder.indexOf(a.sourceClass) - sourceClassOrder.indexOf(b.sourceClass);
    if (classDiff !== 0) return classDiff;
    return b.score - a.score;
  });
};

const dedupeCandidates = (candidates: RankedRetrievalCandidate[]): RankedRetrievalCandidate[] => {
  const seen = new Set<string>();
  const deduped: RankedRetrievalCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.sourceClass}:${candidate.sourceRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
};

const buildPackFromSelected = (queryId: string, intent: RetrievalContextPack["intent"], selected: RankedRetrievalCandidate[], budgetTokens: number, cacheHit: boolean): RetrievalContextPack => {
  const compact = (value: string, max = 280): string => (value.length <= max ? value : `${value.slice(0, max)}...`);

  const canonicalFacts = selected
    .filter((candidate) => candidate.sourceClass === "policy" || candidate.sourceClass === "canonical")
    .map((candidate) => {
      const key = candidate.text.slice(0, 120);
      return {
        key,
        value: {
          text: compact(candidate.text, 320),
          citation: candidate.citation,
        },
        source: candidate.citation,
      };
    });

  const repoLearningFacts = selected
    .filter((candidate) => candidate.sourceClass === "repo_learning")
    .map((candidate) => ({
      key: candidate.text.slice(0, 120),
      value: {
        text: compact(candidate.text, 280),
        citation: candidate.citation,
      },
      confidence: Number(candidate.confidence.toFixed(4)),
    }));

  const recentEpisodes = selected
    .filter((candidate) => candidate.sourceClass === "episodic")
    .map((candidate) => ({
      runId: candidate.metadata?.runId ? String(candidate.metadata.runId) : candidate.sourceRef,
      summary: compact(candidate.text, 260),
    }));

  const snippets = selected
    .filter((candidate) => candidate.sourceClass === "evidence")
    .slice(0, 8)
    .map((candidate) => ({
      sourceClass: candidate.sourceClass,
      citation: candidate.citation,
      text: compact(candidate.text, 260),
      score: Number(candidate.score.toFixed(6)),
    }));

  return {
    queryId,
    intent,
    usedTokens: selected.reduce((acc, item) => acc + item.estimatedTokens, 0),
    budgetTokens,
    cacheHit,
    evidenceRefs: [...new Set(selected.map((item) => item.citation))],
    canonicalFacts,
    repoLearningFacts,
    recentEpisodes,
    snippets,
  };
};

const toCachePayload = (pack: RetrievalContextPack): RetrievalCachedPayload => ({
  queryId: pack.queryId,
  intent: pack.intent,
  usedTokens: pack.usedTokens,
  budgetTokens: pack.budgetTokens,
  evidenceRefs: pack.evidenceRefs,
  canonicalFacts: pack.canonicalFacts,
  repoLearningFacts: pack.repoLearningFacts,
  recentEpisodes: pack.recentEpisodes,
  snippets: pack.snippets,
});

const fromCachePayload = (queryId: string, payload: RetrievalCachedPayload): RetrievalContextPack => ({
  queryId,
  intent: (payload.intent as RetrievalContextPack["intent"]) ?? "meta",
  usedTokens: payload.usedTokens,
  budgetTokens: payload.budgetTokens,
  cacheHit: true,
  evidenceRefs: payload.evidenceRefs,
  canonicalFacts: payload.canonicalFacts,
  repoLearningFacts: payload.repoLearningFacts,
  recentEpisodes: payload.recentEpisodes,
  snippets: payload.snippets.map((item) => ({
    sourceClass: item.sourceClass as RetrievalSourceClass,
    citation: item.citation,
    text: item.text,
    score: item.score,
  })),
});

export const buildRetrievalContextPack = (input: BuildInput): RetrievalContextPack => {
  const startedAt = Date.now();
  const queryText = normalize(`${input.objective}\n${input.requestText}\n${input.taskType ?? ""}`);
  const intent = classifyIntent(queryText);
  const budgetTokens = input.budgetTokens ?? 4000;

  if (!hasFreshRetrievalIndex(input.db, input.repoPath)) {
    reindexRetrievalDocuments(input.db, input.repoPath);
    input.db.query(`DELETE FROM context_cache WHERE cache_key LIKE ?`).run(`retrieval:v3:${input.repoPath}:%`);
  }

  const sourceFingerprint = buildSourceFingerprint(input.db, input.repoPath);
  const cacheKey = `retrieval:v3:${input.repoPath}:${intent}:${queryText.slice(0, 280)}`;
  const queryId = crypto.randomUUID();

  const cached = lookupRetrievalCache({
    db: input.db,
    cacheKey,
    sourceFingerprint,
    nowIso: nowIso(),
  });
  if (cached) {
    const cachedPack = fromCachePayload(queryId, cached);
    input.db
      .query(
        `INSERT INTO retrieval_queries
         (id, query_text, intent, repo_path, candidate_count, selected_count, budget_tokens, used_tokens, cache_hit, latency_ms, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        queryId,
        queryText,
        intent,
        input.repoPath,
        cachedPack.snippets.length,
        cachedPack.budgetTokens,
        cachedPack.usedTokens,
        Date.now() - startedAt,
        nowIso()
      );
    return cachedPack;
  }

  const { mandatory, all } = gatherCandidates(input.db, {
    intent,
    repoPath: input.repoPath,
    query: queryText,
  });

  let ranked = rankRetrievalCandidates(all);
  const feedbackBias = loadFeedbackBias(input.db);
  ranked = applyFeedbackBias(ranked, feedbackBias);
  ranked = stageTwoRerank(ranked, intent);
  ranked = dedupeCandidates(ranked);
  const mandatoryIds = new Set(rankRetrievalCandidates(mandatory).map((candidate) => candidate.id));
  const selected = selectUnderBudget(ranked, mandatoryIds, budgetTokens);
  const pack = buildPackFromSelected(queryId, intent, selected, budgetTokens, false);

  input.db
    .query(
      `INSERT INTO retrieval_queries
       (id, query_text, intent, repo_path, candidate_count, selected_count, budget_tokens, used_tokens, cache_hit, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      queryId,
      queryText,
      intent,
      input.repoPath,
      ranked.length,
      selected.length,
      budgetTokens,
      pack.usedTokens,
      Date.now() - startedAt,
      nowIso()
    );

  for (const candidate of selected) {
    input.db
      .query(
        `INSERT INTO retrieval_results
         (id, query_id, document_id, source_class, source_ref, score, included, token_estimate, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        queryId,
        null,
        candidate.sourceClass,
        candidate.sourceRef,
        Number(candidate.score.toFixed(6)),
        candidate.estimatedTokens,
        candidate.text.slice(0, 1200),
        nowIso()
      );
  }

  storeRetrievalCache({
    db: input.db,
    cacheKey,
    sourceFingerprint,
    payload: toCachePayload(pack),
    expiresAtExpr: "+10 minutes",
  });

  return pack;
};
