import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

interface WorktreeManagerOptions {
  rootDir?: string;
  baseRef?: string;
  keepFailed?: boolean;
}

export interface WorktreeLease {
  path: string;
  branch: string;
  cleanup(success: boolean): void;
}

const slug = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : `run-${Date.now()}`;
};

const runGit = (args: string[]): { ok: boolean; stdout: string; stderr: string } => {
  const result = Bun.spawnSync(["git", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: (result.exitCode ?? 1) === 0,
    stdout: Buffer.from(result.stdout).toString("utf8").trim(),
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
  };
};

export class WorktreeManager {
  private readonly options: Required<WorktreeManagerOptions>;

  constructor(options?: WorktreeManagerOptions) {
    this.options = {
      rootDir: options?.rootDir ?? "",
      baseRef: options?.baseRef ?? "main",
      keepFailed: options?.keepFailed ?? true,
    };
  }

  acquire(repoPath: string, runId: string): WorktreeLease {
    const worktreeRoot = this.options.rootDir
      ? resolve(this.options.rootDir)
      : resolve(repoPath, ".squidward", "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    const runSlug = slug(runId);
    const branch = `codex/mission/${runSlug}`;
    const path = resolve(worktreeRoot, runSlug);

    rmSync(path, { recursive: true, force: true });
    runGit(["-C", repoPath, "worktree", "prune"]);

    const add = runGit(["-C", repoPath, "worktree", "add", "-B", branch, path, this.options.baseRef]);
    if (!add.ok) {
      throw new Error(`worktree_add_failed:${add.stderr || add.stdout || "unknown_error"}`);
    }

    return {
      path,
      branch,
      cleanup: (success: boolean) => {
        if (!success && this.options.keepFailed) {
          return;
        }
        runGit(["-C", repoPath, "worktree", "remove", "--force", path]);
        rmSync(path, { recursive: true, force: true });
      },
    };
  }
}

