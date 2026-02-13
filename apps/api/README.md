# API Service

Bun API server for the agent control plane. It serves both JSON APIs and the React dashboard static bundle.

## Runtime

- Bun 1.1+
- TypeScript 5+

## Environment Variables

- `API_HOST`: Bind host. Default: `0.0.0.0`
- `API_PORT`: Bind port. Default: `3000`
- `AGENT_DB_PATH`: Shared SQLite path used by API + worker. Default: `.data/agent.db`
- `DASHBOARD_DIST_DIR`: Optional dashboard build path override
- `LINEAR_API_KEY`: Preferred single-user Linear personal API key. `/api/integrations/status` validates it directly via Linear GraphQL.
- `OPENAI_API_KEY` / `OPENAI_TOKEN`: Used by `/api/integrations/status` to report OpenAI token presence

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /api/chat/conversations?cursor=&limit=`
- `POST /api/chat/conversations`
- `GET /api/chat/conversations/:id`
- `POST /api/chat/conversations/:id/messages`
- `POST /api/chat/conversations/:id/compact`
- `GET /api/chat/conversations/:id/runs`
- `GET /api/dashboard/snapshot`
- `GET /api/runs`
- `GET /api/queue`
- `GET /api/audit`
- `GET /api/persona/snapshot`
- `GET /api/system/health`
- `GET /api/budget/brave`
- `GET /api/portfolio/top?limit=`
- `GET /api/portfolio/history?from=&to=&cursor=&limit=`
- `GET /api/tests/evolution/stats`
- `GET /api/tests/evolution/candidates?status=&cursor=&limit=`
- `GET /api/memos/latest`
- `GET /api/memos/history?cursor=&limit=`
- `POST /api/graph/impact`
- `GET /api/graph/hotspots`
- `GET /api/graph/explain/:recommendationId`
- `GET /api/perf-scientist/status`
- `GET /api/perf-scientist/experiments`
- `GET /api/perf-scientist/candidates`
- `GET /api/perf-scientist/baselines`
- `GET /api/perf-scientist/leaderboard`
- `GET /api/perf-scientist/artifacts/:runId`
- `POST /api/perf-scientist/actions/:candidateId`
- `POST /api/actions/pause`
- `POST /api/actions/resume`
- `POST /api/actions/retry-task`
- `POST /api/actions/stop-task`
- Dashboard compatibility endpoints:
1. `GET /api/dashboard/cockpit`
2. `GET /api/dashboard/runs`
3. `GET /api/dashboard/queue`
4. `GET /api/dashboard/audit`
5. `GET /api/dashboard/persona`
6. `GET /api/dashboard/system`
7. `POST /api/dashboard/runs/:runId/actions`
8. `POST /api/dashboard/tasks/:taskId/actions`
- `GET /api/integrations/status`

## Run

```bash
bun run dev
```

## Integration Notes

1. Set `AGENT_DB_PATH` so API + worker share the same SQLite file.
2. Configure direct credentials (`LINEAR_API_KEY`, `BRAVE_API_KEY`).
3. `/api/integrations/status` includes checks for Linear API key validity, OpenAI token presence, GitHub CLI auth (`gh auth status`), and Codex CLI availability (`codex --version` fallback `codex --help`).
