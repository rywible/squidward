# Squidward Agent Platform

Bun + TypeScript implementation of the personal engineering/ops manager agent described in `TECHNICAL_SPEC.md`.

## What is implemented

- Shared domain packages (`packages/core`, `packages/db`, `packages/security`)
- API control plane (`apps/api`) with dashboard APIs + OAuth + integration status/refresh endpoints
- Worker runtime (`apps/worker`) with:
1. single active Codex session manager
2. serialized priority queue (P0/P1/P2)
3. heartbeat scheduler (1m active / 10m idle / 30m off-hours)
4. full command execution + immutable command audit
5. integration preflight checks (`gh`, `codex`)
- Moonshot v1.5 systems:
1. PR Hedge Fund (EV scoring and ranked portfolio decisions)
2. Self-Evolving Test Generator (bug-to-regression candidate loop)
3. Personal CTO Memo Engine (weekly strategic memo synthesis)
4. Architecture Memory Graph (code + PR + incident impact graph)
5. Autonomous Perf Scientist (nightly baseline + change smoke + draft PR recommendations)
- React dashboard (`apps/dashboard`) served by Bun API static fallback

## Repo scope + runtime defaults

- Primary repo path: `/Users/ryanwible/projects/wrela` (override via `PRIMARY_REPO_PATH`)
- Shared DB path: `.data/agent.db` (override via `AGENT_DB_PATH`)
- Brave budget hard cap: `2000` (persisted in `provider_budget_usage`)
- Moonshot scheduler env defaults:
1. `PORTFOLIO_TOP_N=5`
2. `PORTFOLIO_MIN_EV_AUTORUN=1.25`
3. `TEST_GEN_MAX_CANDIDATES_PER_BUG=3`
4. `MEMO_WEEKDAY=1` and `MEMO_HOUR=9`
5. `GRAPH_REINDEX_CRON=60` (minutes)

## Quick start

```bash
bun install
bun run build
```

Recommended setup wizard:

```bash
bun run setup:squidward
```

Non-interactive provisioning mode:

```bash
bun run setup:squidward --non-interactive --skip-install --skip-build
```

Terminal 1:

```bash
AGENT_DB_PATH=.data/agent.db bun run --filter @squidward/worker start
```

Terminal 2:

```bash
AGENT_DB_PATH=.data/agent.db bun run --filter @squidward/api dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Useful scripts

- `bun run setup:squidward`
- `bun run lint`
- `bun run test`
- `bun run build`

## Notes

- `apps/worker` defaults to real command execution. Set `WORKER_USE_STUB_EXECUTOR=1` for dry/local simulation.
- API and worker must point to the same `AGENT_DB_PATH`.
- Integrations are live:
1. OAuth for Slack/Linear (`/oauth/:provider/start` + `/oauth/:provider/callback`)
2. Integration status endpoint (`/api/integrations/status`)
3. Provider refresh endpoint (`/api/integrations/refresh/:provider`)
