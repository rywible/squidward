import { buildHash64Embedding, tokenizeRetrievalText, type Database } from "@squidward/db";

const nowIso = (): string => new Date().toISOString();

type SqlRecord = Record<string, unknown>;

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const upsertDoc = (db: Database, input: {
  id: string;
  docType: string;
  sourceRef: string;
  repoPath: string;
  title: string;
  content: string;
  metadataJson: string;
  updatedAt: string;
}): void => {
  db
    .query(
      `INSERT INTO retrieval_documents
       (id, doc_type, source_ref, repo_path, title, content, metadata_json, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         doc_type=excluded.doc_type,
         source_ref=excluded.source_ref,
         repo_path=excluded.repo_path,
         title=excluded.title,
         content=excluded.content,
         metadata_json=excluded.metadata_json,
         updated_at=excluded.updated_at`
    )
    .run(
      input.id,
      input.docType,
      input.sourceRef,
      input.repoPath,
      input.title,
      input.content,
      input.metadataJson,
      input.updatedAt,
      input.updatedAt
    );

  db
    .query(
      `INSERT INTO retrieval_embeddings
       (id, document_id, embedding, model, created_at)
       VALUES (?, ?, ?, 'hash64', ?)
       ON CONFLICT(document_id) DO UPDATE SET
         embedding=excluded.embedding,
         model=excluded.model,
         created_at=excluded.created_at`
    )
    .run(crypto.randomUUID(), input.id, JSON.stringify(buildHash64Embedding(`${input.title}\n${input.content}`)), input.updatedAt);
};

const upsertFromCanonicalFacts = (db: Database, repoPath: string): void => {
  const rows = db
    .query(
      `SELECT id, namespace, fact_key, fact_value_json, state, source, updated_at
       FROM memory_facts
       WHERE state='active'
       ORDER BY updated_at DESC
       LIMIT 300`
    )
    .all() as SqlRecord[];

  for (const row of rows) {
    const factId = String(row.id);
    const key = String(row.fact_key);
    const value = parseJson<Record<string, unknown>>(row.fact_value_json, {});
    const title = `fact:${key}`;
    const content = JSON.stringify(value);
    upsertDoc(db, {
      id: `mf:${factId}`,
      docType: "canonical",
      sourceRef: `memory_facts:${factId}`,
      repoPath,
      title,
      content,
      metadataJson: JSON.stringify({
        namespace: String(row.namespace),
        state: String(row.state),
        source: String(row.source),
      }),
      updatedAt: String(row.updated_at),
    });
  }
};

const upsertFromRepoLearning = (db: Database, repoPath: string): void => {
  const rows = db
    .query(
      `SELECT id, fact_type, fact_key, fact_value_json, confidence, evidence_count, updated_at
       FROM repo_learning_facts
       WHERE repo_path=?
       ORDER BY updated_at DESC
       LIMIT 300`
    )
    .all(repoPath) as SqlRecord[];

  for (const row of rows) {
    const factId = String(row.id);
    const title = `repo:${String(row.fact_type)}:${String(row.fact_key)}`;
    const content = JSON.stringify(parseJson<Record<string, unknown>>(row.fact_value_json, {}));
    upsertDoc(db, {
      id: `rl:${factId}`,
      docType: "repo_learning",
      sourceRef: `repo_learning_facts:${factId}`,
      repoPath,
      title,
      content,
      metadataJson: JSON.stringify({
        confidence: Number(row.confidence ?? 0),
        evidenceCount: Number(row.evidence_count ?? 0),
      }),
      updatedAt: String(row.updated_at),
    });
  }
};

const upsertFromEpisodes = (db: Database, repoPath: string): void => {
  const rows = db
    .query(
      `SELECT me.id, me.run_id, me.trigger_type, me.created_at, mes.summary_md
       FROM memory_episodes me
       LEFT JOIN memory_episode_summaries mes ON mes.episode_id = me.id
       ORDER BY me.created_at DESC
       LIMIT 200`
    )
    .all() as SqlRecord[];

  for (const row of rows) {
    const episodeId = String(row.id);
    const summary = row.summary_md ? String(row.summary_md) : `Episode ${String(row.run_id)} (${String(row.trigger_type)})`;
    upsertDoc(db, {
      id: `ep:${episodeId}`,
      docType: "episodic",
      sourceRef: `memory_episodes:${episodeId}`,
      repoPath,
      title: `episode:${String(row.run_id)}`,
      content: summary,
      metadataJson: JSON.stringify({ triggerType: String(row.trigger_type) }),
      updatedAt: String(row.created_at),
    });
  }
};

const upsertFromCommandAudit = (db: Database, repoPath: string): void => {
  const rows = db
    .query(
      `SELECT id, run_id, command, cwd, exit_code, started_at
       FROM command_audit
       ORDER BY started_at DESC
       LIMIT 300`
    )
    .all() as SqlRecord[];

  for (const row of rows) {
    const id = String(row.id);
    const content = `command=${String(row.command)} cwd=${String(row.cwd)} exit=${String(row.exit_code ?? "")}`;
    upsertDoc(db, {
      id: `ca:${id}`,
      docType: "evidence",
      sourceRef: `command_audit:${id}`,
      repoPath,
      title: `audit:${String(row.run_id ?? "")}`,
      content,
      metadataJson: JSON.stringify({
        exitCode: Number(row.exit_code ?? -1),
      }),
      updatedAt: String(row.started_at),
    });
  }
};

export const reindexRetrievalDocuments = (db: Database, repoPath: string): { indexed: number } => {
  db
    .query(
      `DELETE FROM retrieval_embeddings
       WHERE document_id IN (SELECT id FROM retrieval_documents WHERE repo_path=?)`
    )
    .run(repoPath);
  db.query(`DELETE FROM retrieval_documents WHERE repo_path=?`).run(repoPath);

  upsertFromCanonicalFacts(db, repoPath);
  upsertFromRepoLearning(db, repoPath);
  upsertFromEpisodes(db, repoPath);
  upsertFromCommandAudit(db, repoPath);

  const countRow = db
    .query(`SELECT COUNT(*) AS count FROM retrieval_documents WHERE repo_path=?`)
    .get(repoPath) as SqlRecord;
  const indexed = Number(countRow.count ?? 0);

  return { indexed };
};

export const lexicalOverlap = (query: string, text: string): number => {
  const q = new Set(tokenizeRetrievalText(query));
  if (q.size === 0) return 0;
  const t = new Set(tokenizeRetrievalText(text));
  let hits = 0;
  for (const token of q) {
    if (t.has(token)) hits += 1;
  }
  return hits / q.size;
};

export const semanticSimilarity = (query: string, embeddingJson: string): number => {
  const queryEmbedding = buildHash64Embedding(query);
  const docEmbedding = parseJson<number[]>(embeddingJson, []);
  if (docEmbedding.length !== queryEmbedding.length || docEmbedding.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < docEmbedding.length; i += 1) {
    dot += queryEmbedding[i]! * docEmbedding[i]!;
  }
  if (dot < 0) return 0;
  if (dot > 1) return 1;
  return Number(dot.toFixed(6));
};
