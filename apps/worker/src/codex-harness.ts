import type { Database } from "@squidward/db";

import type { CodexCliAdapter } from "./adapters";
import { buildCodexOutputContract, parseCodexPayload, type ParsedCodexPayload } from "./codex-output";
import { renderMissionPrompt, type MissionPack } from "./mission-pack";
import { recordTokenUsage } from "./token-economy";

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const shellEscapeSingle = (value: string): string => value.replace(/'/g, `'\\''`);

export interface CodexHarnessRunInput {
  missionPack: MissionPack;
  objectiveDetails: string;
  cwd: string;
  model?: string;
}

export class CodexHarness {
  constructor(
    private readonly codex: CodexCliAdapter,
    private readonly db?: Database
  ) {}

  async run(input: CodexHarnessRunInput): Promise<ParsedCodexPayload> {
    const prompt = `${renderMissionPrompt(input.missionPack, input.objectiveDetails)}\n\n${buildCodexOutputContract()}`;
    const quoted = shellEscapeSingle(prompt);
    const command = `printf '%s' '${quoted}' | codex`;

    const first = await this.codex.runCommand(command, input.cwd);
    if (first.exitCode !== 0) {
      throw new Error(`codex_command_failed:first:${first.exitCode}:${first.artifactRefs.join(" | ").slice(0, 500)}`);
    }
    const firstRaw = first.artifactRefs.length > 0 ? first.artifactRefs.join("\n") : "";
    try {
      const parsed = parseCodexPayload(firstRaw);
      this.recordUsage(input, prompt, firstRaw, input.missionPack.cache.hit);
      return parsed;
    } catch {
      const repairPrompt = [
        "Return the exact same payload but strict tagged JSON only.",
        "No markdown and no prose.",
        buildCodexOutputContract(),
      ].join("\n");
      const repairQuoted = shellEscapeSingle(`${prompt}\n\n${repairPrompt}`);
      const secondCmd = `printf '%s' '${repairQuoted}' | codex`;
      const second = await this.codex.runCommand(secondCmd, input.cwd);
      if (second.exitCode !== 0) {
        throw new Error(`codex_command_failed:repair:${second.exitCode}:${second.artifactRefs.join(" | ").slice(0, 500)}`);
      }
      const secondRaw = second.artifactRefs.length > 0 ? second.artifactRefs.join("\n") : "";
      const parsed = parseCodexPayload(secondRaw);
      this.recordUsage(input, prompt, secondRaw, input.missionPack.cache.hit);
      return parsed;
    }
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
}
