import { describe, expect, it } from "bun:test";
import { InMemoryWorkerDb } from "../src/db";
import { SerializedTaskProcessor } from "../src/queue";

describe("SerializedTaskProcessor", () => {
  it("processes tasks by priority P0 > P1 > P2 and FIFO within the same priority", async () => {
    const db = new InMemoryWorkerDb();
    let now = new Date("2026-02-12T10:00:00.000Z");
    const processor = new SerializedTaskProcessor<{ name: string }>(db, {
      now: () => now,
    });

    await processor.enqueue({ dedupeKey: "a", priority: "P2", payload: { name: "p2" } });
    now = new Date(now.getTime() + 1_000);
    await processor.enqueue({ dedupeKey: "b", priority: "P0", payload: { name: "p0" } });
    now = new Date(now.getTime() + 1_000);
    await processor.enqueue({ dedupeKey: "c", priority: "P1", payload: { name: "p1" } });

    const processed: string[] = [];
    await processor.processNext(async (task) => {
      processed.push(task.payload.name);
    });
    await processor.processNext(async (task) => {
      processed.push(task.payload.name);
    });
    await processor.processNext(async (task) => {
      processed.push(task.payload.name);
    });

    expect(processed).toEqual(["p0", "p1", "p2"]);
  });

  it("coalesces duplicate tasks in the dedupe window", async () => {
    const db = new InMemoryWorkerDb();
    let now = new Date("2026-02-12T10:00:00.000Z");
    const processor = new SerializedTaskProcessor<{ revision: number }>(db, {
      now: () => now,
      coalesceWindowMs: 60_000,
    });

    const first = await processor.enqueue({
      dedupeKey: "same-job",
      priority: "P2",
      payload: { revision: 1 },
    });

    now = new Date("2026-02-12T10:00:10.000Z");
    const second = await processor.enqueue({
      dedupeKey: "same-job",
      priority: "P0",
      payload: { revision: 2 },
    });

    expect(first.id).toBe(second.id);
    expect(second.coalesced).toBe(true);

    const queue = db.getQueueSnapshot();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.priority).toBe("P0");
    expect(queue[0]?.coalescedCount).toBe(1);
    expect(queue[0]?.payload).toEqual({ revision: 2 });
  });
});
