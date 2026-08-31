import { useState, useEffect, useRef, useCallback } from 'react';
import type { MonitoringMetrics, ResourceSnapshot } from '../types';
import { telemetry } from '../lib/metrics';
import { metrics as sampleMetrics, currentSnapshot as sampleSnapshot } from '../lib/data';

export type PollingState = 'live' | 'loading' | 'stale' | 'error';

interface UseMetricsPollingOptions {
  intervalMs?: number;
  enabled?: boolean;
}

export function useMetricsPolling({
  intervalMs = 30_000,
  enabled = true,
}: UseMetricsPollingOptions = {}): {
  snapshot: ResourceSnapshot;
  metrics: MonitoringMetrics;
  state: PollingState;
  lastRefreshed: string | null;
  refresh: () => Promise<void>;
} {
  const [{ snapshot, metrics }, setPayload] = useState<{
    snapshot: ResourceSnapshot;
    metrics: MonitoringMetrics;
  }>({ snapshot: sampleSnapshot, metrics: sampleMetrics });

  const [state, setState] = useState<PollingState>('live');
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchPayload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (!mountedRef.current) {
      return;
    }

    setState('loading');
    try {
      const [snapshotResult, metricsResult] = await Promise.all([
        telemetry.snapshot().catch(() => null),
        telemetry.metrics().catch(() => null),
      ]);

      if (snapshotResult && metricsResult && mountedRef.current) {
        setPayload({ snapshot: snapshotResult, metrics: metricsResult });
        setLastRefreshed(new Date().toISOString());
        setState('live');
      } else if (mountedRef.current) {
        setPayload({ snapshot: sampleSnapshot, metrics: sampleMetrics });
        setState('stale');
      }
    } catch (error) {
      if (mountedRef.current) {
        setPayload({ snapshot: sampleSnapshot, metrics: sampleMetrics });
        setState('error');
      }
    }
  }, [enabled]);

  const refresh = useCallback(async () => {
    await fetchPayload();
  }, [fetchPayload]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    mountedRef.current = true;
    fetchPayload();

    timerRef.current = setInterval(() => {
      if (mountedRef.current) {
        fetchPayload();
      }
    }, intervalMs);

    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, intervalMs, fetchPayload]);

  return { snapshot, metrics, state, lastRefreshed, refresh };
}
