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

const parseJsonSafe = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const looksLikePayloadObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    (typeof row.status === "string" || typeof row.summary === "string") &&
    ("actionsTaken" in row || "actions_taken" in row || "proposedChanges" in row || "proposed_changes" in row)
  );
};

const extractTextCandidates = (value: unknown, output: string[], depth = 0): void => {
  if (depth > 6 || output.length > 200) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      output.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractTextCandidates(item, output, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const row = value as Record<string, unknown>;
  const prioritized = ["output_text", "text", "content", "message", "response", "delta", "value"];
  for (const key of prioritized) {
    if (key in row) {
      extractTextCandidates(row[key], output, depth + 1);
    }
  }
  for (const item of Object.values(row)) {
    extractTextCandidates(item, output, depth + 1);
  }
};

const gatherPayloadCandidates = (raw: string): string[] => {
  const candidates: string[] = [];
  const directTagged = extractTaggedPayload(raw);
  if (directTagged) {
    candidates.push(directTagged);
  }

  const directJson = parseJsonSafe(raw);
  if (looksLikePayloadObject(directJson)) {
    candidates.push(JSON.stringify(directJson));
  }
  extractTextCandidates(directJson, candidates);

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const lineTagged = extractTaggedPayload(trimmed);
    if (lineTagged) {
      candidates.push(lineTagged);
      continue;
    }
    const lineJson = parseJsonSafe(trimmed);
    if (looksLikePayloadObject(lineJson)) {
      candidates.push(JSON.stringify(lineJson));
    }
    extractTextCandidates(lineJson, candidates);
  }

  candidates.push(raw);
  const deduped = [...new Set(candidates.map((item) => item.trim()).filter((item) => item.length > 0))];
  return deduped.slice(0, 100);
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
  const candidates = gatherPayloadCandidates(raw).flatMap((candidate) => {
    const tagged = extractTaggedPayload(candidate);
    if (tagged) {
      return [tagged, normalizeCandidateJson(tagged)];
    }
    return [candidate, normalizeCandidateJson(candidate)];
  });
  let parsed: unknown | null = null;
  let parsedSource = "";
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate) as unknown;
      parsedSource = candidate;
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
    rawJson: parsedSource,
    contextHash: createHash("sha256").update(parsedSource).digest("hex"),
  };
};

export const buildCodexOutputContract = (): string => {
  return [
    "MANDATORY OUTPUT CONTRACT. FOLLOW EXACTLY.",
    "You MUST output exactly one payload between tags. No additional text before/after tags.",
    `Line 1 must be exactly: ${START_TAG}`,
    "Line 2..N-1 must be exactly one valid JSON object.",
    `Final line must be exactly: ${END_TAG}`,
    "No markdown fences.",
    "No explanations.",
    "No tool logs.",
    "No wrapper envelopes (for example: no output_text/content/message wrappers).",
    "Required JSON schema:",
    "{",
    '  "status": "done" | "blocked" | "needs_input",',
    '  "summary": "string",',
    '  "actionsTaken": [{"kind":"edit|command|analysis","detail":"string","evidenceRefs":["string"]}],',
    '  "proposedChanges": {"files":["string"],"estimatedLoc":0,"risk":"low|medium|high"},',
    '  "memoryProposals": [{"layerHint":"working|episodic|canonical|policy","type":"string","key":"string","value":{},"confidence":0.0,"citations":["string"]}],',
    '  "nextSteps": ["string"]',
    "}",
    "If uncertain, still output schema-valid JSON with status='blocked' and a concise summary.",
  ].join("\n");
};
