export type TaskAction = 'pause' | 'resume' | 'retry' | 'stop';

export interface CockpitSnapshot {
  generatedAt: string;
  activeRuns: number;
  queuedTasks: number;
  incidentsOpen: number;
  approvalsPending: number;
  health: 'ok' | 'degraded' | 'down';
  latestRun?: RunSummary;
}

export interface RunSummary {
  id: string;
  objective: string;
  triggerType: string;
  status: 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'stopped';
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  rollbackFlag: boolean;
}

export interface QueueTask {
  id: string;
  runId: string;
  title: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  status: 'queued' | 'running' | 'paused' | 'blocked' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  runId: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface PersonaTrait {
  name: string;
  value: string;
  confidence: number;
  source: string;
  updatedAt: string;
}

export interface SystemOverview {
  generatedAt: string;
  mode: 'active' | 'idle';
  uptimeSeconds: number;
  memoryMb: number;
  cpuPercent: number;
  queueDepth: number;
  activeIncidents: number;
  policyDenialsLastHour: number;
}

export interface RunActionRequest {
  action: TaskAction;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  updatedAt: string;
}

export interface PortfolioScoreBreakdown {
  impact: number;
  confidence: number;
  urgency: number;
  risk: number;
  effort: number;
  ev: number;
}

export interface PortfolioCandidate {
  id: string;
  sourceType: string;
  sourceRef: string;
  title: string;
  summary: string;
  riskClass: string;
  effortClass: string;
  evidenceLinks: string[];
  score: PortfolioScoreBreakdown;
  scoredAt: string;
}

export interface PortfolioHistoryItem {
  id: string;
  candidateId: string;
  decision: string;
  reason: string;
  threshold: number;
  createdAt: string;
}

export interface PortfolioHistoryResponse {
  items: PortfolioHistoryItem[];
  nextCursor?: string;
}

export interface TestEvolutionStats {
  generated: number;
  accepted: number;
  acceptanceRate: number;
  lastRunAt?: string;
}

export interface TestEvolutionCandidate {
  id: string;
  bugRef: string;
  language: string;
  framework: string;
  testPath: string;
  status: string;
  score: number;
  validationNotes: string;
  createdAt: string;
}

export interface RegressionProof {
  candidateId: string;
  bugRef: string;
  sourceType: string;
  sourceRef: string;
}

export interface TestEvolutionCandidatesResponse {
  items: TestEvolutionCandidate[];
  provenance: RegressionProof[];
  nextCursor?: string;
}

export interface MemoRecommendation {
  id: string;
  recommendationType: string;
  title: string;
  rationale: string;
  expectedValue: number;
  evidenceLinks: string[];
}

export interface DecisionAsk {
  id: string;
  prompt: string;
  impact: string;
  dueHint?: string;
}

export interface CtoMemo {
  id: string;
  weekStart: string;
  weekEnd: string;
  summaryMd: string;
  evidenceLinks: string[];
  recommendations: MemoRecommendation[];
  asks: DecisionAsk[];
  createdAt: string;
}

export interface MemoHistoryResponse {
  items: CtoMemo[];
  nextCursor?: string;
}

export interface GraphNode {
  id: string;
  nodeType: string;
  ref: string;
  label: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  weight: number;
  evidenceRef?: string;
}

export interface GraphImpactReport {
  query: string;
  touchedNodes: GraphNode[];
  edges: GraphEdge[];
  hotspots: Array<{ ref: string; count: number }>;
  generatedAt: string;
}

export interface EvidencePath {
  recommendationId: string;
  path: Array<{ nodeRef: string; nodeType: string; reason: string }>;
}

export interface PerfScientistStatus {
  enabled: boolean;
  repoPath: string;
  lastBaselineAt?: string;
  lastExperimentAt?: string;
  queuedTasks: number;
  runningExperiments: number;
  nextNightlyHour: number;
}

export interface PerfDecision {
  id: string;
  candidateId: string;
  decision: string;
  score: number;
  reason: string;
  createdAt: string;
}

export interface PerfCandidate {
  id: string;
  experimentId: string;
  title: string;
  hypothesis: string;
  changeClass: string;
  targetPaths: string[];
  riskClass: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  latestDecision?: PerfDecision;
}

export interface PerfExperiment {
  id: string;
  objective: string;
  status: string;
  triggerSource: string;
  baseCommitSha: string;
  branchName?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  candidateCount: number;
}

export interface PerfBaseline {
  id: string;
  repoPath: string;
  commitSha: string;
  profile: string;
  manifestPath: string;
  baselineJsonPath: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface PerfRun {
  id: string;
  candidateId?: string;
  runKind: string;
  profile: string;
  runs: number;
  command: string;
  cwd: string;
  artifactPath?: string;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface PerfMetric {
  id: string;
  runId: string;
  scenarioId: string;
  runtimeP50Ns?: number;
  runtimeP95Ns?: number;
  runtimeP99Ns?: number;
  compileThroughputTps?: number;
  allocsPerRequest?: number;
  dispatchHitRatio?: number;
  cvPct?: number;
  confidencePct?: number;
  effectPct?: number;
  createdAt: string;
}

export interface PerfArtifact {
  id: string;
  ownerType: string;
  ownerId: string;
  artifactType: string;
  path: string;
  digest?: string;
  createdAt: string;
}

export interface MemoryFact {
  id: string;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
  state: string;
  confidence: number;
  source: string;
  updatedAt: string;
}

export interface MemoryEpisode {
  id: string;
  runId: string;
  triggerType: string;
  context: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  outcome: Record<string, unknown>;
  createdAt: string;
}

export interface PolicyStatus {
  domain: string;
  explorationRate: number;
  latestVersion?: number;
  lastDecisionAt?: string;
  totalRewards7d: number;
}

export interface RepoLearningFact {
  id: string;
  repoPath: string;
  factType: string;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
}

export interface RepoCompetenceSnapshot {
  id: string;
  repoPath: string;
  scoreTotal: number;
  subscores: Record<string, unknown>;
  topRisks: string[];
  topStrengths: string[];
  createdAt: string;
}

export interface TokenEconomyStatus {
  domain: string;
  monthlyUsedTokens: number;
  softCap: number;
  hardCap: number;
  economyMode: boolean;
}

export interface TokenUsageItem {
  id: string;
  runId: string;
  domain: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean;
  createdAt: string;
}

export interface RetrievalStatus {
  enabled: boolean;
  lastQueryAt?: string;
  p95LatencyMs: number;
  cacheHitRate: number;
  avgUsedTokens: number;
}

export interface RetrievalQueryLog {
  id: string;
  intent: string;
  repoPath: string;
  candidateCount: number;
  selectedCount: number;
  budgetTokens: number;
  usedTokens: number;
  cacheHit: boolean;
  latencyMs: number;
  createdAt: string;
}

export interface RetrievalResultItem {
  id: string;
  queryId: string;
  sourceClass: string;
  sourceRef: string;
  score: number;
  included: boolean;
  tokenEstimate: number;
  excerpt: string;
  createdAt: string;
}

export interface RetrievalContextPack {
  queryId: string;
  selectedCount: number;
  budgetTokens: number;
  usedTokens: number;
  evidenceRefs: string[];
  snippets: Array<{ sourceClass: string; sourceRef: string; score: number; excerpt: string }>;
}
