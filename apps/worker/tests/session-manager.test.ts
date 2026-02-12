import { describe, expect, it } from "bun:test";

import { SingleCodexSessionManager } from "../src/session-manager";

describe("SingleCodexSessionManager", () => {
  it("allows exactly one active session", () => {
    const manager = new SingleCodexSessionManager();

    const first = manager.start("task-1");
    expect(first.taskId).toBe("task-1");
    expect(manager.getActiveSession()?.id).toBe(first.id);

    expect(() => manager.start("task-2")).toThrow();

    manager.end(first.id);
    expect(manager.getActiveSession()).toBeNull();
  });

  it("throws when ending a non-active session id", () => {
    const manager = new SingleCodexSessionManager();
    const first = manager.start("task-1");

    expect(() => manager.end("not-the-active-id")).toThrow();
    expect(manager.getActiveSession()?.id).toBe(first.id);
  });
});
