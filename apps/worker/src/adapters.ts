import { delimiter, dirname } from "node:path";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type ExecRunner = (command: string, args?: string[], options?: ExecOptions) => Promise<ExecResult>;
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SlackAdapter {
  postMessage(channel: string, text: string, options?: { threadTs?: string }): Promise<void>;
}

export interface GithubGhAdapter {
  createDraftPr(params: { title: string; body: string; head: string; base: string }): Promise<{ prNumber: number }>;
  preflightAuth(): Promise<{ ok: boolean; details: string[] }>;
}

export interface CodexCliAdapter {
  runCommand(command: string, cwd: string): Promise<{ exitCode: number; artifactRefs: string[] }>;
  preflightAvailability(): Promise<{ ok: boolean; details: string[] }>;
  preflightAuth(command?: string): Promise<{ ok: boolean; details: string[] }>;
}

export interface BraveResearchAdapter {
  search(query: string): Promise<Array<{ url: string; title: string; fetchedAt: Date }>>;
}

export interface ModelAdapter {
  complete(prompt: string): Promise<{ output: string }>;
}

const defaultExecRunner: ExecRunner = async (command, args = [], options) => {
  const proc = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: options?.env ?? process.env,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
};

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const normalizeText = (value: string): string => value.trim();
const buildRuntimeEnv = (baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const pathParts = (env.PATH ?? "")
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const prependPath = (entry?: string): void => {
    if (!entry) return;
    if (!pathParts.includes(entry)) {
      pathParts.unshift(entry);
    }
  };

  const codexPath = env.CODEX_CLI_PATH?.trim();
  if (codexPath && codexPath.includes("/")) {
    prependPath(dirname(codexPath));
  }

  const nodeBinPath = env.NODE_BIN_PATH?.trim();
  if (nodeBinPath) {
    const normalized = nodeBinPath.endsWith("/node") ? dirname(nodeBinPath) : nodeBinPath;
    prependPath(normalized);
  }

  env.PATH = pathParts.join(delimiter);
  return env;
};

export const normalizeSlackMessageInput = (channel: string, text: string): { channel: string; text: string } => ({
  channel: normalizeText(channel),
  text: normalizeText(text),
});

export const normalizeBraveSearchResults = (
  payload: unknown,
  fetchedAt: Date
): Array<{ url: string; title: string; fetchedAt: Date }> => {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const maybeWeb = (payload as { web?: { results?: Array<{ url?: string; title?: string }> } }).web;
  if (!maybeWeb?.results) {
    return [];
  }

  return maybeWeb.results
    .map((entry) => ({
      url: typeof entry.url === "string" ? entry.url : "",
      title: typeof entry.title === "string" ? entry.title : "",
      fetchedAt,
    }))
    .filter((entry) => entry.url.length > 0);
};

export const normalizeOpenAiOutput = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string") {
    return direct;
  }

  const output = (payload as { output?: unknown[] }).output;
  if (!Array.isArray(output)) {
    return "";
  }

  const textParts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const maybeText = (part as { text?: unknown }).text;
      if (typeof maybeText === "string") {
        textParts.push(maybeText);
      }
    }
  }

  return textParts.join("\n").trim();
};

export class StubSlackAdapter implements SlackAdapter {
  readonly sent: Array<{ channel: string; text: string }> = [];

  async postMessage(channel: string, text: string): Promise<void> {
    const normalized = normalizeSlackMessageInput(channel, text);
    this.sent.push(normalized);
  }
}

export class RealSlackAdapter implements SlackAdapter {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(deps?: { token?: string; fetchImpl?: FetchLike }) {
    this.token = deps?.token ?? process.env.SLACK_BOT_TOKEN ?? "";
    this.fetchImpl = deps?.fetchImpl ?? defaultFetch;
  }

  async postMessage(channel: string, text: string, options?: { threadTs?: string }): Promise<void> {
    if (!this.token) {
      throw new Error("SLACK_BOT_TOKEN is required for Slack adapter");
    }

    const normalized = normalizeSlackMessageInput(channel, text);
    const payloadBody: Record<string, string> = { channel: normalized.channel, text: normalized.text };
    if (options?.threadTs) {
      payloadBody.thread_ts = options.threadTs;
    }
    const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payloadBody),
    });

    const payload = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || payload.ok !== true) {
      throw new Error(`Slack chat.postMessage failed: ${payload.error ?? response.statusText}`);
    }
  }
}

export class StubGithubGhAdapter implements GithubGhAdapter {
  private nextPr = 1;

  async createDraftPr(_: { title: string; body: string; head: string; base: string }): Promise<{ prNumber: number }> {
    const prNumber = this.nextPr;
    this.nextPr += 1;
    return { prNumber };
  }

  async preflightAuth(): Promise<{ ok: boolean; details: string[] }> {
    return { ok: true, details: ["stubbed gh auth"] };
  }
}

export class RealGithubGhAdapter implements GithubGhAdapter {
  private readonly execRunner: ExecRunner;

  constructor(deps?: { execRunner?: ExecRunner }) {
    this.execRunner = deps?.execRunner ?? defaultExecRunner;
  }

