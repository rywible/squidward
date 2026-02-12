import { describe, expect, it } from "bun:test";
import {
  RealBraveResearchAdapter,
  RealCodexCliAdapter,
  RealGithubGhAdapter,
  RealOpenAIModelAdapter,
  RealSlackAdapter,
  normalizeBraveSearchResults,
  normalizeOpenAiOutput,
  normalizeSlackMessageInput,
  type ExecRunner,
  type FetchLike,
} from "../src/adapters";

describe("adapter normalization", () => {
  it("normalizes Slack message input", () => {
    const normalized = normalizeSlackMessageInput("  #ops  ", "  deployed  ");
    expect(normalized).toEqual({ channel: "#ops", text: "deployed" });
  });

  it("normalizes Brave search payload", () => {
    const fetchedAt = new Date("2026-02-12T10:00:00.000Z");
    const normalized = normalizeBraveSearchResults(
      {
        web: {
          results: [
            { url: "https://example.com/a", title: "A" },
            { title: "Missing URL" },
          ],
        },
      },
      fetchedAt
    );

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual({
      url: "https://example.com/a",
      title: "A",
      fetchedAt,
    });
  });

  it("normalizes OpenAI output_text and nested content", () => {
    expect(normalizeOpenAiOutput({ output_text: "direct" })).toBe("direct");

    const nested = normalizeOpenAiOutput({
      output: [{ content: [{ text: "line1" }, { text: "line2" }] }],
    });

    expect(nested).toBe("line1\nline2");
  });
});

describe("real adapters with injected mocks", () => {
  it("calls Slack chat.postMessage", async () => {
    let requestUrl = "";
    let requestBody = "";
    const fetchImpl: FetchLike = async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const adapter = new RealSlackAdapter({ token: "xoxb-test", fetchImpl });
    await adapter.postMessage("  #eng  ", "  hello team  ");

    expect(requestUrl).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(requestBody)).toEqual({ channel: "#eng", text: "hello team" });
  });

  it("creates draft PR via gh", async () => {
    let argsSeen: string[] = [];
    const execRunner: ExecRunner = async (_command, args = []) => {
      argsSeen = args;
      return { exitCode: 0, stdout: JSON.stringify({ number: 42 }), stderr: "" };
    };

    const adapter = new RealGithubGhAdapter({ execRunner });
    const result = await adapter.createDraftPr({
      title: "  Add worker adapter  ",
      body: "body",
      head: "  codex/feature  ",
      base: "  main ",
    });

    expect(result).toEqual({ prNumber: 42 });
    expect(argsSeen).toEqual([
      "pr",
      "create",
      "--draft",
      "--title",
      "Add worker adapter",
      "--body",
      "body",
      "--head",
      "codex/feature",
      "--base",
      "main",
      "--json",
      "number",
    ]);
  });

  it("reports gh auth preflight", async () => {
    const execRunner: ExecRunner = async () => ({
      exitCode: 0,
      stdout: "Logged in",
      stderr: "",
    });

    const adapter = new RealGithubGhAdapter({ execRunner });
    const result = await adapter.preflightAuth();
    expect(result.ok).toBe(true);
    expect(result.details).toContain("Logged in");
  });

  it("runs codex availability and optional auth preflight", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const execRunner: ExecRunner = async (command, args = []) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const adapter = new RealCodexCliAdapter({ execRunner });
    const availability = await adapter.preflightAvailability();
    const auth = await adapter.preflightAuth("codex auth status");

    expect(availability.ok).toBe(true);
    expect(auth.ok).toBe(true);
    expect(calls).toEqual([
      { command: "codex", args: ["--version"] },
      { command: "bash", args: ["-lc", "codex auth status"] },
    ]);
  });

  it("calls Brave search API and normalizes output", async () => {
    let urlSeen = "";
    const fetchImpl: FetchLike = async (input) => {
      urlSeen = String(input);
      return new Response(
        JSON.stringify({
          web: {
            results: [{ url: "https://example.com", title: "Example" }],
          },
        }),
        { status: 200 }
      );
    };

    const adapter = new RealBraveResearchAdapter({ apiKey: "brave-key", fetchImpl });
    const results = await adapter.search("  worker adapters ");

    expect(urlSeen).toContain("https://api.search.brave.com/res/v1/web/search?q=worker%20adapters");
    expect(results[0]?.url).toBe("https://example.com");
  });

  it("calls OpenAI responses and normalizes output", async () => {
    const fetchImpl: FetchLike = async () => {
      return new Response(
        JSON.stringify({
          output: [{ content: [{ text: "draft ready" }] }],
        }),
        { status: 200 }
      );
    };

    const adapter = new RealOpenAIModelAdapter({
      apiKey: "openai-key",
      model: "gpt-4.1-mini",
      fetchImpl,
    });
    const result = await adapter.complete("  summarize  ");

    expect(result).toEqual({ output: "draft ready" });
  });
});
