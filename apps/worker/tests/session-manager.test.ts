import { describe, expect, it } from "bun:test";

import { CodexSessionManager } from "../src/session-manager";

describe("CodexSessionManager", () => {
  it("enforces configured session capacity", () => {
    const manager = new CodexSessionManager(2);

    const first = manager.start("task-1");
    const second = manager.start("task-2");
    expect(first.taskId).toBe("task-1");
    expect(second.taskId).toBe("task-2");
    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getAvailableSlots()).toBe(0);
    expect(() => manager.start("task-3")).toThrow();

    manager.end(first.id);
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getAvailableSlots()).toBe(1);
  });

  it("ignores unknown session ids on end", () => {
    const manager = new CodexSessionManager();
    const first = manager.start("task-1");

    manager.end("not-the-active-id");
    expect(manager.getActiveSession()?.id).toBe(first.id);
  });
});
