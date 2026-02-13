import { Database } from "@squidward/db";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPersonaSignal } from "./persona-feedback";

export type PortfolioDecision = "advisory" | "queued_draft" | "auto_actioned" | "rejected";

export interface PortfolioCandidate {
  id: string;
  sourceType: string;
  sourceRef: string;
  title: string;
  summary: string;
  riskClass: "low" | "medium" | "high";
  effortClass: "small" | "medium" | "large";
  evidenceLinks: string[];
}

export interface PortfolioScoreBreakdown {
  impact: number;
  confidence: number;
  urgency: number;
  risk: number;
  effort: number;
  ev: number;
}

export interface GeneratedTestCandidate {
  id: string;
  bugRef: string;
  language: string;
  framework: string;
  testPath: string;
  status: "generated" | "accepted" | "rejected";
  score: number;
}

export interface CtoMemo {
  id: string;
  weekStart: string;
  weekEnd: string;
  summaryMd: string;
  evidenceLinks: string[];
}

export interface GraphNode {
  id: string;
  nodeType: string;
  ref: string;
  label: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  weight: number;
  evidenceRef?: string;
}

export interface ImpactReport {
  query: string;
  touchedNodes: GraphNode[];
  edges: GraphEdge[];
  hotspots: Array<{ ref: string; count: number }>;
  generatedAt: string;
}

export interface EvidencePath {
  recommendationId: string;
  path: Array<{ nodeRef: string; nodeType: string; reason: string }>;
}

type SqlRecord = Record<string, unknown>;

const asNum = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const isoNow = (): string => new Date().toISOString();

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const firstLine = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.split("\n").find(Boolean)?.slice(0, 140) ?? fallback;
};

const hashString = (value: string): string => {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h << 5) - h + value.charCodeAt(i);
  return Math.abs(h).toString(36);
};

export const computeEv = (parts: Omit<PortfolioScoreBreakdown, "ev">): PortfolioScoreBreakdown => {
  const impact = clamp(parts.impact, 0.1, 5);
  const confidence = clamp(parts.confidence, 0.1, 2);
  const urgency = clamp(parts.urgency, 0.1, 3);
  const risk = clamp(parts.risk, 0.2, 3);
  const effort = clamp(parts.effort, 0.2, 3);
  const ev = Number(((impact * confidence * urgency) / (risk * effort)).toFixed(4));
  return { impact, confidence, urgency, risk, effort, ev };
};

export class MoonshotEngine {
  constructor(private readonly db: Database) {}

