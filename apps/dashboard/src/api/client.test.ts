import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardApiClient } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardApiClient', () => {
  it('calls cockpit endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ activeRuns: 2 }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new DashboardApiClient('/api');
    await client.getCockpit();

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/cockpit', expect.any(Object));
  });

  it('posts task actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = new DashboardApiClient('/api');
    await client.taskAction('task-7', 'retry');

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/tasks/task-7/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
  });

  it('calls perf scientist endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, queuedTasks: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new DashboardApiClient('/api');
    await client.getPerfScientistStatus();

    expect(fetchMock).toHaveBeenCalledWith('/api/perf-scientist/status', expect.any(Object));
  });

  it('calls retrieval status endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, p95LatencyMs: 100, cacheHitRate: 0.4, avgUsedTokens: 800 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new DashboardApiClient('/api');
    await client.getRetrievalStatus();

    expect(fetchMock).toHaveBeenCalledWith('/api/retrieval/status', expect.any(Object));
  });
});
