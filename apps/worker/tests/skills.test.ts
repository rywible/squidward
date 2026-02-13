import { describe, expect, it } from "bun:test";

import { selectMissionSkills } from "../src/skills";

describe("selectMissionSkills", () => {
  it("always includes repo-orient as a foundational skill", () => {
    const selected = selectMissionSkills({
      intent: "meta",
      taskType: "chat_reply",
      requestText: "hey, can you help?",
      objective: "Respond to web chat message",
      maxSkills: 2,
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.some((skill) => skill.id === "repo-orient")).toBe(true);
  });

  it("prioritizes perf-scientist for perf-heavy intent", () => {
    const selected = selectMissionSkills({
      intent: "perf",
      taskType: "perf_run_candidate",
      requestText: "optimize latency and benchmark p95",
      objective: "Find a performance win",
      maxSkills: 2,
    });

    expect(selected.some((skill) => skill.id === "perf-scientist")).toBe(true);
  });
});