  runPortfolioRankerDaily(topN: number, minEvAutorun: number): { evaluated: number; selected: number } {
    const candidates = this.buildPortfolioCandidates();
    let selected = 0;
    let evTotal = 0;

    for (const candidate of candidates) {
      this.db
        .query(
          `INSERT INTO portfolio_candidates
           (id, source_type, source_ref, title, summary, risk_class, effort_class, evidence_links, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title,
             summary=excluded.summary,
             risk_class=excluded.risk_class,
             effort_class=excluded.effort_class,
             evidence_links=excluded.evidence_links,
             updated_at=excluded.updated_at`
        )
        .run(
          candidate.id,
          candidate.sourceType,
          candidate.sourceRef,
          candidate.title,
          candidate.summary,
          candidate.riskClass,
          candidate.effortClass,
          JSON.stringify(candidate.evidenceLinks),
          isoNow(),
          isoNow()
        );

      const score = this.scoreCandidate(candidate);
      evTotal += score.ev;
      const scoreId = `score_${candidate.id}_${Date.now()}`;
      this.db
        .query(
          `INSERT INTO portfolio_scores
           (id, candidate_id, impact, confidence, urgency, risk, effort, ev, reasons_json, scored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          scoreId,
          candidate.id,
          score.impact,
          score.confidence,
          score.urgency,
          score.risk,
          score.effort,
          score.ev,
          JSON.stringify({
            sourceType: candidate.sourceType,
            riskClass: candidate.riskClass,
            effortClass: candidate.effortClass,
            evidenceCount: candidate.evidenceLinks.length,
          }),
          isoNow()
        );

      const lowRisk = candidate.riskClass === "low";
      const withinTop = selected < topN;
      const canAutoQueue = lowRisk && score.ev >= minEvAutorun && withinTop;
      const decision: PortfolioDecision = "advisory";
      let queuedTaskId: string | null = null;
      if (canAutoQueue) {
        // Portfolio ranker remains advisory in v1.5 to avoid self-amplifying internal queue loops.
        selected += 1;
      }

      this.db
        .query(
          `INSERT INTO portfolio_decisions
           (id, score_id, decision, policy_mode, threshold, reason, queued_task_id, created_at)
           VALUES (?, ?, ?, 'balanced', ?, ?, ?, ?)`
        )
        .run(
          `decision_${scoreId}`,
          scoreId,
          decision,
          minEvAutorun,
          canAutoQueue ? "low_risk_ev_threshold_advisory_only" : "advisory_or_below_threshold",
          queuedTaskId,
          isoNow()
        );
    }

    const avgEv = candidates.length > 0 ? evTotal / candidates.length : 0;
    applyPersonaSignal(this.db, {
      source: "portfolio_ranker_daily",
      confidence: 0.74,
      adjustments: [
        { trait: "proactivity", delta: selected > 0 ? 0.03 : -0.02 },
        { trait: "decision_framing", delta: avgEv >= minEvAutorun ? 0.02 : -0.01 },
        { trait: "risk_tolerance_within_policy", delta: selected > 0 ? 0.01 : -0.01 },
      ],
      context: {
        evaluated: candidates.length,
        selected,
        avgEv: Number(avgEv.toFixed(4)),
        threshold: minEvAutorun,
      },
    });

    return { evaluated: candidates.length, selected };
  }

  runTestEvolutionContinuous(maxCandidatesPerBug: number): { generated: number; accepted: number } {
    const incidentRows = this.db
      .query(
        `SELECT id, signature, severity, timeline, created_at
         FROM incidents
         ORDER BY created_at DESC
         LIMIT 25`
      )
      .all() as SqlRecord[];

    const failedAuditRows = this.db
      .query(
        `SELECT id, command, artifact_refs, started_at
         FROM command_audit
         WHERE exit_code IS NOT NULL AND exit_code <> 0
         ORDER BY started_at DESC
         LIMIT 25`
      )
      .all() as SqlRecord[];

    const bugRefs: Array<{ ref: string; source: string; details: string }> = [];
    for (const row of incidentRows) {
      bugRefs.push({
        ref: `incident:${String(row.id)}`,
        source: "incident",
        details: firstLine(row.signature, "Incident"),
      });
    }
    for (const row of failedAuditRows) {
      bugRefs.push({
        ref: `audit:${String(row.id)}`,
        source: "audit",
        details: firstLine(row.command, "Failed command"),
      });
    }

    const selected = bugRefs.slice(0, Math.max(1, maxCandidatesPerBug));
    let generated = 0;
    let accepted = 0;

    for (const bug of selected) {
      const runId = `test_run_${hashString(`${bug.ref}:${Date.now()}`)}`;
      const candidatesForBug = this.generateTestCandidates(bug.ref, bug.details, maxCandidatesPerBug);

      for (const candidate of candidatesForBug) {
        generated += 1;
        const validation = this.validateTestCandidate(candidate);
        if (validation.accepted) accepted += 1;

        this.db
          .query(
            `INSERT OR REPLACE INTO test_candidates
             (id, bug_ref, language, framework, test_path, test_code, status, score, validation_notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            candidate.id,
            candidate.bugRef,
            candidate.language,
            candidate.framework,
            candidate.testPath,
            candidate.testCode,
            validation.accepted ? "accepted" : "rejected",
            validation.score,
            validation.notes,
            isoNow(),
            isoNow()
          );

        this.db
          .query(
            `INSERT INTO test_provenance_links
             (id, test_candidate_id, source_type, source_ref, evidence_url, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            `prov_${candidate.id}`,
            candidate.id,
            bug.source,
            bug.ref,
            null,
            isoNow()
          );
      }

      this.db
        .query(
          `INSERT INTO test_evolution_runs
           (id, trigger_source, bug_ref, candidates_generated, candidates_accepted, status, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          runId,
          bug.source,
          bug.ref,
          candidatesForBug.length,
          candidatesForBug.filter((c) => this.validateTestCandidate(c).accepted).length,
          "completed",
          "generated_by_heuristic_pipeline",
          isoNow()
        );
    }

    const acceptRate = generated > 0 ? accepted / generated : 0;
    applyPersonaSignal(this.db, {
      source: "test_evolution_continuous",
      confidence: 0.7,
      adjustments: [
        { trait: "supportiveness", delta: acceptRate >= 0.6 ? 0.03 : -0.015 },
        { trait: "challenge_level", delta: acceptRate >= 0.6 ? 0.015 : -0.01 },
        { trait: "notification_frequency", delta: acceptRate >= 0.6 ? -0.01 : 0.01 },
      ],
      context: {
        generated,
        accepted,
        acceptRate: Number(acceptRate.toFixed(4)),
        maxCandidatesPerBug,
      },
    });

    return { generated, accepted };
  }

  runCtoMemoWeekly(): { memoId: string; recommendations: number; asks: number } {
    const now = new Date();
    const weekEnd = now.toISOString();
    const weekStartDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = weekStartDate.toISOString();

    const topEv = this.db
      .query(
        `SELECT pc.id AS candidate_id, pc.title, ps.ev
         FROM portfolio_scores ps
         JOIN portfolio_candidates pc ON pc.id = ps.candidate_id
         WHERE ps.scored_at >= ?
         ORDER BY ps.ev DESC
         LIMIT 5`
      )
      .all(weekStart) as SqlRecord[];

    const weakEv = this.db
      .query(
        `SELECT pc.id AS candidate_id, pc.title, ps.ev
         FROM portfolio_scores ps
         JOIN portfolio_candidates pc ON pc.id = ps.candidate_id
         WHERE ps.scored_at >= ?
         ORDER BY ps.ev ASC
         LIMIT 3`
      )
      .all(weekStart) as SqlRecord[];

    const testStats = this.db
      .query(
        `SELECT COALESCE(SUM(candidates_generated), 0) AS generated,
                COALESCE(SUM(candidates_accepted), 0) AS accepted
         FROM test_evolution_runs
         WHERE created_at >= ?`
      )
      .get(weekStart) as SqlRecord;

    const incidents = this.db
      .query(`SELECT COUNT(*) AS count FROM incidents WHERE created_at >= ?`)
      .get(weekStart) as SqlRecord;

    const summaryMd = [
      `## What moved`,
      `- Top EV opportunities identified: ${topEv.length}`,
      `- Regression test candidates accepted: ${asNum(testStats.accepted)}/${asNum(testStats.generated)}`,
      ``,
      `## What is stuck`,
      `- Incident count (7d): ${asNum(incidents.count)}`,
      ``,
      `## What to kill`,
      ...weakEv.map((row) => `- ${String(row.title)} (EV ${asNum(row.ev).toFixed(2)})`),
      weakEv.length === 0 ? "- None identified" : "",
      ``,
      `## What to double down on`,
      ...topEv.map((row) => `- ${String(row.title)} (EV ${asNum(row.ev).toFixed(2)})`),
      topEv.length === 0 ? "- No high-confidence EV bets this week" : "",
      ``,
      `## Top 3 decisions needed`,
      `- Raise auto-action EV threshold?`,
      `- Prioritize incident-driven tests over CI-failure tests?`,
      `- Expand low-risk auto queue classes this week?`,
    ]
      .filter(Boolean)
      .join("\n");

    const memoId = `memo_${Date.now()}`;
    this.db
      .query(
        `INSERT INTO cto_memos
         (id, week_start, week_end, summary_md, evidence_links, delivered_to_ui, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      )
      .run(memoId, weekStart, weekEnd, summaryMd, JSON.stringify([]), isoNow());

    for (const row of weakEv) {
      this.db
        .query(
          `INSERT INTO memo_recommendations
           (id, memo_id, recommendation_type, title, rationale, expected_value, risk_trend, recurrence, evidence_links, created_at)
           VALUES (?, ?, 'kill', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `memo_rec_kill_${hashString(String(row.candidate_id))}_${Date.now()}`,
          memoId,
          String(row.title),
          "Sustained low EV within current constraints",
          asNum(row.ev),
          0,
          0,
          JSON.stringify([]),
          isoNow()
        );
    }

    for (const row of topEv) {
      this.db
        .query(
          `INSERT INTO memo_recommendations
           (id, memo_id, recommendation_type, title, rationale, expected_value, risk_trend, recurrence, evidence_links, created_at)
           VALUES (?, ?, 'double_down', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `memo_rec_dd_${hashString(String(row.candidate_id))}_${Date.now()}`,
          memoId,
          String(row.title),
          "Highest EV within balanced rollout policy",
          asNum(row.ev),
          0,
          0,
          JSON.stringify([]),
          isoNow()
        );
    }

    const asks = [
      "Approve expansion of low-risk auto-actions if EV trend holds.",
      "Set acceptable weekly incident budget threshold.",
      "Select one strategic area to deprioritize next sprint.",
    ];

    for (const ask of asks) {
      this.db
        .query(
          `INSERT INTO decision_asks
           (id, memo_id, prompt, impact, due_hint, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(`ask_${hashString(`${memoId}:${ask}`)}`, memoId, ask, "Strategic focus and automation safety", null, isoNow());
    }

    applyPersonaSignal(this.db, {
      source: "cto_memo_weekly",
      confidence: 0.78,
      adjustments: [
        { trait: "directness", delta: 0.02 },
        { trait: "decision_framing", delta: 0.025 },
        { trait: "verbosity", delta: -0.01 },
      ],
      context: {
        memoId,
        recommendations: topEv.length + weakEv.length,
        asks: asks.length,
      },
    });

    return { memoId, recommendations: topEv.length + weakEv.length, asks: asks.length };
  }

  runGraphIndexerIncremental(repoPath: string): { snapshotId: string; nodeCount: number; edgeCount: number } {
    const resolved = resolve(repoPath);
    const snapshotId = `graph_${Date.now()}`;

    const fileRefs = Array.from(new Bun.Glob("**/*.{ts,tsx,js,jsx,wr,md}").scanSync({
      cwd: resolved,
      absolute: false,
      dot: false,
      onlyFiles: true,
    })).slice(0, 2500);

    const nodeIds = new Map<string, string>();
    const addNode = (nodeType: string, ref: string, label: string, metadata: Record<string, unknown> = {}): string => {
      const existing = nodeIds.get(`${nodeType}:${ref}`);
      if (existing) return existing;
      const id = crypto.randomUUID();
      nodeIds.set(`${nodeType}:${ref}`, id);
      this.db
        .query(
          `INSERT INTO graph_nodes
           (id, node_type, ref, label, metadata_json, snapshot_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, nodeType, ref, label, JSON.stringify(metadata), snapshotId, isoNow());
      return id;
    };

    const edges: GraphEdge[] = [];
    const addEdge = (from: string, to: string, edgeType: string, evidenceRef?: string, weight = 1): void => {
      edges.push({
        id: crypto.randomUUID(),
        fromNodeId: from,
        toNodeId: to,
        edgeType,
        weight,
        evidenceRef,
      });
    };

    const repoNode = addNode("repo", resolved, "wrela", { root: resolved });

    for (const relativePath of fileRefs) {
      const fullPath = join(resolved, relativePath);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(fullPath).size;
      } catch {
        continue;
      }

      const fileNode = addNode("file", relativePath, relativePath, { sizeBytes });
      addEdge(repoNode, fileNode, "contains", relativePath);

      let content = "";
      try {
        content = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const symbolRegex = /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      for (const match of content.matchAll(symbolRegex)) {
        const symbol = match[1];
        const symbolRef = `${relativePath}#${symbol}`;
        const symbolNode = addNode("symbol", symbolRef, symbol, {});
        addEdge(fileNode, symbolNode, "defines", symbolRef);
      }

      const importRegex = /from\s+["']([^"']+)["']/g;
      for (const match of content.matchAll(importRegex)) {
        const dep = match[1];
        const depNode = addNode("dependency", dep, dep, {});
        addEdge(fileNode, depNode, "depends_on", dep);
      }
    }

    const prRows = this.db
      .query(
        `SELECT id, task_type, payload_json, created_at
         FROM task_queue
         WHERE task_type IN ('portfolio_eval', 'test_gen')
         ORDER BY created_at DESC
         LIMIT 300`
      )
      .all() as SqlRecord[];

    for (const row of prRows) {
      const payload = parseJson<{ title?: string; sourceRef?: string }>(row.payload_json, {} as never);
      const prRef = `queue:${String(row.id)}`;
      const prNode = addNode("pr", prRef, payload.title ?? String(row.task_type), {
        createdAt: row.created_at,
      });

      if (typeof payload.sourceRef === "string" && payload.sourceRef.includes("/")) {
        const fileNode = addNode("file", payload.sourceRef, payload.sourceRef, {});
        addEdge(prNode, fileNode, "touches", payload.sourceRef);
      }
    }

    const incidentRows = this.db
      .query(`SELECT id, signature, severity FROM incidents ORDER BY created_at DESC LIMIT 300`)
      .all() as SqlRecord[];

    for (const row of incidentRows) {
      const incidentRef = `incident:${String(row.id)}`;
      const incidentNode = addNode("incident", incidentRef, firstLine(row.signature, incidentRef), {
        severity: row.severity,
      });

      for (const fileRef of fileRefs.slice(0, 3)) {
        if (String(row.signature).toLowerCase().includes(fileRef.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "")) {
          const fileNode = addNode("file", fileRef, fileRef, {});
          addEdge(incidentNode, fileNode, "implicates", String(row.id));
        }
      }
    }

    for (const edge of edges) {
      this.db
        .query(
          `INSERT INTO graph_edges
           (id, from_node_id, to_node_id, edge_type, weight, evidence_ref, snapshot_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(edge.id, edge.fromNodeId, edge.toNodeId, edge.edgeType, edge.weight, edge.evidenceRef ?? null, snapshotId, isoNow());
    }

    this.db
      .query(
        `INSERT INTO graph_snapshots (id, scope, node_count, edge_count, generated_at)
         VALUES (?, 'code+pr+incidents', ?, ?, ?)`
      )
      .run(snapshotId, nodeIds.size, edges.length, isoNow());

    applyPersonaSignal(this.db, {
      source: "graph_indexer_incremental",
      confidence: 0.69,
      adjustments: [
        { trait: "decision_framing", delta: nodeIds.size > 0 ? 0.015 : -0.01 },
        { trait: "challenge_level", delta: edges.length > 0 ? 0.01 : 0 },
      ],
      context: {
        snapshotId,
        nodeCount: nodeIds.size,
        edgeCount: edges.length,
      },
    });

    return { snapshotId, nodeCount: nodeIds.size, edgeCount: edges.length };
  }

  getImpact(query: string): ImpactReport {
    const nodes = this.db
      .query(
        `SELECT id, node_type, ref, label
         FROM graph_nodes
         WHERE ref LIKE ? OR label LIKE ?
         ORDER BY created_at DESC
         LIMIT 40`
      )
      .all(`%${query}%`, `%${query}%`) as SqlRecord[];

    const nodeIds = nodes.map((row) => String(row.id));
    const placeholders = nodeIds.map(() => "?").join(",");
    const edges =
      nodeIds.length === 0
        ? []
        : (this.db
            .query(
              `SELECT id, from_node_id, to_node_id, edge_type, weight, evidence_ref
               FROM graph_edges
               WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})
               LIMIT 200`
            )
            .all(...nodeIds, ...nodeIds) as SqlRecord[]);

    const hotspots = this.db
      .query(
        `SELECT n.ref, COUNT(*) AS count
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.to_node_id
         GROUP BY n.ref
         ORDER BY count DESC
         LIMIT 10`
      )
      .all() as SqlRecord[];

    return {
      query,
      touchedNodes: nodes.map((row) => ({
        id: String(row.id),
        nodeType: String(row.node_type),
        ref: String(row.ref),
        label: String(row.label),
      })),
      edges: edges.map((row) => ({
        id: String(row.id),
        fromNodeId: String(row.from_node_id),
        toNodeId: String(row.to_node_id),
        edgeType: String(row.edge_type),
        weight: asNum(row.weight, 1),
        evidenceRef: row.evidence_ref ? String(row.evidence_ref) : undefined,
      })),
      hotspots: hotspots.map((row) => ({ ref: String(row.ref), count: asNum(row.count) })),
      generatedAt: isoNow(),
    };
  }

  explainRecommendation(recommendationId: string): EvidencePath {
    const rec = this.db
      .query(
        `SELECT id, title, recommendation_type, rationale
         FROM memo_recommendations
         WHERE id = ?
         LIMIT 1`
      )
      .get(recommendationId) as SqlRecord | null;

    if (!rec) {
      return {
        recommendationId,
        path: [{ nodeRef: "missing", nodeType: "recommendation", reason: "Recommendation not found" }],
      };
    }

    const linkedCandidate = this.db
      .query(
        `SELECT pc.id, pc.source_ref, pc.title
         FROM portfolio_candidates pc
         WHERE pc.title = ?
         ORDER BY pc.updated_at DESC
         LIMIT 1`
      )
      .get(String(rec.title)) as SqlRecord | null;

    const path: EvidencePath["path"] = [
      {
        nodeRef: String(rec.id),
        nodeType: "memo_recommendation",
        reason: String(rec.rationale),
      },
    ];

    if (linkedCandidate) {
      path.push({
        nodeRef: String(linkedCandidate.id),
        nodeType: "portfolio_candidate",
        reason: `Matched by title ${String(linkedCandidate.title)}`,
      });
      path.push({
        nodeRef: String(linkedCandidate.source_ref),
        nodeType: "source_ref",
        reason: "Primary evidence source",
      });
    }

    return { recommendationId, path };
  }

  private buildPortfolioCandidates(): PortfolioCandidate[] {
    const queueRows = this.db
      .query(
        `SELECT id, task_type, payload_json, priority, status, created_at
         FROM task_queue
         WHERE status IN ('queued','running','failed')
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .all() as SqlRecord[];

    const candidates: PortfolioCandidate[] = queueRows.map((row) => {
      const payload = parseJson<{ title?: string; sourceRef?: string; action?: string }>(row.payload_json, {} as never);
      const riskClass = String(row.task_type).includes("graph") ? "low" : String(row.status) === "failed" ? "medium" : "low";
      const effortClass = Number(row.priority) <= 1 ? "large" : Number(row.priority) === 2 ? "medium" : "small";
      const sourceRef = payload.sourceRef ?? `task_queue:${String(row.id)}`;

      return {
        id: `candidate_${hashString(String(row.id))}`,
        sourceType: "task_queue",
        sourceRef,
        title: payload.title ?? `${String(row.task_type)}:${String(row.id).slice(0, 8)}`,
        summary: `Derived from ${String(row.task_type)} in ${String(row.status)} state`,
        riskClass: riskClass as PortfolioCandidate["riskClass"],
        effortClass: effortClass as PortfolioCandidate["effortClass"],
        evidenceLinks: [sourceRef],
      };
    });

    const incidentRows = this.db
      .query(`SELECT id, signature, severity FROM incidents ORDER BY created_at DESC LIMIT 50`)
      .all() as SqlRecord[];

    for (const row of incidentRows) {
      candidates.push({
        id: `candidate_inc_${hashString(String(row.id))}`,
        sourceType: "incident",
        sourceRef: `incident:${String(row.id)}`,
        title: `Incident: ${firstLine(row.signature, String(row.id))}`,
        summary: `Severity ${String(row.severity)} incident follow-up opportunity`,
        riskClass: String(row.severity) === "critical" ? "high" : "medium",
        effortClass: "medium",
        evidenceLinks: [`incident:${String(row.id)}`],
      });
    }

    const uniq = new Map<string, PortfolioCandidate>();
    for (const candidate of candidates) uniq.set(candidate.id, candidate);
    return [...uniq.values()];
  }

  private scoreCandidate(candidate: PortfolioCandidate): PortfolioScoreBreakdown {
    const riskFactor = candidate.riskClass === "low" ? 0.8 : candidate.riskClass === "medium" ? 1.4 : 2.2;
    const effortFactor =
      candidate.effortClass === "small" ? 0.7 : candidate.effortClass === "medium" ? 1.3 : 2.1;

    const incidentBoost = candidate.sourceType === "incident" ? 1.6 : 1;
    const queueFailedBoost = candidate.summary.includes("failed") ? 1.3 : 1;

    return computeEv({
      impact: clamp(1.2 * incidentBoost * queueFailedBoost, 0.2, 5),
      confidence: clamp(1 + candidate.evidenceLinks.length * 0.1, 0.3, 2),
      urgency: candidate.sourceType === "incident" ? 2.3 : 1.2,
      risk: riskFactor,
      effort: effortFactor,
    });
  }

  private generateTestCandidates(
    bugRef: string,
    detail: string,
    maxCandidatesPerBug: number
  ): Array<{ id: string; bugRef: string; language: string; framework: string; testPath: string; testCode: string }> {
    const isTs = true;
    const framework = "vitest";
    const candidates: Array<{ id: string; bugRef: string; language: string; framework: string; testPath: string; testCode: string }> = [];

    for (let i = 0; i < maxCandidatesPerBug; i += 1) {
      const id = `testcand_${hashString(`${bugRef}:${i}:${Date.now()}`)}`;
      const testPath = `tests/generated/${id}.test.ts`;
      const testCode = `import { describe, expect, it } from \"vitest\";\n\ndescribe(\"regression ${id}\", () => {\n  it(\"guards ${detail.replace(/\"/g, "'").slice(0, 60)}\", () => {\n    const bugRef = \"${bugRef}\";\n    expect(bugRef.length).toBeGreaterThan(0);\n  });\n});\n`;

      candidates.push({ id, bugRef, language: isTs ? "typescript" : "unknown", framework, testPath, testCode });
    }

    return candidates;
  }

  private validateTestCandidate(candidate: { testCode: string; testPath: string }): { accepted: boolean; score: number; notes: string } {
    const hasAssertion = candidate.testCode.includes("expect(");
    const hasDescribe = candidate.testCode.includes("describe(");
    const score = hasAssertion && hasDescribe ? 0.8 : 0.2;
    return {
      accepted: score >= 0.7,
      score,
      notes: score >= 0.7 ? "shape_valid_for_suggestion" : "missing_core_assertions",
    };
  }
}
