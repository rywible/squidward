import { describe, expect, it } from "bun:test";
import { selectSchedulerMode } from "../src/scheduler";

describe("selectSchedulerMode", () => {
  it("uses active mode when queued work exists", () => {
    const mode = selectSchedulerMode({
      now: new Date(2026, 1, 12, 23, 0, 0),
      hasQueuedWork: true,
      hasActiveIncident: false,
    });

    expect(mode).toBe("active");
  });

  it("uses off-hours mode outside configured window", () => {
    const mode = selectSchedulerMode({
      now: new Date(2026, 1, 12, 22, 0, 0),
      hasQueuedWork: false,
      hasActiveIncident: false,
      config: {
        localBusinessHoursStart: 8,
        localBusinessHoursEnd: 18,
        businessDays: [1, 2, 3, 4, 5],
      },
    });

    expect(mode).toBe("off-hours");
  });

  it("uses idle mode during business hours with no work", () => {
    const mode = selectSchedulerMode({
      now: new Date(2026, 1, 12, 10, 0, 0),
      hasQueuedWork: false,
      hasActiveIncident: false,
      config: {
        localBusinessHoursStart: 8,
        localBusinessHoursEnd: 18,
        businessDays: [1, 2, 3, 4, 5],
      },
    });

    expect(mode).toBe("idle");
  });
});
