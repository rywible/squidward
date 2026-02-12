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
  timeoutMs?: number;
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
      const first = await this.runFirstSuccessful(firstCandidates, input.cwd, "first", input.timeoutMs);
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
        const second = await this.runFirstSuccessful(secondCandidates, input.cwd, "repair", input.timeoutMs);
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

  private async runFirstSuccessful(
    commands: string[],
    cwd: string,
    stage: "first" | "repair",
    timeoutMs?: number
  ): Promise<{ exitCode: number; artifactRefs: string[] }> {
    let lastFailure = "no_command_attempted";
    for (const command of commands) {
      const result = await this.codex.runCommand(command, cwd, { timeoutMs });
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

  private recordUsage(input: CodexHarnessRunInput, prompt: string, output: string, cacheHit: boolean): void {
    recordTokenUsage(this.db, {
      runId: input.missionPack.runId,
      domain: input.missionPack.tokenEnvelope.domain,
      model: input.model ?? "codex-cli",
      inputTokens: Math.min(estimateTokens(prompt), input.missionPack.tokenEnvelope.maxInputTokens),
      outputTokens: Math.min(estimateTokens(output), input.missionPack.tokenEnvelope.maxOutputTokens),
      cacheHit,
      costEstimate: 0,
    });
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