  async createDraftPr(params: { title: string; body: string; head: string; base: string }): Promise<{ prNumber: number }> {
    const title = normalizeText(params.title);
    const body = params.body.trim();
    const head = normalizeText(params.head);
    const base = normalizeText(params.base);

    const result = await this.execRunner("gh", [
      "pr",
      "create",
      "--draft",
      "--title",
      title,
      "--body",
      body,
      "--head",
      head,
      "--base",
      base,
      "--json",
      "number",
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`gh pr create failed: ${result.stderr || result.stdout}`);
    }

    let parsed: { number?: unknown };
    try {
      parsed = JSON.parse(result.stdout) as { number?: unknown };
    } catch {
      throw new Error(`gh pr create returned invalid JSON: ${result.stdout}`);
    }

    const prNumber = Number(parsed.number);
    if (!Number.isFinite(prNumber)) {
      throw new Error(`gh pr create missing PR number: ${result.stdout}`);
    }

    return { prNumber };
  }

  async preflightAuth(): Promise<{ ok: boolean; details: string[] }> {
    const result = await this.execRunner("gh", ["auth", "status"]);
    return {
      ok: result.exitCode === 0,
      details: [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0),
    };
  }
}

export class StubCodexCliAdapter implements CodexCliAdapter {
  readonly calls: Array<{ command: string; cwd: string }> = [];

  async runCommand(command: string, cwd: string): Promise<{ exitCode: number; artifactRefs: string[] }> {
    this.calls.push({ command, cwd });
    return { exitCode: 0, artifactRefs: [] };
  }

  async preflightAvailability(): Promise<{ ok: boolean; details: string[] }> {
    return { ok: true, details: ["stubbed codex --version"] };
  }

  async preflightAuth(command?: string): Promise<{ ok: boolean; details: string[] }> {
    return {
      ok: true,
      details: command ? [`stubbed ${command}`] : ["stubbed codex auth preflight"],
    };
  }
}

export class RealCodexCliAdapter implements CodexCliAdapter {
  private readonly execRunner: ExecRunner;
  private readonly codexBin: string;
  private readonly runtimeEnv: NodeJS.ProcessEnv;

  constructor(deps?: { execRunner?: ExecRunner }) {
    this.execRunner = deps?.execRunner ?? defaultExecRunner;
    this.codexBin = process.env.CODEX_CLI_PATH?.trim() || "codex";
    this.runtimeEnv = buildRuntimeEnv(process.env);
  }

  async runCommand(command: string, cwd: string): Promise<{ exitCode: number; artifactRefs: string[] }> {
    const result = await this.execRunner("bash", ["-lc", command], { cwd, env: this.runtimeEnv });

    return {
      exitCode: result.exitCode,
      artifactRefs: [result.stdout, result.stderr].filter((part) => part.length > 0),
    };
  }

  async preflightAvailability(): Promise<{ ok: boolean; details: string[] }> {
    const result = await this.execRunner(this.codexBin, ["--version"], { env: this.runtimeEnv });
    return {
      ok: result.exitCode === 0,
      details: [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0),
    };
  }

  async preflightAuth(command?: string): Promise<{ ok: boolean; details: string[] }> {
    if (!command) {
      return {
        ok: true,
        details: ["codex auth preflight skipped (no command configured)"],
      };
    }

    const result = await this.execRunner("bash", ["-lc", command], { env: this.runtimeEnv });
    return {
      ok: result.exitCode === 0,
      details: [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0),
    };
  }
}

export class StubBraveResearchAdapter implements BraveResearchAdapter {
  async search(query: string): Promise<Array<{ url: string; title: string; fetchedAt: Date }>> {
    return [
      {
        url: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
        title: `Stub result for ${query}`,
        fetchedAt: new Date(),
      },
    ];
  }
}

export class RealBraveResearchAdapter implements BraveResearchAdapter {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(deps?: { apiKey?: string; fetchImpl?: FetchLike }) {
    this.apiKey = deps?.apiKey ?? process.env.BRAVE_API_KEY ?? "";
    this.fetchImpl = deps?.fetchImpl ?? defaultFetch;
  }

  async search(query: string): Promise<Array<{ url: string; title: string; fetchedAt: Date }>> {
    if (!this.apiKey) {
      throw new Error("BRAVE_API_KEY is required for Brave adapter");
    }

    const q = normalizeText(query);
    const fetchedAt = new Date();
    const response = await this.fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave search failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    return normalizeBraveSearchResults(payload, fetchedAt);
  }
}

export class StubModelAdapter implements ModelAdapter {
  async complete(prompt: string): Promise<{ output: string }> {
    return { output: `stubbed: ${prompt}` };
  }
}

export class RealOpenAIModelAdapter implements ModelAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(deps?: { apiKey?: string; model?: string; fetchImpl?: FetchLike }) {
    this.apiKey = deps?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = deps?.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.fetchImpl = deps?.fetchImpl ?? defaultFetch;
  }

  async complete(prompt: string): Promise<{ output: string }> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI model adapter");
    }

    const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: normalizeText(prompt),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI responses call failed: ${response.status} ${errorText}`);
    }

    const payload = (await response.json()) as unknown;
    return { output: normalizeOpenAiOutput(payload) };
  }
}
