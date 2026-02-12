export const HEARTBEAT_MODES = ["active", "idle", "off-hours"] as const;
export type HeartbeatMode = (typeof HEARTBEAT_MODES)[number];

export interface HeartbeatPolicy {
  mode: HeartbeatMode;
  intervalMinutes: number;
  immediateWakeOnSlackEvent: boolean;
}

export interface QueueItem {
  id: string;
  sourceId: string;
  type: "bug_fix" | "performance" | "proposal" | "incident" | "maintenance";
  priority: number;
  status: "queued" | "in_progress" | "blocked" | "completed" | "cancelled";
  risk: "low" | "medium" | "high" | "critical";
  blockedBy: string[];
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunAction {
  kind: "command" | "integration_call" | "policy_decision" | "notification";
  summary: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
}

export interface AgentRun {
  id: string;
  triggerType: "event" | "schedule" | "heartbeat" | "manual";
  objective: string;
  actions: RunAction[];
  outcome: "success" | "failure" | "partial" | "cancelled";
  rollbackFlag: boolean;
  durationMs: number;
  createdAt: string;
}

export interface AuthProviderHealth {
  provider: "slack" | "linear" | "openai" | "github" | "gitlab" | "ci" | "monitoring";
  status: "linked" | "expired" | "degraded" | "failed" | "unlinked";
  scopes: string[];
  expiresAt?: string;
  lastValidatedAt?: string;
  failureReason?: string;
}

export interface ProviderBudgetHealth {
  provider: "brave" | "openai" | "playwright" | "other";
  month: string;
  consumedUnits: number;
  capUnits: number;
  alertState: "normal" | "warning_70" | "warning_90" | "hard_cap";
  updatedAt: string;
}

export const PERSONA_TRAITS = [
  "verbosity",
  "directness",
  "challenge_level",
  "proactivity",
  "notification_frequency",
  "decision_framing",
  "risk_tolerance_within_policy",
  "supportiveness"
] as const;

export type PersonaTraitName = (typeof PERSONA_TRAITS)[number];

export interface PersonaTrait {
  traitName: PersonaTraitName;
  value: number;
  confidence: number;
  source: string;
  updatedAt: string;
}

export interface PersonaSnapshot {
  version: number;
  traits: PersonaTrait[];
  policyBindings: Record<string, unknown>;
  createdAt: string;
  rollbackOf?: number;
}

export interface DashboardSnapshot {
  generatedAt: string;
  queueDepth: number;
  queuedByPriority: Record<string, number>;
  activeRuns: AgentRun[];
  heartbeat: {
    activeMode: HeartbeatMode;
    nextWakeAt: string;
    policies: HeartbeatPolicy[];
  };
  authHealth: AuthProviderHealth[];
  budgetHealth: ProviderBudgetHealth[];
  persona: {
    activeVersion: number;
    traits: PersonaTrait[];
  };
}
