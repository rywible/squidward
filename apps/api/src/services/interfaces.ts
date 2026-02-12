import type {
  ActionRequest,
  ActionResponse,
  AuditEntry,
  BraveBudgetResponse,
  CtoMemo,
  CockpitSnapshot,
  EvidencePath,
  GeneratedTestCandidate,
  ImpactReport,
  PerfArtifact,
  PerfBaseline,
  PerfCandidate,
  PerfDecision,
  PerfExperiment,
  PerfMetric,
  PerfRun,
  PerfScientistStatus,
  MemoryFact,
  MemoryEpisode,
  PolicyHistoryItem,
  PolicyStatus,
  RepoCompetenceSnapshot,
  RepoLearningFact,
  RetrievalContextPack,
  RetrievalFeedbackEvent,
  RetrievalQueryLog,
  RetrievalResultItem,
  RetrievalStatus,
  TokenEconomyStatus,
  TokenUsageItem,
  PersonaTrait,
  PortfolioCandidate,
  PortfolioDecision,
  QueueTask,
  RegressionProof,
  RunSummary,
  SystemOverview,
  TestEvolutionResult,
} from "../types/contracts";

export interface DashboardService {
  getCockpit(): Promise<CockpitSnapshot>;
}

export interface RunsService {
  listRuns(): Promise<RunSummary[]>;
}

export interface QueueService {
  listQueue(): Promise<QueueTask[]>;
}

export interface AuditService {
  listAudit(): Promise<AuditEntry[]>;
}

export interface PersonaService {
  listTraits(): Promise<PersonaTrait[]>;
}

export interface SystemService {
  getOverview(): Promise<SystemOverview>;
}

export interface BudgetService {
  getBraveBudget(): Promise<BraveBudgetResponse>;
}

export interface ActionsService {
  pause(input: ActionRequest): Promise<ActionResponse>;
  resume(input: ActionRequest): Promise<ActionResponse>;
  retryTask(input: ActionRequest): Promise<ActionResponse>;
  stopTask(input: ActionRequest): Promise<ActionResponse>;
}

export interface PortfolioService {
  listTop(limit: number): Promise<PortfolioCandidate[]>;
  listHistory(from?: string, to?: string, cursor?: string, limit?: number): Promise<{
    items: PortfolioDecision[];
    nextCursor?: string;
  }>;
}

export interface TestEvolutionService {
  getStats(): Promise<TestEvolutionResult>;
  listCandidates(status?: string, cursor?: string, limit?: number): Promise<{
    items: GeneratedTestCandidate[];
    provenance: RegressionProof[];
    nextCursor?: string;
  }>;
}

export interface MemoService {
  getLatest(): Promise<CtoMemo | null>;
  listHistory(cursor?: string, limit?: number): Promise<{ items: CtoMemo[]; nextCursor?: string }>;
}

export interface GraphService {
  impact(query: string): Promise<ImpactReport>;
  hotspots(): Promise<Array<{ ref: string; count: number }>>;
  explain(recommendationId: string): Promise<EvidencePath>;
}

export interface PerfScientistService {
  getStatus(): Promise<PerfScientistStatus>;
  listExperiments(params?: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: PerfExperiment[]; nextCursor?: string }>;
  listCandidates(params?: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: PerfCandidate[]; nextCursor?: string }>;
  listBaselines(limit?: number): Promise<PerfBaseline[]>;
  leaderboard(window?: "7d" | "30d"): Promise<
    Array<{
      candidate: PerfCandidate;
      decision: PerfDecision;
    }>
  >;
  listArtifactsByRun(runId: string): Promise<{
    run?: PerfRun;
    metrics: PerfMetric[];
    artifacts: PerfArtifact[];
  }>;
  action(candidateId: string, action: "rerun" | "open_draft_pr" | "reject" | "promote_priority"): Promise<{
    ok: boolean;
    message: string;
  }>;
}

export interface MemoryService {
  listFacts(params?: { namespace?: string; state?: string; cursor?: string; limit?: number }): Promise<{
    items: MemoryFact[];
    nextCursor?: string;
  }>;
  listEpisodes(params?: { cursor?: string; limit?: number }): Promise<{
    items: MemoryEpisode[];
    nextCursor?: string;
  }>;
}

export interface PolicyService {
  getStatus(domain?: string): Promise<PolicyStatus[]>;
  listHistory(params?: { domain?: string; cursor?: string; limit?: number }): Promise<{
    items: PolicyHistoryItem[];
    nextCursor?: string;
  }>;
  action(domain: string, action: "retrain" | "rollback" | "set_exploration_rate", value?: number): Promise<{
    ok: boolean;
    message: string;
  }>;
}

export interface RepoLearningService {
  getStatus(repoPath: string): Promise<RepoCompetenceSnapshot | null>;
  listFacts(params: { repoPath: string; factType?: string; cursor?: string; limit?: number }): Promise<{
    items: RepoLearningFact[];
    nextCursor?: string;
  }>;
}

export interface TokenEconomyService {
  getStatus(domain?: string): Promise<TokenEconomyStatus[]>;
  listUsage(params?: { domain?: string; cursor?: string; limit?: number }): Promise<{
    items: TokenUsageItem[];
    nextCursor?: string;
  }>;
  action(action: "set_budget" | "enter_economy_mode" | "exit_economy_mode", payload?: {
    domain?: string;
    softCap?: number;
    hardCap?: number;
  }): Promise<{ ok: boolean; message: string }>;
}

export interface RetrievalService {
  getStatus(): Promise<RetrievalStatus>;
  listQueries(cursor?: string, limit?: number): Promise<{ items: RetrievalQueryLog[]; nextCursor?: string }>;
  getResults(queryId: string): Promise<{ items: RetrievalResultItem[]; contextPack: RetrievalContextPack }>;
  reindex(repoPath?: string): Promise<{ ok: boolean; indexedDocuments: number }>;
  feedback(event: RetrievalFeedbackEvent): Promise<{ ok: boolean }>;
}

export interface Services {
  dashboard: DashboardService;
  runs: RunsService;
  queue: QueueService;
  audit: AuditService;
  persona: PersonaService;
  system: SystemService;
  budget: BudgetService;
  actions: ActionsService;
  portfolio: PortfolioService;
  testEvolution: TestEvolutionService;
  memos: MemoService;
  graph: GraphService;
  perfScientist: PerfScientistService;
  memory: MemoryService;
  policy: PolicyService;
  repoLearning: RepoLearningService;
  tokenEconomy: TokenEconomyService;
  retrieval: RetrievalService;
}
