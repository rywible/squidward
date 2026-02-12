import type { Priority } from "./types";

export interface BranchNamingInput {
  title: string;
  ticketId?: string;
  workType: "bugfix" | "perf" | "ops" | "chore";
  now?: Date;
}

export interface DraftPrContext {
  priority: Priority;
  riskLevel: "low" | "medium" | "high";
  hasFailingChecks: boolean;
  isWip: boolean;
}

export function buildBranchName(input: BranchNamingInput): string {
  const now = input.now ?? new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
  ].join("");

  const ticket = input.ticketId?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "no-ticket";
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);

  return `codex/${input.workType}/${ticket}/${slug}-${timestamp}`;
}

export function shouldOpenDraftPr(context: DraftPrContext): boolean {
  if (context.isWip || context.hasFailingChecks) {
    return true;
  }
  if (context.riskLevel !== "low") {
    return true;
  }
  return context.priority === "P0";
}
