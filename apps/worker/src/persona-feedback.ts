import { Database } from "@squidward/db";

type SqlRecord = Record<string, unknown>;

const TRAIT_NAMES = [
  "verbosity",
  "directness",
  "challenge_level",
  "proactivity",
  "notification_frequency",
  "decision_framing",
  "risk_tolerance_within_policy",
  "supportiveness",
] as const;

type PersonaTraitName = (typeof TRAIT_NAMES)[number];

export interface PersonaAdjustment {
  trait: PersonaTraitName;
  delta: number;
}

export interface PersonaSignalInput {
  source: string;
  confidence?: number;
  adjustments: PersonaAdjustment[];
  context?: Record<string, unknown>;
}

const nowIso = (): string => new Date().toISOString();

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const asNum = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const traitId = (name: PersonaTraitName): string => `trait_${name}`;

const loadTraits = (db: Database): Map<PersonaTraitName, { value: number; confidence: number }> => {
  const rows = db
    .query(
      `SELECT trait_name, value, confidence
       FROM persona_traits`
    )
    .all() as SqlRecord[];

  const map = new Map<PersonaTraitName, { value: number; confidence: number }>();
  for (const row of rows) {
    const trait = String(row.trait_name) as PersonaTraitName;
    if (!TRAIT_NAMES.includes(trait)) {
      continue;
    }
    map.set(trait, {
      value: clamp(asNum(row.value, 0.7), 0, 1),
      confidence: clamp(asNum(row.confidence, 0.8), 0.05, 0.99),
    });
  }
  for (const trait of TRAIT_NAMES) {
    if (!map.has(trait)) {
      map.set(trait, { value: 0.7, confidence: 0.8 });
    }
  }
  return map;
};

export const applyPersonaSignal = (db: Database, input: PersonaSignalInput): void => {
  if (input.adjustments.length === 0) return;

  const observedConfidence = clamp(input.confidence ?? 0.75, 0.05, 0.99);
  const traits = loadTraits(db);
  const now = nowIso();

  for (const adj of input.adjustments) {
    const current = traits.get(adj.trait) ?? { value: 0.7, confidence: 0.8 };
    const nextValue = clamp(current.value + adj.delta, 0, 1);
    const nextConfidence = clamp(current.confidence * 0.85 + observedConfidence * 0.15, 0.05, 0.99);
    traits.set(adj.trait, { value: nextValue, confidence: nextConfidence });
  }

  for (const trait of TRAIT_NAMES) {
    const state = traits.get(trait) ?? { value: 0.7, confidence: 0.8 };
    db.query(
      `INSERT INTO persona_traits (id, trait_name, value, confidence, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         value=excluded.value,
         confidence=excluded.confidence,
         source=excluded.source,
         updated_at=excluded.updated_at`
    ).run(traitId(trait), trait, state.value, state.confidence, input.source, now);
  }

  const nextVersion = (db.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM persona_snapshots`).get() as SqlRecord)
    .version as number;
  const traitsJson = Array.from(traits.entries()).map(([traitName, state]) => ({
    traitName,
    value: Number(state.value.toFixed(4)),
    confidence: Number(state.confidence.toFixed(4)),
  }));

  db.query(
    `INSERT INTO persona_snapshots
     (id, version, traits_json, policy_bindings_json, created_at, rollback_of)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(
    crypto.randomUUID(),
    nextVersion,
    JSON.stringify(traitsJson),
    JSON.stringify({
      source: input.source,
      context: input.context ?? {},
    }),
    now
  );
};
