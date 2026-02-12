import { afterEach, describe, expect, it, mock } from "bun:test";

import { DashboardApiClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DashboardApiClient", () => {
  it("calls cockpit endpoint", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ activeRuns: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new DashboardApiClient("/api");
    await client.getCockpit();

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/dashboard/cockpit");
  });

  it("posts task actions", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new DashboardApiClient("/api");
    await client.taskAction("task-7", "retry");

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/dashboard/tasks/task-7/actions");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    });
  });

  it("calls perf scientist endpoints", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ enabled: true, queuedTasks: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new DashboardApiClient("/api");
    await client.getPerfScientistStatus();

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/perf-scientist/status");
  });

  it("calls retrieval status endpoint", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ enabled: true, p95LatencyMs: 100, cacheHitRate: 0.4, avgUsedTokens: 800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new DashboardApiClient("/api");
    await client.getRetrievalStatus();

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/retrieval/status");
  });
});
