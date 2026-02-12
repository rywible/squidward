import type { WorkerDb } from "./db";
import type { CodexCliAdapter } from "./adapters";

export class CommandAuditService {
  constructor(private readonly db: WorkerDb, private readonly codexCli: CodexCliAdapter) {}

  async runWithAudit(runId: string, command: string, cwd: string): Promise<{ exitCode: number; artifactRefs: string[] }> {
    const startedAt = new Date();
    const result = await this.codexCli.runCommand(command, cwd);
    const finishedAt = new Date();

    await this.db.appendCommandAudit({
      id: crypto.randomUUID(),
      runId,
      command,
      cwd,
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      artifactRefs: result.artifactRefs,
    });

    return result;
  }
}
