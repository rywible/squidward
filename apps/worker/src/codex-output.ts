import { createHash } from "node:crypto";

export interface CodexMemoryProposal {
  layerHint: "working" | "episodic" | "canonical" | "policy";
  type: string;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
  citations: string[];
}

export interface CodexActionEntry {
  kind: "edit" | "command" | "analysis";
  detail: string;
  evidenceRefs: string[];
}

export interface CodexAgentPayload {
  status: "done" | "blocked" | "needs_input";
  summary: string;
  actionsTaken: CodexActionEntry[];
  proposedChanges: {
    files: string[];
    estimatedLoc: number;
    risk: "low" | "medium" | "high";
  };
  memoryProposals: CodexMemoryProposal[];
  nextSteps: string[];
}

export interface ParsedCodexPayload {
  payload: CodexAgentPayload;
  rawJson: string;
  contextHash: string;
}

const START_TAG = "BEGIN_AGENT_PAYLOAD";
const END_TAG = "END_AGENT_PAYLOAD";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const stripCodeFences = (value: string): string =>
  value
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

const normalizeCandidateJson = (value: string): string => {
  const stripped = stripCodeFences(value);
  // Common recovery for trailing commas before closing delimiters.
  return stripped.replace(/,\s*([}\]])/g, "$1");
};

export const extractTaggedPayload = (raw: string): string | null => {
  const start = raw.indexOf(START_TAG);
  const end = raw.indexOf(END_TAG);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const sliced = raw.slice(start + START_TAG.length, end).trim();
  return sliced.length > 0 ? sliced : null;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

const asMemoryProposal = (value: unknown): CodexMemoryProposal | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const layerRaw = String(row.layerHint ?? row.layer_hint ?? "working");
  const layerHint =
    layerRaw === "working" || layerRaw === "episodic" || layerRaw === "canonical" || layerRaw === "policy"
      ? layerRaw
      : "working";

  const key = String(row.key ?? "");
  const type = String(row.type ?? "fact");
  if (!key) return null;

  const valueJson = row.value && typeof row.value === "object" ? (row.value as Record<string, unknown>) : {};
  const citations = asStringArray(row.citations);
  return {
    layerHint,
    type,
    key,
    value: valueJson,
    confidence: clamp(Number(row.confidence ?? 0), 0, 1),
    citations,
  };
};

const asAction = (value: unknown): CodexActionEntry | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = String(row.kind ?? "analysis");
  if (kind !== "edit" && kind !== "command" && kind !== "analysis") return null;
  const detail = String(row.detail ?? "");
  if (!detail) return null;
  return {
    kind,
    detail,
    evidenceRefs: asStringArray(row.evidenceRefs ?? row.evidence_refs),
  };
};

export const parseCodexPayload = (raw: string): ParsedCodexPayload => {
  const extracted = extractTaggedPayload(raw);
  if (!extracted) {
    throw new Error("missing_tagged_payload");
  }

  const candidates = [extracted, normalizeCandidateJson(extracted)];
  let parsed: unknown | null = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate) as unknown;
      break;
    } catch {
      // Continue to fallback candidate.
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid_json_payload");
  }
  const row = parsed as Record<string, unknown>;
  const statusRaw = String(row.status ?? "");
  if (statusRaw !== "done" && statusRaw !== "blocked" && statusRaw !== "needs_input") {
    throw new Error("invalid_status");
  }

  const summary = String(row.summary ?? "").trim();
  if (!summary) {
    throw new Error("missing_summary");
  }

  const rawActions = row.actionsTaken ?? row.actions_taken;
  const actionsTaken = Array.isArray(rawActions)
    ? rawActions
        .map((item: unknown) => asAction(item))
        .filter((item: CodexActionEntry | null): item is CodexActionEntry => Boolean(item))
    : [];

  const proposed = (row.proposedChanges ?? row.proposed_changes) as Record<string, unknown> | undefined;
  const riskRaw = String(proposed?.risk ?? "medium");
  const risk = riskRaw === "low" || riskRaw === "medium" || riskRaw === "high" ? riskRaw : "medium";

  const rawMemory = row.memoryProposals ?? row.memory_proposals;
  const memoryProposals = Array.isArray(rawMemory)
    ? rawMemory
        .map((item: unknown) => asMemoryProposal(item))
        .filter((item: CodexMemoryProposal | null): item is CodexMemoryProposal => Boolean(item))
    : [];

  const payload: CodexAgentPayload = {
    status: statusRaw,
    summary,
    actionsTaken,
    proposedChanges: {
      files: asStringArray(proposed?.files),
      estimatedLoc: Math.max(0, Number(proposed?.estimatedLoc ?? proposed?.estimated_loc ?? 0) || 0),
      risk,
    },
    memoryProposals,
    nextSteps: asStringArray(row.nextSteps ?? row.next_steps),
  };

  return {
    payload,
    rawJson: extracted,
    contextHash: createHash("sha256").update(extracted).digest("hex"),
  };
};

export const buildCodexOutputContract = (): string => {
  return [
    "Return ONLY one tagged payload.",
    `Start with ${START_TAG} on its own line.`,
    "Then a single JSON object with fields:",
    "- status: done|blocked|needs_input",
    "- summary: string",
    "- actionsTaken: [{kind,detail,evidenceRefs[]}]",
    "- proposedChanges: {files[], estimatedLoc, risk}",
    "- memoryProposals: [{layerHint,type,key,value,confidence,citations[]}]",
    "- nextSteps: string[]",
    `End with ${END_TAG} on its own line.`,
    "No markdown fences. No prose outside tags.",
  ].join("\n");
};
