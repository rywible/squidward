import { createHash } from "node:crypto";

export type RetrievalSourceClass = "policy" | "canonical" | "repo_learning" | "episodic" | "evidence";

export interface RetrievalCandidate {
  sourceClass: RetrievalSourceClass;
  sourceRef: string;
  citation: string;
  text: string;
  semantic: number;
  freshness: number;
  confidence: number;
  sourceQuality: number;
  taskMatch: number;
  canonicalPriority: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RankedRetrievalCandidate extends RetrievalCandidate {
  id: string;
  score: number;
  estimatedTokens: number;
}

const ESTIMATED_CHARS_PER_TOKEN = 4;

const SOURCE_CLASS_ORDER: RetrievalSourceClass[] = ["policy", "canonical", "repo_learning", "episodic", "evidence"];

export const sourceClassOrder = SOURCE_CLASS_ORDER;

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));

const clip = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

export const computeRetrievalScore = (candidate: RetrievalCandidate): number => {
  return (
    0.35 * clip(candidate.semantic) +
    0.2 * clip(candidate.canonicalPriority) +
    0.15 * clip(candidate.freshness) +
    0.1 * clip(candidate.confidence) +
    0.1 * clip(candidate.sourceQuality) +
    0.1 * clip(candidate.taskMatch)
  );
};

export const rankRetrievalCandidates = (candidates: RetrievalCandidate[]): RankedRetrievalCandidate[] => {
  return candidates
    .map((candidate) => {
      const digest = createHash("sha256")
        .update(`${candidate.sourceClass}:${candidate.sourceRef}:${candidate.text}`)
        .digest("hex");
      return {
        ...candidate,
        id: digest,
        score: computeRetrievalScore(candidate),
        estimatedTokens: estimateTokens(candidate.text),
      } satisfies RankedRetrievalCandidate;
    })
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
      const classDiff = SOURCE_CLASS_ORDER.indexOf(a.sourceClass) - SOURCE_CLASS_ORDER.indexOf(b.sourceClass);
      if (classDiff !== 0) return classDiff;
      return a.sourceRef.localeCompare(b.sourceRef);
    });
};
