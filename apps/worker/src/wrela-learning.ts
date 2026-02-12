import type { Database } from "@squidward/db";

type SqlRecord = Record<string, unknown>;

const nowIso = (): string => new Date().toISOString();

export class WrelaLearningService {
  constructor(private readonly db?: Database, private readonly repoPath?: string) {}

  ingestRun(runId: string, outcome: "success" | "failed", objective: string): void {
    if (!this.db || !this.repoPath) return;
    const rows = this.db
      .query(
        `SELECT command, exit_code, started_at, finished_at
         FROM command_audit
         WHERE run_id=?
         ORDER BY started_at DESC
         LIMIT 50`
      )
      .all(runId) as SqlRecord[];

    for (const row of rows) {
      const command = String(row.command ?? "");
      const intent = this.inferIntent(command, objective);
      const exitCode = Number(row.exit_code ?? 1);
      const success = exitCode === 0;
      const durationMs = this.durationMs(row.started_at, row.finished_at);
      const id = `playbook_${this.hash(`${this.repoPath}:${intent}:${command}`)}`;

      const existing = this.db
        .query(
          `SELECT success_rate, median_duration_ms
           FROM repo_command_playbooks
           WHERE id=?
           LIMIT 1`
        )
        .get(id) as SqlRecord | null;

      const prevRate = Number(existing?.success_rate ?? 0);
      const nextRate = existing ? Number((prevRate * 0.8 + (success ? 1 : 0) * 0.2).toFixed(4)) : success ? 1 : 0;
      const prevMedian = Number(existing?.median_duration_ms ?? durationMs);
      const nextMedian = existing ? Math.round(prevMedian * 0.8 + durationMs * 0.2) : durationMs;

      this.db
        .query(
          `INSERT INTO repo_command_playbooks
           (id, repo_path, intent, command, success_rate, median_duration_ms, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             success_rate=excluded.success_rate,
             median_duration_ms=excluded.median_duration_ms,
             last_used_at=excluded.last_used_at`
        )
        .run(id, this.repoPath, intent, command, nextRate, nextMedian, nowIso());
    }

    const factType = outcome === "success" ? "workflow_hint" : "failure_mode";
    const factKey = `${factType}:${objective}`;
    const factId = `rf_${this.hash(`${this.repoPath}:${factKey}`)}`;
    const existingFact = this.db
      .query(`SELECT evidence_count FROM repo_learning_facts WHERE id=? LIMIT 1`)
      .get(factId) as SqlRecord | null;
    const evidenceCount = Number(existingFact?.evidence_count ?? 0) + 1;
    const confidence = Math.min(0.95, 0.35 + evidenceCount * 0.08);

    this.db
      .query(
        `INSERT INTO repo_learning_facts
         (id, repo_path, fact_type, fact_key, fact_value_json, confidence, evidence_count, last_validated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fact_value_json=excluded.fact_value_json,
           confidence=excluded.confidence,
           evidence_count=excluded.evidence_count,
           last_validated_at=excluded.last_validated_at,
           updated_at=excluded.updated_at`
      )
      .run(
        factId,
        this.repoPath,
        factType,
        factKey,
        JSON.stringify({ objective, outcome }),
        confidence,
        evidenceCount,
        nowIso(),
        nowIso(),
        nowIso()
      );

    this.db
      .query(
        `INSERT INTO repo_learning_evidence
         (id, fact_id, source_type, source_ref, snippet_hash, created_at)
         VALUES (?, ?, 'command_audit', ?, ?, ?)`
      )
      .run(crypto.randomUUID(), factId, runId, this.hash(runId).slice(0, 16), nowIso());

    this.snapshotCompetence();
  }

  snapshotCompetence(): void {
    if (!this.db || !this.repoPath) return;
    const playbooks = this.db
      .query(
        `SELECT success_rate, median_duration_ms, intent
         FROM repo_command_playbooks
         WHERE repo_path=?
         ORDER BY last_used_at DESC
         LIMIT 200`
      )
      .all(this.repoPath) as SqlRecord[];

    if (playbooks.length === 0) return;
    const avgSuccess = playbooks.reduce((acc, row) => acc + Number(row.success_rate ?? 0), 0) / playbooks.length;
    const avgLatency = playbooks.reduce((acc, row) => acc + Number(row.median_duration_ms ?? 0), 0) / playbooks.length;
    const speedScore = avgLatency <= 0 ? 1 : Math.max(0, Math.min(1, 1_500_000 / Math.max(1_500_000, avgLatency)));
    const total = Number((0.7 * avgSuccess + 0.3 * speedScore).toFixed(4));

    this.db
      .query(
        `INSERT INTO repo_competence_snapshots
         (id, repo_path, score_total, subscores_json, top_risks_json, top_strengths_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        this.repoPath,
        total,
        JSON.stringify({ avgSuccess, speedScore }),
        JSON.stringify(playbooks.filter((row) => Number(row.success_rate ?? 0) < 0.5).slice(0, 5).map((row) => row.intent)),
        JSON.stringify(playbooks.filter((row) => Number(row.success_rate ?? 0) >= 0.8).slice(0, 5).map((row) => row.intent)),
        nowIso()
      );
  }

  private inferIntent(command: string, objective: string): string {
    const normalized = `${command} ${objective}`.toLowerCase();
    if (normalized.includes("perf")) return "perf";
    if (normalized.includes("test")) return "test";
    if (normalized.includes("build") || normalized.includes("compile")) return "build";
    if (normalized.includes("release") || normalized.includes("deploy")) return "release";
    return "debug";
  }

  private durationMs(started: unknown, finished: unknown): number {
    const start = typeof started === "string" ? Date.parse(started) : NaN;
    const end = typeof finished === "string" ? Date.parse(finished) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return Math.max(0, Math.round(end - start));
  }

  private hash(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i += 1) {
      h = (h << 5) - h + input.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36);
  }
}
