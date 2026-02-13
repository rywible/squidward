PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  owner TEXT NOT NULL,
  deploy_flow TEXT,
  slo_refs TEXT NOT NULL DEFAULT '[]',
  runbook_refs TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  type TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,
  risk TEXT NOT NULL,
  blocked_by TEXT NOT NULL DEFAULT '[]',
  assigned_to TEXT,
  source TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  state TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  severity TEXT NOT NULL,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  timeline TEXT NOT NULL DEFAULT '[]',
  followups TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  env_fingerprint TEXT NOT NULL,
  source TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  condition TEXT NOT NULL,
  action TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  source TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  objective TEXT NOT NULL,
  actions TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL,
  rollback_flag INTEGER NOT NULL CHECK (rollback_flag IN (0, 1)),
  duration INTEGER NOT NULL,
  source TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  rating INTEGER NOT NULL,
  reason_code TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id)
);

CREATE TABLE IF NOT EXISTS owner_profile (
  owner_id TEXT PRIMARY KEY,
  operating_preferences_json TEXT NOT NULL,
  locked_preferences_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS persona_traits (
  id TEXT PRIMARY KEY,
  trait_name TEXT NOT NULL,
  value REAL NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS persona_snapshots (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  traits_json TEXT NOT NULL,
  policy_bindings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rollback_of INTEGER
);

CREATE TABLE IF NOT EXISTS interaction_events (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  message_type TEXT NOT NULL,
  response_latency INTEGER,
  action_taken TEXT,
  sentiment_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_queries (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  intent TEXT,
  provider_used TEXT NOT NULL,
  cost_units REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  relevance_score REAL,
  FOREIGN KEY (query_id) REFERENCES research_queries(id)
);

CREATE TABLE IF NOT EXISTS provider_budget_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  month TEXT NOT NULL,
  consumed_units REAL NOT NULL,
  cap_units REAL NOT NULL,
  alert_state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_budget_usage_provider_month
ON provider_budget_usage(provider, month);

CREATE TABLE IF NOT EXISTS auth_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS secret_records (
  id TEXT PRIMARY KEY,
  secret_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  cipher_blob TEXT NOT NULL,
  version INTEGER NOT NULL,
  rotated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_validated_at TEXT
);

CREATE TABLE IF NOT EXISTS command_audit (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (run_id) REFERENCES agent_runs(id)
);

-- Additional required runtime tables.
CREATE TABLE IF NOT EXISTS codex_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_ref TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_single_active_session
ON codex_sessions(status)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES codex_sessions(id)
);

CREATE TABLE IF NOT EXISTS worker_state (
  worker_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  heartbeat_at TEXT,
  run_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id)
);

CREATE TABLE IF NOT EXISTS task_queue (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_for TEXT,
  locked_by TEXT,
  locked_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status_priority
ON task_queue(status, priority, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_session_events_session_id_created_at
ON session_events(session_id, created_at);

-- Moonshot v1.5: portfolio allocator.
CREATE TABLE IF NOT EXISTS portfolio_candidates (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  effort_class TEXT NOT NULL,
  evidence_links TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_scores (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  impact REAL NOT NULL,
  confidence REAL NOT NULL,
  urgency REAL NOT NULL,
  risk REAL NOT NULL,
  effort REAL NOT NULL,
  ev REAL NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '{}',
  scored_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (candidate_id) REFERENCES portfolio_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_scores_scored_at
ON portfolio_scores(scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_scores_candidate_scored
ON portfolio_scores(candidate_id, scored_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_decisions (
  id TEXT PRIMARY KEY,
  score_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  policy_mode TEXT NOT NULL,
  threshold REAL NOT NULL,
  reason TEXT NOT NULL,
  queued_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (score_id) REFERENCES portfolio_scores(id),
  FOREIGN KEY (queued_task_id) REFERENCES task_queue(id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_decisions_created_at
ON portfolio_decisions(created_at DESC);

-- Moonshot v1.5: test evolution.
CREATE TABLE IF NOT EXISTS test_candidates (
  id TEXT PRIMARY KEY,
  bug_ref TEXT NOT NULL,
  language TEXT NOT NULL,
  framework TEXT NOT NULL,
  test_path TEXT NOT NULL,
  test_code TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  validation_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_test_candidates_status_created_at
ON test_candidates(status, created_at DESC);

CREATE TABLE IF NOT EXISTS test_evolution_runs (
  id TEXT PRIMARY KEY,
  trigger_source TEXT NOT NULL,
  bug_ref TEXT NOT NULL,
  candidates_generated INTEGER NOT NULL DEFAULT 0,
  candidates_accepted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_provenance_links (
  id TEXT PRIMARY KEY,
  test_candidate_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  evidence_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (test_candidate_id) REFERENCES test_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_test_provenance_candidate
ON test_provenance_links(test_candidate_id);

-- Moonshot v1.5: memo engine.
CREATE TABLE IF NOT EXISTS cto_memos (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  summary_md TEXT NOT NULL,
  evidence_links TEXT NOT NULL DEFAULT '[]',
  delivered_to_ui INTEGER NOT NULL DEFAULT 0 CHECK (delivered_to_ui IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cto_memos_created_at
ON cto_memos(created_at DESC);

CREATE TABLE IF NOT EXISTS memo_recommendations (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL,
  recommendation_type TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  expected_value REAL NOT NULL,
  risk_trend REAL NOT NULL DEFAULT 0,
  recurrence REAL NOT NULL DEFAULT 0,
  evidence_links TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (memo_id) REFERENCES cto_memos(id)
);

CREATE TABLE IF NOT EXISTS decision_asks (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  impact TEXT NOT NULL,
  due_hint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (memo_id) REFERENCES cto_memos(id)
);

-- Moonshot v1.5: architecture memory graph.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  snapshot_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_type_ref_snapshot
ON graph_nodes(node_type, ref, IFNULL(snapshot_id, 'current'));

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  evidence_ref TEXT,
  snapshot_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_node_id) REFERENCES graph_nodes(id),
  FOREIGN KEY (to_node_id) REFERENCES graph_nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from_to
ON graph_edges(from_node_id, to_node_id, edge_type);

CREATE TABLE IF NOT EXISTS graph_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_queries (
  id TEXT PRIMARY KEY,
  query_type TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_size INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Autonomous Perf Scientist (APS)
CREATE TABLE IF NOT EXISTS perf_baselines (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  profile TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  baseline_json_path TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_perf_baselines_created_at
ON perf_baselines(created_at DESC);

CREATE TABLE IF NOT EXISTS perf_experiments (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  branch_name TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_perf_experiments_status_started_at
ON perf_experiments(status, started_at DESC);

CREATE TABLE IF NOT EXISTS perf_candidates (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  change_class TEXT NOT NULL,
  target_paths_json TEXT NOT NULL DEFAULT '[]',
  risk_class TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (experiment_id) REFERENCES perf_experiments(id)
);

CREATE INDEX IF NOT EXISTS idx_perf_candidates_status_updated_at
ON perf_candidates(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS perf_runs (
  id TEXT PRIMARY KEY,
  candidate_id TEXT,
  run_kind TEXT NOT NULL,
  profile TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 1,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  artifact_path TEXT,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (candidate_id) REFERENCES perf_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_perf_runs_candidate_kind
ON perf_runs(candidate_id, run_kind, started_at DESC);

CREATE TABLE IF NOT EXISTS perf_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  runtime_p50_ns REAL,
  runtime_p95_ns REAL,
  runtime_p99_ns REAL,
  compile_throughput_tps REAL,
  allocs_per_request REAL,
  dispatch_hit_ratio REAL,
  cv_pct REAL,
  confidence_pct REAL,
  effect_pct REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES perf_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_perf_metrics_run_id
ON perf_metrics(run_id);

CREATE TABLE IF NOT EXISTS perf_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (candidate_id) REFERENCES perf_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_perf_decisions_created_at
ON perf_decisions(created_at DESC);

CREATE TABLE IF NOT EXISTS perf_artifacts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  path TEXT NOT NULL,
  digest TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_perf_artifacts_owner
ON perf_artifacts(owner_type, owner_id, created_at DESC);

-- Memory Governor + policy learning + wrlela learning + token economy.
CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'proposed',
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_facts_namespace_key
ON memory_facts(namespace, fact_key);

CREATE TABLE IF NOT EXISTS memory_fact_versions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  value_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  supersedes_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (fact_id) REFERENCES memory_facts(id)
);

CREATE TABLE IF NOT EXISTS memory_evidence_links (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (fact_id) REFERENCES memory_facts(id)
);

CREATE TABLE IF NOT EXISTS memory_episodes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  outcome_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_episodes_run_created
ON memory_episodes(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_episode_summaries (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  summary_md TEXT NOT NULL,
  quality_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (episode_id) REFERENCES memory_episodes(id)
);

CREATE TABLE IF NOT EXISTS policy_arms (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS policy_bandit_state (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  model_json TEXT NOT NULL DEFAULT '{}',
  exploration_rate REAL NOT NULL DEFAULT 0.1,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rollback_of INTEGER
);

CREATE INDEX IF NOT EXISTS idx_policy_bandit_state_domain_version
ON policy_bandit_state(domain, version DESC);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  explore_flag INTEGER NOT NULL CHECK (explore_flag IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (arm_id) REFERENCES policy_arms(id)
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_domain_created
ON policy_decisions(domain, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_rewards (
  id TEXT PRIMARY KEY,
  policy_decision_id TEXT NOT NULL,
  reward_total REAL NOT NULL,
  reward_components_json TEXT NOT NULL DEFAULT '{}',
  latency_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (policy_decision_id) REFERENCES policy_decisions(id)
);

CREATE INDEX IF NOT EXISTS idx_policy_rewards_decision_created
ON policy_rewards(policy_decision_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_rollbacks (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owner_feedback_events (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  label TEXT NOT NULL,
  notes TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_owner_feedback_created
ON owner_feedback_events(created_at DESC);

CREATE TABLE IF NOT EXISTS repo_learning_facts (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  last_validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_learning_fact_unique
ON repo_learning_facts(repo_path, fact_type, fact_key);

CREATE TABLE IF NOT EXISTS repo_learning_evidence (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  snippet_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (fact_id) REFERENCES repo_learning_facts(id)
);

CREATE TABLE IF NOT EXISTS repo_file_outcomes (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  change_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  regression_count INTEGER NOT NULL DEFAULT 0,
  avg_review_iterations REAL NOT NULL DEFAULT 0,
  last_outcome_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_file_outcomes_unique
ON repo_file_outcomes(repo_path, file_path);

CREATE TABLE IF NOT EXISTS repo_command_playbooks (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  intent TEXT NOT NULL,
  command TEXT NOT NULL,
  success_rate REAL NOT NULL DEFAULT 0,
  median_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_command_playbooks_unique
ON repo_command_playbooks(repo_path, intent, command);

CREATE TABLE IF NOT EXISTS repo_competence_snapshots (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  score_total REAL NOT NULL DEFAULT 0,
  subscores_json TEXT NOT NULL DEFAULT '{}',
  top_risks_json TEXT NOT NULL DEFAULT '[]',
  top_strengths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0, 1)),
  cost_estimate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_token_usage_domain_created
ON token_usage_events(domain, created_at DESC);

CREATE TABLE IF NOT EXISTS token_budgets (
  id TEXT PRIMARY KEY,
  window TEXT NOT NULL,
  domain TEXT NOT NULL,
  soft_cap INTEGER NOT NULL,
  hard_cap INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_budgets_window_domain
ON token_budgets(window, domain);

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

-- Web chat conversations (web-only cut).
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  pinned_facts_json TEXT NOT NULL DEFAULT '[]',
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
ON conversations(last_message_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  status TEXT NOT NULL DEFAULT 'done',
  content TEXT NOT NULL,
  run_id TEXT,
  retrieval_query_id TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  token_input INTEGER NOT NULL DEFAULT 0,
  token_output INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created
ON conversation_messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_run_id
ON conversation_messages(run_id);

CREATE TABLE IF NOT EXISTS conversation_state (
  conversation_id TEXT PRIMARY KEY,
  summary_text TEXT NOT NULL DEFAULT '',
  summary_turn_count INTEGER NOT NULL DEFAULT 0,
  compacted_at TEXT,
  last_intent TEXT,
  token_budget INTEGER NOT NULL DEFAULT 4000,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS conversation_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT,
  run_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (user_message_id) REFERENCES conversation_messages(id),
  FOREIGN KEY (assistant_message_id) REFERENCES conversation_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_runs_conversation_created
ON conversation_runs(conversation_id, created_at DESC);

-- Memory Retrieval v3.
CREATE TABLE IF NOT EXISTS retrieval_documents (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retrieval_documents_type_repo_updated
ON retrieval_documents(doc_type, repo_path, updated_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_embeddings (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'hash64',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES retrieval_documents(id)
);

CREATE TABLE IF NOT EXISTS retrieval_queries (
  id TEXT PRIMARY KEY,
  query_text TEXT NOT NULL,
  intent TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  budget_tokens INTEGER NOT NULL DEFAULT 4000,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0, 1)),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retrieval_queries_created_at
ON retrieval_queries(created_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_results (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  document_id TEXT,
  source_class TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 0 CHECK (included IN (0, 1)),
  token_estimate INTEGER NOT NULL DEFAULT 0,
  excerpt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (query_id) REFERENCES retrieval_queries(id)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_results_query_score
ON retrieval_results(query_id, score DESC);

CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  run_id TEXT,
  feedback_type TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (query_id) REFERENCES retrieval_queries(id)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_query_created
ON retrieval_feedback(query_id, created_at DESC);

-- Autonomy Upgrade v1: hourly draft-PR autopilot control plane.
CREATE TABLE IF NOT EXISTS autonomy_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  hourly_budget INTEGER NOT NULL DEFAULT 2,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS autonomy_windows (
  id TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  budget INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_windows_start
ON autonomy_windows(window_start);

CREATE TABLE IF NOT EXISTS autonomy_decisions (
  id TEXT PRIMARY KEY,
  candidate_ref TEXT NOT NULL,
  source TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  ev REAL NOT NULL DEFAULT 0,
  risk_class TEXT NOT NULL DEFAULT 'medium',
  budget_window TEXT NOT NULL,
  queued_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (queued_task_id) REFERENCES task_queue(id)
);

CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_created
ON autonomy_decisions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_decision
ON autonomy_decisions(decision, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_reason
ON autonomy_decisions(reason, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_candidate_ref
ON autonomy_decisions(candidate_ref, created_at DESC);

CREATE TABLE IF NOT EXISTS autonomy_failures (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_autonomy_failures_created
ON autonomy_failures(created_at DESC);
