import type {
  ActionResult,
  AutonomyDecision,
  AutonomyFunnel,
  AutonomyStatus,
  AuditEntry,
  CtoMemo,
  Conversation,
  ConversationMessage,
  ConversationRun,
  ConversationState,
  EvidencePath,
  GraphImpactReport,
  PerfArtifact,
  PerfBaseline,
  PerfCandidate,
  PerfDecision,
  PerfExperiment,
  PerfMetric,
  PerfRun,
  PerfScientistStatus,
  MemoryEpisode,
  MemoryFact,
  MemoHistoryResponse,
  PolicyStatus,
  RepoCompetenceSnapshot,
  RepoLearningFact,
  CockpitSnapshot,
  PersonaTrait,
  PortfolioCandidate,
  PortfolioHistoryResponse,
  QueueTask,
  RetrievalContextPack,
  RetrievalQueryLog,
  RetrievalResultItem,
  RetrievalStatus,
  TestEvolutionCandidatesResponse,
  TestEvolutionStats,
  RunActionRequest,
  RunSummary,
  SystemOverview,
  TokenEconomyStatus,
  TokenUsageItem,
  TaskAction,
} from '../types/dashboard';

export class DashboardApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getCockpit(signal?: AbortSignal): Promise<CockpitSnapshot> {
    return this.get<CockpitSnapshot>('/dashboard/cockpit', signal);
  }

  async getRuns(signal?: AbortSignal): Promise<RunSummary[]> {
    return this.get<RunSummary[]>('/dashboard/runs', signal);
  }

  async getQueue(signal?: AbortSignal): Promise<QueueTask[]> {
    return this.get<QueueTask[]>('/dashboard/queue', signal);
  }

  async getAudit(signal?: AbortSignal): Promise<AuditEntry[]> {
    return this.get<AuditEntry[]>('/dashboard/audit', signal);
  }

  async getPersona(signal?: AbortSignal): Promise<PersonaTrait[]> {
    return this.get<PersonaTrait[]>('/dashboard/persona', signal);
  }

  async getSystem(signal?: AbortSignal): Promise<SystemOverview> {
    return this.get<SystemOverview>('/dashboard/system', signal);
  }

  async runAction(runId: string, action: TaskAction): Promise<ActionResult> {
    return this.post<ActionResult, RunActionRequest>(`/dashboard/runs/${runId}/actions`, { action });
  }

  async taskAction(taskId: string, action: TaskAction): Promise<ActionResult> {
    return this.post<ActionResult, RunActionRequest>(`/dashboard/tasks/${taskId}/actions`, { action });
  }

  async pauseWorker(): Promise<ActionResult> {
    return this.post<ActionResult, Record<string, never>>('/actions/pause', {});
  }

  async resumeWorker(): Promise<ActionResult> {
    return this.post<ActionResult, Record<string, never>>('/actions/resume', {});
  }

  async getPortfolioTop(limit = 5): Promise<PortfolioCandidate[]> {
    return this.get<PortfolioCandidate[]>(`/portfolio/top?limit=${limit}`);
  }

  async getAutonomyFunnel(window: '24h' | '7d' = '24h'): Promise<AutonomyFunnel> {
    return this.get<AutonomyFunnel>(`/autonomy/funnel?window=${window}`);
  }

  async getAutonomyStatus(): Promise<AutonomyStatus> {
    return this.get<AutonomyStatus>('/autonomy/status');
  }

  async getAutonomyDecisions(cursor?: string, limit = 25): Promise<{ items: AutonomyDecision[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    search.set('limit', String(limit));
    if (cursor) search.set('cursor', cursor);
    return this.get<{ items: AutonomyDecision[]; nextCursor?: string }>(`/autonomy/decisions?${search.toString()}`);
  }

  async getPortfolioHistory(cursor?: string, limit = 25): Promise<PortfolioHistoryResponse> {
    const search = new URLSearchParams();
    search.set('limit', String(limit));
    if (cursor) search.set('cursor', cursor);
    return this.get<PortfolioHistoryResponse>(`/portfolio/history?${search.toString()}`);
  }

  async getTestEvolutionStats(): Promise<TestEvolutionStats> {
    return this.get<TestEvolutionStats>('/tests/evolution/stats');
  }

  async getTestEvolutionCandidates(status?: string, cursor?: string): Promise<TestEvolutionCandidatesResponse> {
    const search = new URLSearchParams();
    if (status) search.set('status', status);
    if (cursor) search.set('cursor', cursor);
    return this.get<TestEvolutionCandidatesResponse>(`/tests/evolution/candidates?${search.toString()}`);
  }

  async getLatestMemo(): Promise<CtoMemo | null> {
    return this.get<CtoMemo | null>('/memos/latest');
  }

  async getMemoHistory(cursor?: string, limit = 10): Promise<MemoHistoryResponse> {
    const search = new URLSearchParams();
    search.set('limit', String(limit));
    if (cursor) search.set('cursor', cursor);
    return this.get<MemoHistoryResponse>(`/memos/history?${search.toString()}`);
  }

  async graphImpact(query: string): Promise<GraphImpactReport> {
    return this.post<GraphImpactReport, { query: string }>('/graph/impact', { query });
  }

  async graphHotspots(): Promise<Array<{ ref: string; count: number }>> {
    return this.get<Array<{ ref: string; count: number }>>('/graph/hotspots');
  }

  async graphExplain(recommendationId: string): Promise<EvidencePath> {
    return this.get<EvidencePath>(`/graph/explain/${recommendationId}`);
  }

  async getPerfScientistStatus(): Promise<PerfScientistStatus> {
    return this.get<PerfScientistStatus>('/perf-scientist/status');
  }

  async getPerfScientistExperiments(cursor?: string, status?: string): Promise<{ items: PerfExperiment[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    if (cursor) search.set('cursor', cursor);
    if (status) search.set('status', status);
    return this.get<{ items: PerfExperiment[]; nextCursor?: string }>(`/perf-scientist/experiments?${search.toString()}`);
  }

  async getPerfScientistCandidates(cursor?: string, status?: string): Promise<{ items: PerfCandidate[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    if (cursor) search.set('cursor', cursor);
    if (status) search.set('status', status);
    return this.get<{ items: PerfCandidate[]; nextCursor?: string }>(`/perf-scientist/candidates?${search.toString()}`);
  }

  async getPerfScientistBaselines(limit = 10): Promise<PerfBaseline[]> {
    return this.get<PerfBaseline[]>(`/perf-scientist/baselines?limit=${limit}`);
  }

  async getPerfScientistLeaderboard(window: '7d' | '30d' = '7d'): Promise<
    Array<{ candidate: PerfCandidate; decision: PerfDecision }>
  > {
    return this.get<Array<{ candidate: PerfCandidate; decision: PerfDecision }>>(`/perf-scientist/leaderboard?window=${window}`);
  }

  async getPerfScientistArtifacts(runId: string): Promise<{ run?: PerfRun; metrics: PerfMetric[]; artifacts: PerfArtifact[] }> {
    return this.get<{ run?: PerfRun; metrics: PerfMetric[]; artifacts: PerfArtifact[] }>(`/perf-scientist/artifacts/${runId}`);
  }

  async perfScientistAction(
    candidateId: string,
    action: 'rerun' | 'open_draft_pr' | 'reject' | 'promote_priority'
  ): Promise<{ ok: boolean; message: string }> {
    return this.post<{ ok: boolean; message: string }, { action: string }>(
      `/perf-scientist/actions/${candidateId}`,
      { action }
    );
  }

  async getMemoryFacts(cursor?: string, namespace?: string): Promise<{ items: MemoryFact[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    if (cursor) search.set('cursor', cursor);
    if (namespace) search.set('namespace', namespace);
    return this.get<{ items: MemoryFact[]; nextCursor?: string }>(`/memory/facts?${search.toString()}`);
  }

  async getMemoryEpisodes(cursor?: string): Promise<{ items: MemoryEpisode[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    if (cursor) search.set('cursor', cursor);
    return this.get<{ items: MemoryEpisode[]; nextCursor?: string }>(`/memory/episodes?${search.toString()}`);
  }

  async getPolicyStatus(domain?: string): Promise<PolicyStatus[]> {
    const search = new URLSearchParams();
    if (domain) search.set('domain', domain);
    return this.get<PolicyStatus[]>(`/policy/status?${search.toString()}`);
  }

  async policyAction(
    domain: string,
    action: 'retrain' | 'rollback' | 'set_exploration_rate',
    value?: number,
  ): Promise<{ ok: boolean; message: string }> {
    return this.post<{ ok: boolean; message: string }, { action: string; value?: number }>(
      `/policy/actions/${encodeURIComponent(domain)}`,
      { action, value },
    );
  }

  async getRepoLearningStatus(repoPath?: string): Promise<RepoCompetenceSnapshot | null> {
    const search = new URLSearchParams();
    if (repoPath) search.set('repoPath', repoPath);
    return this.get<RepoCompetenceSnapshot | null>(`/repo-learning/status?${search.toString()}`);
  }

  async getRepoLearningFacts(repoPath?: string, cursor?: string): Promise<{ items: RepoLearningFact[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    if (repoPath) search.set('repoPath', repoPath);
    if (cursor) search.set('cursor', cursor);
    return this.get<{ items: RepoLearningFact[]; nextCursor?: string }>(`/repo-learning/facts?${search.toString()}`);
  }

  async getTokenEconomyStatus(domain?: string): Promise<TokenEconomyStatus[]> {
    const search = new URLSearchParams();
    if (domain) search.set('domain', domain);
    return this.get<TokenEconomyStatus[]>(`/token-economy/status?${search.toString()}`);
  }

  async getTokenEconomyUsage(domain?: string, cursor?: string): Promise<{ items: TokenUsageItem[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    if (domain) search.set('domain', domain);
    if (cursor) search.set('cursor', cursor);
    return this.get<{ items: TokenUsageItem[]; nextCursor?: string }>(`/token-economy/usage?${search.toString()}`);
  }

  async tokenEconomyAction(
    action: 'set_budget' | 'enter_economy_mode' | 'exit_economy_mode',
    payload?: { domain?: string; softCap?: number; hardCap?: number },
  ): Promise<{ ok: boolean; message: string }> {
    return this.post<{ ok: boolean; message: string }, { action: string; domain?: string; softCap?: number; hardCap?: number }>(
      '/token-economy/actions',
      {
        action,
        domain: payload?.domain,
        softCap: payload?.softCap,
        hardCap: payload?.hardCap,
      },
    );
  }

  async getRetrievalStatus(): Promise<RetrievalStatus> {
    return this.get<RetrievalStatus>('/retrieval/status');
  }

  async getRetrievalQueries(cursor?: string, limit = 25): Promise<{ items: RetrievalQueryLog[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    search.set('limit', String(limit));
    if (cursor) search.set('cursor', cursor);
    return this.get<{ items: RetrievalQueryLog[]; nextCursor?: string }>(`/retrieval/queries?${search.toString()}`);
  }

  async getRetrievalResults(queryId: string): Promise<{ items: RetrievalResultItem[]; contextPack: RetrievalContextPack }> {
    return this.get<{ items: RetrievalResultItem[]; contextPack: RetrievalContextPack }>(
      `/retrieval/results/${encodeURIComponent(queryId)}`
    );
  }

  async postRetrievalFeedback(payload: {
    queryId: string;
    runId?: string;
    feedbackType: 'helpful' | 'missed-context' | 'wrong-priority';
    notes?: string;
  }): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }, typeof payload>('/retrieval/feedback', payload);
  }

  async getConversations(cursor?: string, limit = 30): Promise<{ items: Conversation[]; nextCursor?: string }> {
    const search = new URLSearchParams();
    search.set('limit', String(limit));
    if (cursor) search.set('cursor', cursor);
    return this.get<{ items: Conversation[]; nextCursor?: string }>(`/chat/conversations?${search.toString()}`);
  }

  async createConversation(title?: string): Promise<Conversation> {
    return this.post<Conversation, { title?: string }>('/chat/conversations', { title });
  }

  async getConversation(conversationId: string): Promise<{
    conversation: Conversation;
    state: ConversationState | null;
    messages: ConversationMessage[];
  }> {
    return this.get<{
      conversation: Conversation;
      state: ConversationState | null;
      messages: ConversationMessage[];
    }>(`/chat/conversations/${encodeURIComponent(conversationId)}`);
  }

  async sendConversationMessage(input: {
    conversationId: string;
    content: string;
    mode?: 'chat' | 'mission';
    repoPath?: string;
  }): Promise<{
    conversation: Conversation;
    userMessage: ConversationMessage;
    assistantMessage: ConversationMessage;
    run: ConversationRun;
  }> {
    return this.post<
      {
        conversation: Conversation;
        userMessage: ConversationMessage;
        assistantMessage: ConversationMessage;
        run: ConversationRun;
      },
      { content: string; mode?: 'chat' | 'mission'; repoPath?: string }
    >(`/chat/conversations/${encodeURIComponent(input.conversationId)}/messages`, {
      content: input.content,
      mode: input.mode,
      repoPath: input.repoPath,
    });
  }

  async compactConversation(conversationId: string): Promise<{ ok: boolean; summaryText: string }> {
    return this.post<{ ok: boolean; summaryText: string }, Record<string, never>>(
      `/chat/conversations/${encodeURIComponent(conversationId)}/compact`,
      {},
    );
  }

  async getConversationRuns(conversationId: string): Promise<{ items: ConversationRun[] }> {
    return this.get<{ items: ConversationRun[] }>(`/chat/conversations/${encodeURIComponent(conversationId)}/runs`);
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { signal });
    return this.handleResponse<T>(response);
  }

  private async post<T, U>(path: string, body: U): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    return this.handleResponse<T>(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed (${response.status})`);
    }

    return (await response.json()) as T;
  }
}

export const dashboardApiClient = new DashboardApiClient();
