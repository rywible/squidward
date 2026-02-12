export interface CodexSession {
  id: string;
  taskId: string;
  startedAt: Date;
}

export class SingleCodexSessionManager {
  private activeSession: CodexSession | null = null;

  start(taskId: string): CodexSession {
    if (this.activeSession) {
      throw new Error(`Cannot start session for task ${taskId}; active session ${this.activeSession.id} already exists`);
    }

    const session: CodexSession = {
      id: crypto.randomUUID(),
      taskId,
      startedAt: new Date(),
    };
    this.activeSession = session;
    return session;
  }

  end(sessionId: string): void {
    if (!this.activeSession) {
      return;
    }
    if (this.activeSession.id !== sessionId) {
      throw new Error(`Cannot end session ${sessionId}; active session is ${this.activeSession.id}`);
    }
    this.activeSession = null;
  }

  getActiveSession(): CodexSession | null {
    return this.activeSession ? { ...this.activeSession } : null;
  }
}
