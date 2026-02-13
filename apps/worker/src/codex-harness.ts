import type { Database } from "@squidward/db";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { CodexCliAdapter } from "./adapters";
import { buildCodexOutputContract, parseCodexPayload, type ParsedCodexPayload } from "./codex-output";
import { renderMissionPrompt, type MissionPack } from "./mission-pack";
import { recordTokenUsage } from "./token-economy";

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const shellEscapeSingle = (value: string): string => value.replace(/'/g, `'\\''`);
const codexCliPath = (): string => process.env.CODEX_CLI_PATH?.trim() || "codex";
const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const codexMissionMaxAttempts = (): number => {
  const parsed = Number(process.env.CODEX_MISSION_MAX_ATTEMPTS ?? 3);
  return Math.max(1, Math.min(5, Number.isFinite(parsed) ? parsed : 3));
};
const codexMissionRetryBaseMs = (): number => {
  const parsed = Number(process.env.CODEX_MISSION_RETRY_BASE_MS ?? 1200);
  return Math.max(100, Math.min(10_000, Number.isFinite(parsed) ? parsed : 1200));
};
const isTransientCodexFailure = (detail: string): boolean =>
  /reconnecting|stream disconnected|connection reset|econnreset|etimedout|timed out|timeout|temporarily unavailable|network error|socket hang up|429|rate limit/i.test(
    detail
  );
const buildCommandCandidates = (codexCmdQuoted: string, promptQuoted: string, promptFileQuoted: string): string[] => {
  const template = process.env.CODEX_MISSION_COMMAND_TEMPLATE?.trim();
  if (template) {
    return [
      template
        .replaceAll("{codex}", codexCmdQuoted)
        .replaceAll("{prompt}", `'${promptQuoted}'`)
        .replaceAll("{prompt_file}", `'${promptFileQuoted}'`),
    ];
  }

  return [
    `'${codexCmdQuoted}' exec --json '${promptQuoted}'`,
    `'${codexCmdQuoted}' exec --json "$(cat '${promptFileQuoted}')"`,
    `'${codexCmdQuoted}' exec '${promptQuoted}'`,
    `printf '%s' '${promptQuoted}' | '${codexCmdQuoted}'`,
  ];
};

export interface CodexHarnessRunInput {
  missionPack: MissionPack;
  objectiveDetails: string;
  cwd: string;
  model?: string;
}

export interface CodexChatReplyInput {
  missionPack: MissionPack;
  objectiveDetails: string;
  cwd: string;
  model?: string;
}

export interface CodexChatReplyResult {
  text: string;
  raw: string;
  contextHash: string;
}

export class CodexHarness {
  constructor(
    private readonly codex: CodexCliAdapter,
    private readonly db?: Database
  ) {}

  async run(input: CodexHarnessRunInput): Promise<ParsedCodexPayload> {
    const prompt = `${renderMissionPrompt(input.missionPack, input.objectiveDetails)}\n\n${buildCodexOutputContract()}`;
    const quoted = shellEscapeSingle(prompt);
    const codexCmd = shellEscapeSingle(codexCliPath());
    const tmp = mkdtempSync(join(tmpdir(), "sq-codex-"));
    try {
      const promptFile = join(tmp, "mission-prompt.txt");
      writeFileSync(promptFile, prompt, "utf8");
      const promptFileQuoted = shellEscapeSingle(promptFile);
      const firstCandidates = buildCommandCandidates(codexCmd, quoted, promptFileQuoted);
      const first = await this.runWithRetries(firstCandidates, input.cwd, "first");
      const firstRaw = first.artifactRefs.length > 0 ? first.artifactRefs.join("\n") : "";
      try {
        const parsed = parseCodexPayload(firstRaw);
        this.recordUsage(input, prompt, firstRaw, input.missionPack.cache.hit);
        return parsed;
      } catch {
        const repairPrompt = [
          "CRITICAL RETRY: your previous response violated output contract.",
          "Return ONLY strict tagged JSON payload.",
          "Do NOT return wrappers like output_text/content/message.",
          "Do NOT return prose, markdown, analysis, logs, or code fences.",
          "If you cannot complete the task, return schema-valid payload with status='blocked'.",
          buildCodexOutputContract(),
        ].join("\n");
        const repairFullPrompt = `${prompt}\n\n${repairPrompt}`;
        const repairQuoted = shellEscapeSingle(repairFullPrompt);
        const repairFile = join(tmp, "mission-repair-prompt.txt");
        writeFileSync(repairFile, repairFullPrompt, "utf8");
        const repairFileQuoted = shellEscapeSingle(repairFile);
        const secondCandidates = buildCommandCandidates(codexCmd, repairQuoted, repairFileQuoted);
        const second = await this.runWithRetries(secondCandidates, input.cwd, "repair");
        const secondRaw = second.artifactRefs.length > 0 ? second.artifactRefs.join("\n") : "";
        this.recordUsage(input, prompt, secondRaw, input.missionPack.cache.hit);
        try {
          const parsed = parseCodexPayload(secondRaw);
          return parsed;
        } catch {
          return this.coercePayloadFromRaw(secondRaw);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async runChatReply(input: CodexChatReplyInput): Promise<CodexChatReplyResult> {
    const prompt = this.renderChatPrompt(input.missionPack, input.objectiveDetails);
    const quoted = shellEscapeSingle(prompt);
    const codexCmd = shellEscapeSingle(codexCliPath());
    const tmp = mkdtempSync(join(tmpdir(), "sq-codex-chat-"));
    try {
      const promptFile = join(tmp, "chat-prompt.txt");
      writeFileSync(promptFile, prompt, "utf8");
      const promptFileQuoted = shellEscapeSingle(promptFile);
      const candidates = [
        `'${codexCmd}' exec --json '${quoted}'`,
        `'${codexCmd}' exec --json "$(cat '${promptFileQuoted}')"`,
        `'${codexCmd}' exec '${quoted}'`,
      ];
      const first = await this.runWithRetries(candidates, input.cwd, "first");
      const raw = first.artifactRefs.length > 0 ? first.artifactRefs.join("\n") : "";
      const text = this.extractChatReplyText(raw);
      this.recordUsageForPack(input.missionPack, input.model, prompt, raw, input.missionPack.cache.hit);
      return {
        text,
        raw,
        contextHash: createHash("sha256").update(raw).digest("hex"),
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async runFirstSuccessful(
    commands: string[],
    cwd: string,
    stage: "first" | "repair"
  ): Promise<{ exitCode: number; artifactRefs: string[] }> {
    let lastFailure = "no_command_attempted";
    for (const command of commands) {
      const result = await this.codex.runCommand(command, cwd);
      if (result.exitCode === 0) {
        return result;
      }
      const detail = result.artifactRefs.join(" | ").slice(0, 300);
      lastFailure = `${result.exitCode}:${detail}`;
      if (!/stdin is not a terminal|unknown option|unknown command|unrecognized option/i.test(detail)) {
        break;
      }
    }
    throw new Error(`codex_command_failed:${stage}:${lastFailure}`);
  }

  private async runWithRetries(
    commands: string[],
    cwd: string,
    stage: "first" | "repair"
  ): Promise<{ exitCode: number; artifactRefs: string[] }> {
    const maxAttempts = codexMissionMaxAttempts();
    const baseDelayMs = codexMissionRetryBaseMs();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runFirstSuccessful(commands, cwd, stage);
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error));
        lastError = asError;
        const message = asError.message;
        const shouldRetry = attempt < maxAttempts && isTransientCodexFailure(message);
        if (!shouldRetry) {
          throw asError;
        }
        const backoffMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 15_000);
        await sleep(backoffMs);
      }
    }

    throw lastError ?? new Error(`codex_command_failed:${stage}:unknown`);
  }

  private recordUsage(input: CodexHarnessRunInput, prompt: string, output: string, cacheHit: boolean): void {
    this.recordUsageForPack(input.missionPack, input.model, prompt, output, cacheHit);
  }

  private recordUsageForPack(
    missionPack: MissionPack,
    model: string | undefined,
    prompt: string,
    output: string,
    cacheHit: boolean
  ): void {
    recordTokenUsage(this.db, {
      runId: missionPack.runId,
      domain: missionPack.tokenEnvelope.domain,
      model: model ?? "codex-cli",
      inputTokens: Math.min(estimateTokens(prompt), missionPack.tokenEnvelope.maxInputTokens),
      outputTokens: Math.min(estimateTokens(output), missionPack.tokenEnvelope.maxOutputTokens),
      cacheHit,
      costEstimate: 0,
    });
  }

  private renderChatPrompt(pack: MissionPack, objectiveDetails: string): string {
    const skills =
      pack.context.selectedSkills.length === 0
        ? "- none"
        : pack.context.selectedSkills.map((skill) => `- ${skill.title}: ${skill.reason}`).join("\n");
    const canonical = pack.context.canonicalFacts.slice(0, 8).map((fact) => ({
      key: fact.key,
      value: fact.value,
      source: fact.source,
    }));
    const repoFacts = pack.context.repoLearningFacts.slice(0, 8).map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
    }));
    const evidence = pack.context.evidenceSnippets.slice(0, 6).map((item) => ({
      citation: item.citation,
      text: item.text,
    }));
    const episodes = pack.context.recentEpisodes.slice(0, 4);

    return [
      "You are Squidward, a direct and helpful engineering manager assistant.",
      "Reply to the user message in plain text only.",
      "Do not mention draft/prepared/planning language.",
      "Do not return JSON, markdown fences, or diagnostics.",
      "Keep it concise unless the user asks for detail.",
      "",
      `Run id: ${pack.runId}`,
      `Repo: ${pack.repoPath}`,
      `Objective: ${pack.objective}`,
      `User message: ${objectiveDetails}`,
      "",
      "Selected skills:",
      skills,
      "",
      "Canonical memory:",
      JSON.stringify(canonical),
      "",
      "Repo learning:",
      JSON.stringify(repoFacts),
      "",
      "Recent episodes:",
      JSON.stringify(episodes),
      "",
      "Evidence snippets:",
      JSON.stringify(evidence),
    ].join("\n");
  }

  private extractChatReplyText(raw: string): string {
    try {
      const tagged = parseCodexPayload(raw);
      if (tagged.payload.summary.trim().length > 0) {
        return tagged.payload.summary.trim();
      }
    } catch {
      // Continue with line-level extraction for plain chat output.
    }

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const agentMessages: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          item?: { type?: string; text?: string };
          text?: string;
          output_text?: string;
        };
        if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text) {
          agentMessages.push(parsed.item.text.trim());
          continue;
        }
        if (typeof parsed.output_text === "string" && parsed.output_text.trim().length > 0) {
          agentMessages.push(parsed.output_text.trim());
          continue;
        }
        if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
          agentMessages.push(parsed.text.trim());
        }
      } catch {
        // Ignore line-level parse failures and continue scanning.
      }
    }

    if (agentMessages.length > 0) {
      const last = agentMessages.at(-1);
      if (last && last.length > 0) {
        return last;
      }
    }

    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 1200);
    }
    return "I ran into an issue responding. Try again.";
  }

  private coercePayloadFromRaw(raw: string): ParsedCodexPayload {
    const normalized = raw.trim();
    const summary =
      normalized.length > 0
        ? `Codex response could not be parsed into agent payload. Raw excerpt: ${normalized.slice(0, 360)}`
        : "Codex response was empty or unparsable.";
    const payload = {
      status: "blocked" as const,
      summary,
      actionsTaken: [
        {
          kind: "analysis" as const,
          detail: "Captured raw codex output for review and returned blocked status.",
          evidenceRefs: [],
        },
      ],
      proposedChanges: {
        files: [],
        estimatedLoc: 0,
        risk: "medium" as const,
      },
      memoryProposals: [],
      nextSteps: ["Inspect codex output format and adjust CODEX_MISSION_COMMAND_TEMPLATE if needed."],
    };
    return {
      payload,
      rawJson: normalized,
      contextHash: createHash("sha256").update(normalized).digest("hex"),
    };
  }
}
