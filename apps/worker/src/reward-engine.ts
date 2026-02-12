import type { Database } from "@squidward/db";

const nowIso = (): string => new Date().toISOString();

export interface RewardInput {
  policyDecisionId: string;
  reliability: number;
  completion: number;
  perfGain: number;
  ownerFeedback: number;
  noisePenalty: number;
  latencyMinutes: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const computeReliabilityFirstReward = (input: Omit<RewardInput, "policyDecisionId" | "latencyMinutes">): number => {
  const reliability = clamp(input.reliability, -1, 1);
  const completion = clamp(input.completion, -1, 1);
  const perfGain = clamp(input.perfGain, -1, 1);
  const ownerFeedback = clamp(input.ownerFeedback, -1, 1);
  const noisePenalty = clamp(input.noisePenalty, -1, 1);
  const reward =
    0.5 * reliability +
    0.2 * completion +
    0.15 * perfGain +
    0.1 * ownerFeedback +
    0.05 * noisePenalty;
  return Number(reward.toFixed(4));
};

export const recordReward = (db: Database | undefined, input: RewardInput): void => {
  if (!db) return;
  const rewardTotal = computeReliabilityFirstReward({
    reliability: input.reliability,
    completion: input.completion,
    perfGain: input.perfGain,
    ownerFeedback: input.ownerFeedback,
    noisePenalty: input.noisePenalty,
  });
  db.query(
    `INSERT INTO policy_rewards
     (id, policy_decision_id, reward_total, reward_components_json, latency_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    input.policyDecisionId,
    rewardTotal,
    JSON.stringify({
      reliability: input.reliability,
      completion: input.completion,
      perfGain: input.perfGain,
      ownerFeedback: input.ownerFeedback,
      noisePenalty: input.noisePenalty,
    }),
    Math.max(0, Math.floor(input.latencyMinutes)),
    nowIso()
  );
};
