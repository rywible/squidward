import { createHash } from "node:crypto";
import type { Database } from "@squidward/db";

import type { CodexMemoryProposal } from "./codex-output";

const nowIso = (): string => new Date().toISOString();

export interface MemoryCommitResult {
  accepted: number;
  rejected: number;
  pending: number;
  results: Array<{
    key: string;
    layer: string;
    status: "accepted" | "rejected" | "pending_owner";
    reason: string;
  }>;
}

const stableString = (value: unknown): string => JSON.stringify(value ?? {});
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export class MemoryGovernor {
  constructor(private readonly db?: Database) {}

  commit(runId: string, proposals: CodexMemoryProposal[], source: string): MemoryCommitResult {
    const result: MemoryCommitResult = {
      accepted: 0,
      rejected: 0,
      pending: 0,
      results: [],
    };

    if (!this.db || proposals.length === 0) {
      return result;
    }

    const ordered = [...proposals]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 16);
    for (const proposal of ordered) {
      const routed = this.route(proposal);
      if (routed.status !== "accepted") {
        if (routed.status === "rejected") result.rejected += 1;
        if (routed.status === "pending_owner") result.pending += 1;
        result.results.push({
          key: proposal.key,
          layer: proposal.layerHint,
          status: routed.status,
          reason: routed.reason,
        });
        continue;
      }

      if (proposal.layerHint === "working") {
        // Working memory remains ephemeral; we log it as episode context only.
        this.db
          .query(
            `INSERT INTO memory_episodes
             (id, run_id, trigger_type, context_json, actions_json, outcome_json, created_at)
             VALUES (?, ?, 'working_memory', ?, '[]', '{}', ?)`
          )
          .run(crypto.randomUUID(), runId, stableString({ key: proposal.key, value: proposal.value }), nowIso());
      } else {
        this.upsertFact(proposal, source);
      }

      result.accepted += 1;
      result.results.push({
        key: proposal.key,
        layer: proposal.layerHint,
        status: "accepted",
        reason: "committed",
      });
    }

    return result;
  }

  private route(proposal: CodexMemoryProposal): { status: "accepted" | "rejected" | "pending_owner"; reason: string } {
    if (!proposal.key || proposal.key.trim().length < 3) {
      return { status: "rejected", reason: "invalid_key" };
    }
    if (proposal.citations.length === 0 && proposal.layerHint !== "working") {
      return { status: "rejected", reason: "missing_citations" };
    }
    if (proposal.confidence < 0.5) {
      return { status: "pending_owner", reason: "low_confidence" };
    }
    if (proposal.layerHint === "canonical" && proposal.confidence < 0.7) {
      return { status: "pending_owner", reason: "canonical_needs_more_confidence" };
    }
    if (proposal.layerHint === "policy" && proposal.confidence < 0.75) {
      return { status: "pending_owner", reason: "policy_needs_more_confidence" };
    }
    return { status: "accepted", reason: "gate_passed" };
  }

  private upsertFact(proposal: CodexMemoryProposal, source: string): void {
    if (!this.db) return;
    const namespace = proposal.layerHint === "policy" ? "policy" : "canonical";
    const now = nowIso();
    const factId = `fact_${sha256(`${namespace}:${proposal.key}`).slice(0, 20)}`;
    const existing = this.db
      .query(`SELECT id, fact_value_json FROM memory_facts WHERE id=? LIMIT 1`)
      .get(factId) as { id: string; fact_value_json: string } | null;
    const incomingValue = stableString(proposal.value);
    let normalizedExisting: string | null = null;
    if (existing?.fact_value_json) {
      try {
        normalizedExisting = stableString(JSON.parse(existing.fact_value_json));
      } catch {
        normalizedExisting = existing.fact_value_json;
      }
    }

    if (normalizedExisting && normalizedExisting === incomingValue) {
      return;
    }

    this.db
      .query(
        `INSERT INTO memory_facts
         (id, namespace, fact_key, fact_value_json, state, confidence, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fact_value_json=excluded.fact_value_json,
           confidence=excluded.confidence,
           source=excluded.source,
           updated_at=excluded.updated_at`
      )
      .run(
        factId,
        namespace,
        proposal.key,
        incomingValue,
        proposal.confidence,
        source,
        now,
        now
      );

    const latestVersion = this.db
      .query(
        `SELECT COALESCE(MAX(version), 0) AS version
         FROM memory_fact_versions
         WHERE fact_id=?`
      )
      .get(factId) as { version: number };
    const nextVersion = Number(latestVersion.version ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO memory_fact_versions
         (id, fact_id, version, value_json, reason, supersedes_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        factId,
        nextVersion,
        incomingValue,
        proposal.type,
        nextVersion > 1 ? nextVersion - 1 : null,
        now
      );

    for (const citation of proposal.citations) {
      const alreadyLinked = this.db
        .query(`SELECT id FROM memory_evidence_links WHERE fact_id=? AND source_ref=? LIMIT 1`)
        .get(factId, citation) as { id?: string } | null;
      if (alreadyLinked?.id) {
        continue;
      }
      this.db
        .query(
          `INSERT INTO memory_evidence_links
           (id, fact_id, source_type, source_ref, excerpt_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          factId,
          citation.includes(":") ? citation.split(":")[0] : "artifact",
          citation,
          sha256(citation).slice(0, 16),
          now
        );
    }

    if (existing) {
      return;
    }
  }
}
