# Worker

`apps/worker` runs the serialized queue + single active Codex session runtime.

## Required/optional env vars

- `AGENT_DB_PATH` (optional): SQLite path. Default: `./.data/agent.db`.
- `WORKER_USE_STUB_EXECUTOR` (optional): set `1` to use stub Codex/GitHub adapters for local/dev.
- `WORKER_BOOTSTRAP_COMMAND` (optional): command queued on startup. Default: `codex --help || true`.
- `PRIMARY_REPO_PATH` (optional): cwd for bootstrap command.
- `PORTFOLIO_TOP_N` (optional): daily ranked candidates to action in draft queue. Default: `5`.
- `PORTFOLIO_MIN_EV_AUTORUN` (optional): EV floor for low-risk draft queueing. Default: `1.25`.
- `TEST_GEN_MAX_CANDIDATES_PER_BUG` (optional): max generated test candidates per bug source. Default: `3`.
- `MEMO_WEEKDAY` / `MEMO_HOUR` (optional): weekly memo schedule. Default: Monday at 09:00.
- `GRAPH_REINDEX_CRON` (optional): graph index interval in minutes. Default: `60`.
- `PERF_SCIENTIST_ENABLED` (optional): enable APS job pipeline (`1`/`0`). Default: `0`.
- `PERF_SCIENTIST_REPO_PATH` (optional): managed repo path for perf scientist.
- `PERF_SCIENTIST_BENCHMARK_ROOT` (optional): benchmark project root for `wrela perf/perfcmp`.
- `PERF_SCIENTIST_MANIFEST_PATH` (optional): benchmark manifest path (`bench.toml`).
- `PERF_SCIENTIST_NIGHTLY_HOUR` (optional): nightly standard baseline hour. Default: `2`.
- `PERF_SCIENTIST_SMOKE_ON_CHANGE` (optional): run smoke when qualifying head changes are detected. Default: `1`.
- `PERF_SCIENTIST_STANDARD_RUNS` / `PERF_SCIENTIST_SMOKE_RUNS` (optional): perf harness run counts.
- `PERF_SCIENTIST_CV_MAX_PCT` / `PERF_SCIENTIST_MIN_EFFECT_PCT` / `PERF_SCIENTIST_CONFIDENCE_PCT` (optional): statistical gates.
- `PERF_SCIENTIST_MAX_AUTO_PR_FILES` / `PERF_SCIENTIST_MAX_AUTO_PR_LOC` (optional): auto draft PR blast-radius caps.
- `PERF_SCIENTIST_BASE_REF` (optional): base ref for perfcmp and draft PR creation. Default: `main`.
- `PERF_SCIENTIST_PATCH_COMMAND_TEMPLATE` (optional): command template for candidate patch attempts.
- `PERF_SCIENTIST_TEST_COMMAND` (optional): required targeted test command before opening APS draft PR. Default: `cargo test -q -p compiler --lib`.

Adapters:
- `SLACK_BOT_TOKEN`: required for `RealSlackAdapter` (`chat.postMessage`).
- `BRAVE_API_KEY`: required for `RealBraveResearchAdapter` (`/res/v1/web/search`).
- `OPENAI_API_KEY`: required for `RealOpenAIModelAdapter` (`/v1/responses`).
- `OPENAI_MODEL` (optional): model name for OpenAI adapter. Default: `gpt-4.1-mini`.

Startup preflight:
- Worker checks `gh auth status` and `codex --version` at startup and writes results to `command_audit`.
- `CODEX_PREFLIGHT_AUTH_COMMAND` (optional): shell command for an additional Codex auth preflight check. If set, its result is also written to `command_audit`.

Moonshot jobs:
- `portfolio_ranker_daily` (`portfolio_eval`)
- `test_evolution_continuous` (`test_gen`)
- `cto_memo_weekly` (`memo_build`)
- `graph_indexer_incremental` (`graph_reindex`)
- `perf_baseline_nightly` (`perf_baseline_nightly`)
- `perf_detect_change_smoke` (`perf_detect_change_smoke`)
- `perf_generate_candidates` (`perf_generate_candidates`)
- `perf_run_candidate` (`perf_run_candidate`)
- `perf_score_decide` (`perf_score_decide`)
- `perf_open_draft_pr` (`perf_open_draft_pr`)
