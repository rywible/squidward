import { describe, expect, it } from "bun:test";

import { buildBranchName, shouldOpenDraftPr } from "../src/policy";

describe("policy", () => {
  it("builds codex-prefixed branch names with sanitized slug", () => {
    const branch = buildBranchName({
      title: "Fix   flaky test!!! in auth/module",
      ticketId: "WR-123",
      workType: "bugfix",
      now: new Date("2026-02-12T03:00:00.000Z"),
    });

    expect(branch.startsWith("codex/bugfix/wr-123/")).toBe(true);
    expect(branch).toContain("fix-flaky-test-in-auth-module");
  });

  it("enforces draft PR for non-low risk or failing checks", () => {
    expect(
      shouldOpenDraftPr({
        priority: "P1",
        riskLevel: "high",
        hasFailingChecks: false,
        isWip: false,
      })
    ).toBe(true);

    expect(
      shouldOpenDraftPr({
        priority: "P1",
        riskLevel: "low",
        hasFailingChecks: true,
        isWip: false,
      })
    ).toBe(true);
  });

  it("allows non-draft only for low-risk non-P0 clean changes", () => {
    expect(
      shouldOpenDraftPr({
        priority: "P2",
        riskLevel: "low",
        hasFailingChecks: false,
        isWip: false,
      })
    ).toBe(false);

    expect(
      shouldOpenDraftPr({
        priority: "P0",
        riskLevel: "low",
        hasFailingChecks: false,
        isWip: false,
      })
    ).toBe(true);
  });
});
