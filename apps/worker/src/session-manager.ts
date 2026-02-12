export interface CodexSession {
  id: string;
  taskId: string;
  startedAt: Date;
}

export class CodexSessionManager {
  private readonly maxConcurrent: number;
  private readonly sessions = new Map<string, CodexSession>();

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  start(taskId: string): CodexSession {
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(`Cannot start session for task ${taskId}; capacity ${this.maxConcurrent} reached`);
    }

    const session: CodexSession = {
      id: crypto.randomUUID(),
      taskId,
      startedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  end(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      return;
    }
    this.sessions.delete(sessionId);
  }

  getActiveSession(): CodexSession | null {
    const first = this.sessions.values().next().value as CodexSession | undefined;
    return first ? { ...first } : null;
  }

  getActiveSessions(): CodexSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  getAvailableSlots(): number {
    return Math.max(0, this.maxConcurrent - this.sessions.size);
  }
}
