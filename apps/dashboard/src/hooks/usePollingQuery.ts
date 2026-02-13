import { useCallback, useEffect, useRef, useState } from 'react';

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
  const fetcherRef = useRef(fetcher);
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);
  const errorStreakRef = useRef(0);
  const runFetchRef = useRef<((isRefresh: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(
    (delayMs: number) => {
      clearTimer();
      if (disposedRef.current) return;
      const clamped = Math.max(1500, Math.trunc(delayMs));
      timerRef.current = window.setTimeout(() => {
        if (runFetchRef.current) {
          void runFetchRef.current(true);
        }
      }, clamped);
    },
    [clearTimer],
  );

  const runFetch = useCallback(
    async (isRefresh: boolean) => {
      if (disposedRef.current || inFlightRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext(Math.max(intervalMs, 15_000));
        return;
      }
      inFlightRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        const result = await fetcherRef.current(controller.signal);
        if (disposedRef.current) return;
        setData(result);
        setError(null);
        errorStreakRef.current = 0;
      } catch (err) {
        if (controller.signal.aborted || disposedRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Unknown API error';
        setError(message);
        errorStreakRef.current += 1;
      } finally {
        if (!disposedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
        inFlightRef.current = false;
        const backoffMultiplier = Math.min(6, errorStreakRef.current);
        const backoffMs = errorStreakRef.current > 0 ? intervalMs * 2 ** backoffMultiplier : intervalMs;
        const jitterMs = Math.floor(Math.random() * 300);
        scheduleNext(Math.min(60_000, backoffMs) + jitterMs);
      }
    },
    [intervalMs, scheduleNext],
  );

  useEffect(() => {
    runFetchRef.current = runFetch;
  }, [runFetch]);

  useEffect(() => {
    disposedRef.current = false;
    errorStreakRef.current = 0;
    void runFetch(false);

    const onVisible = () => {
      if (document.hidden) return;
      if (inFlightRef.current) return;
      void runFetch(true);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      disposedRef.current = true;
      clearTimer();
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [runFetch, clearTimer]);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    clearTimer();
    await runFetch(true);
  }, [clearTimer, runFetch]);

  return {
    data,
    loading,
    refreshing,
    error,
    refresh,
  };
}
