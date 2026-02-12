import type { Database } from "@squidward/db";

type SqlRecord = Record<string, unknown>;

export interface TokenEnvelope {
  domain: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  economyMode: boolean;
}

const nowIso = (): string => new Date().toISOString();
const monthKey = (): string => new Date().toISOString().slice(0, 7);

const DEFAULT_BUDGETS: Array<{ domain: string; softCap: number; hardCap: number }> = [
  { domain: "slack", softCap: 20000, hardCap: 35000 },
  { domain: "triage", softCap: 30000, hardCap: 60000 },
  { domain: "aps", softCap: 40000, hardCap: 80000 },
  { domain: "memo", softCap: 25000, hardCap: 45000 },
  { domain: "general", softCap: 50000, hardCap: 100000 },
];

export const ensureTokenBudgets = (db: Database): void => {
  for (const budget of DEFAULT_BUDGETS) {
    db.query(
      `INSERT OR IGNORE INTO token_budgets (id, window, domain, soft_cap, hard_cap, updated_at)
       VALUES (?, 'monthly', ?, ?, ?, ?)`
    ).run(`tok_monthly_${budget.domain}`, budget.domain, budget.softCap, budget.hardCap, nowIso());
  }
};

const tokenDefaults = (domain: string): { maxInput: number; maxOutput: number } => {
  if (domain === "slack") return { maxInput: 1200, maxOutput: 250 };
  if (domain === "triage") return { maxInput: 2000, maxOutput: 400 };
  if (domain === "aps") return { maxInput: 3500, maxOutput: 700 };
  if (domain === "memo") return { maxInput: 5000, maxOutput: 1200 };
  return { maxInput: 1800, maxOutput: 400 };
};

export const buildTokenEnvelope = (db: Database | undefined, domain: string): TokenEnvelope => {
  if (!db) {
    const defaults = tokenDefaults(domain);
    return {
      domain,
      maxInputTokens: defaults.maxInput,
      maxOutputTokens: defaults.maxOutput,
      economyMode: false,
    };
  }

  ensureTokenBudgets(db);
  const row = db
    .query(
      `SELECT soft_cap, hard_cap
       FROM token_budgets
       WHERE window='monthly' AND domain=?
       LIMIT 1`
    )
    .get(domain) as SqlRecord | null;

  const totals = db
    .query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
       FROM token_usage_events
       WHERE domain=? AND created_at >= ?`
    )
    .get(domain, `${monthKey()}-01T00:00:00.000Z`) as SqlRecord;

  const used = Number(totals.used ?? 0);
  const softCap = Number(row?.soft_cap ?? tokenDefaults(domain).maxInput * 20);
  const hardCap = Number(row?.hard_cap ?? tokenDefaults(domain).maxInput * 40);
  const economyMode = used >= Math.round(softCap * 0.9) || used >= hardCap;

  const defaults = tokenDefaults(domain);
  return {
    domain,
    maxInputTokens: economyMode ? Math.round(defaults.maxInput * 0.7) : defaults.maxInput,
    maxOutputTokens: economyMode ? Math.round(defaults.maxOutput * 0.7) : defaults.maxOutput,
    economyMode,
  };
};

export const recordTokenUsage = (db: Database | undefined, params: {
  runId: string;
  domain: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHit?: boolean;
  costEstimate?: number;
}): void => {
  if (!db) return;
  db.query(
    `INSERT INTO token_usage_events
     (id, run_id, domain, model, input_tokens, output_tokens, cache_hit, cost_estimate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    params.runId,
    params.domain,
    params.model,
    Math.max(0, Math.floor(params.inputTokens)),
    Math.max(0, Math.floor(params.outputTokens)),
    params.cacheHit ? 1 : 0,
    params.costEstimate ?? 0,
    nowIso()
  );
};
