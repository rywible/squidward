import type { Database } from "@squidward/db";
import { createHash } from "node:crypto";

import { buildRetrievalContextPack } from "./retrieval-orchestrator";
import type { WorkerTaskPayload } from "./runtime";

type SqlRecord = Record<string, unknown>;

export interface MissionPack {
  missionId: string;
  runId: string;
  repoPath: string;
  objective: string;
  taskType: string;
  constraints: {
    mode: "draft_only";
    mustUseBranchPrefix: string;
    maxFilesChanged: number;
    maxLocChanged: number;
    denyPaths: string[];
    requiredChecks: string[];
  };
  tokenEnvelope: {
    domain: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    economyMode: boolean;
  };
  cache: {
    hit: boolean;
    key: string;
    sourceFingerprint: string;
  };
  context: {
    canonicalFacts: Array<{ key: string; value: Record<string, unknown>; source: string }>;
    repoLearningFacts: Array<{ key: string; value: Record<string, unknown>; confidence: number }>;
    personaTraits: Array<{ name: string; value: number; confidence: number }>;
    recentEpisodes: Array<{ runId: string; summary: string }>;
    retrieval: {
      queryId: string;
      intent: "ops" | "code" | "perf" | "incident" | "policy" | "meta";
      usedTokens: number;
      budgetTokens: number;
      cacheHit: boolean;
      evidenceRefs: string[];
    };
    evidenceSnippets: Array<{ sourceClass: string; citation: string; text: string; score: number }>;
    cachedSummary?: string;
  };
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowIso = (): string => new Date().toISOString();

export const buildMissionPack = (input: {
  db?: Database;
  task: WorkerTaskPayload;
  repoPath: string;
  objective: string;
  tokenEnvelope: MissionPack["tokenEnvelope"];
  retrievalBudgetTokens?: number;
}): MissionPack => {
  const db = input.db;
  const retrieval = db
    ? buildRetrievalContextPack({
        db,
        repoPath: input.repoPath,
        objective: input.objective,
        requestText: input.task.requestText ?? input.task.command ?? "",
        taskType: input.task.taskType,
        budgetTokens: input.retrievalBudgetTokens ?? 4000,
      })
    : {
        queryId: crypto.randomUUID(),
        intent: "meta" as const,
        usedTokens: 0,
        budgetTokens: input.retrievalBudgetTokens ?? 4000,
        cacheHit: false,
        evidenceRefs: [] as string[],
        canonicalFacts: [] as Array<{ key: string; value: Record<string, unknown>; source: string }>,
        repoLearningFacts: [] as Array<{ key: string; value: Record<string, unknown>; confidence: number }>,
        recentEpisodes: [] as Array<{ runId: string; summary: string }>,
        snippets: [] as Array<{ sourceClass: string; citation: string; text: string; score: number }>,
      };

  const canonicalFacts = retrieval.canonicalFacts;
  const repoLearningFacts = retrieval.repoLearningFacts;

  const personaTraits: Array<{ name: string; value: number; confidence: number }> =
    db
      ?.query(
        `SELECT trait_name, value, confidence
         FROM persona_traits
         ORDER BY trait_name ASC`
      )
      .all()
      .map((row: unknown) => row as SqlRecord)
      .map((row: SqlRecord) => ({
        name: String(row.trait_name),
        value: Number(row.value ?? 0),
        confidence: Number(row.confidence ?? 0),
      })) ?? [];

  const recentEpisodes = retrieval.recentEpisodes;

  const sourceFingerprint = hash(
    JSON.stringify({
      canonicalKeys: canonicalFacts.map((item) => item.key),
      repoKeys: repoLearningFacts.map((item) => item.key),
      persona: personaTraits.map((item) => `${item.name}:${item.value.toFixed(2)}`),
      episodes: recentEpisodes.map((item) => item.runId),
      retrievalQueryId: retrieval.queryId,
      retrievalIntent: retrieval.intent,
      retrievalUsedTokens: retrieval.usedTokens,
      retrievalEvidenceRefs: retrieval.evidenceRefs,
    })
  );
  const cacheKey = `mission:${input.repoPath}:${input.task.taskType ?? "maintenance"}:${input.objective}:${retrieval.intent}`;
  let cacheHit = false;
  let cachedSummary: string | undefined;
  if (db) {
    const row = db
      .query(
        `SELECT summary_text
         FROM context_cache
         WHERE cache_key=? AND source_fingerprint=? AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(cacheKey, sourceFingerprint, nowIso()) as SqlRecord | null;
    if (row?.summary_text) {
      cacheHit = true;
      cachedSummary = String(row.summary_text);
    } else {
      const summary = JSON.stringify({
        canonical: canonicalFacts.slice(0, 8).map((item) => item.key),
        repo: repoLearningFacts.slice(0, 8).map((item) => item.key),
        retrievalQueryId: retrieval.queryId,
        retrievalIntent: retrieval.intent,
        retrievalTokens: retrieval.usedTokens,
        evidenceRefs: retrieval.evidenceRefs.slice(0, 20),
        personaTop: personaTraits.slice(0, 4),
      });
      db.query(
        `INSERT INTO context_cache
         (id, cache_key, summary_text, source_fingerprint, token_size, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', '+6 hour'), ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           summary_text=excluded.summary_text,
           source_fingerprint=excluded.source_fingerprint,
           token_size=excluded.token_size,
           expires_at=excluded.expires_at,
           created_at=excluded.created_at`
      ).run(crypto.randomUUID(), cacheKey, summary, sourceFingerprint, Math.ceil(summary.length / 4), nowIso());
    }
  }

  return {
    missionId: crypto.randomUUID(),
    runId: input.task.runId,
    repoPath: input.repoPath,
    objective: input.objective,
    taskType: input.task.taskType ?? "maintenance",
    constraints: {
      mode: "draft_only",
      mustUseBranchPrefix: "codex/",
      maxFilesChanged: 8,
      maxLocChanged: 250,
      denyPaths: ["auth", "billing", "secrets", "migrations", "deploy", "infra", "terraform", "k8s", "helm"],
      requiredChecks: ["lint", "test"],
    },
    tokenEnvelope: input.tokenEnvelope,
    cache: {
      hit: cacheHit,
      key: cacheKey,
      sourceFingerprint,
    },
    context: {
      canonicalFacts: cacheHit ? canonicalFacts.slice(0, 10) : canonicalFacts,
      repoLearningFacts: cacheHit ? repoLearningFacts.slice(0, 10) : repoLearningFacts,
      personaTraits,
      recentEpisodes,
      retrieval: {
        queryId: retrieval.queryId,
        intent: retrieval.intent,
        usedTokens: retrieval.usedTokens,
        budgetTokens: retrieval.budgetTokens,
        cacheHit: retrieval.cacheHit,
        evidenceRefs: retrieval.evidenceRefs,
      },
      evidenceSnippets: retrieval.snippets,
      cachedSummary,
    },
  };
};

export const renderMissionPrompt = (pack: MissionPack, objectiveDetails: string): string => {
  return [
    "You are an autonomous coding worker operating under strict policy.",
    `Mission id: ${pack.missionId}`,
    `Run id: ${pack.runId}`,
    `Repository: ${pack.repoPath}`,
    `Objective: ${pack.objective}`,
    `Task type: ${pack.taskType}`,
    "",
    "Hard constraints:",
    `- Mode: ${pack.constraints.mode}`,
    `- Branch prefix: ${pack.constraints.mustUseBranchPrefix}`,
    `- Max files changed: ${pack.constraints.maxFilesChanged}`,
    `- Max LOC changed: ${pack.constraints.maxLocChanged}`,
    `- Deny paths: ${pack.constraints.denyPaths.join(", ")}`,
    `- Required checks: ${pack.constraints.requiredChecks.join(", ")}`,
    "",
    "Token envelope:",
    `- Domain: ${pack.tokenEnvelope.domain}`,
    `- Max input tokens: ${pack.tokenEnvelope.maxInputTokens}`,
    `- Max output tokens: ${pack.tokenEnvelope.maxOutputTokens}`,
    `- Economy mode: ${pack.tokenEnvelope.economyMode ? "on" : "off"}`,
    "",
    "Objective details:",
    objectiveDetails,
    "",
    "Context snapshot (JSON):",
    JSON.stringify(pack.context),
  ].join("\n");
};
