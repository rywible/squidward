import { useCallback, useEffect, useMemo, useState } from 'react';

interface PollingState<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePollingQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs = 5000,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runFetch = useCallback(
    async (controller: AbortController, isRefresh: boolean) => {
      try {
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        const result = await fetcher(controller.signal);
        setData(result);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Unknown API error';
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    let activeController = new AbortController();

    void runFetch(activeController, false);

    const timer = window.setInterval(() => {
      activeController.abort();
      activeController = new AbortController();
      void runFetch(activeController, true);
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
      activeController.abort();
    };
  }, [intervalMs, runFetch]);

  const refresh = useMemo(
    () => async () => {
      const controller = new AbortController();
      await runFetch(controller, true);
    },
    [runFetch],
  );

  return {
    data,
    loading,
    refreshing,
    error,
    refresh,
  };
}
