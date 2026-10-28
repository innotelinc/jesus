import type { MonitoringMetrics, MetricPoint, ResourceSnapshot } from '../types';
import { dashboardBaseUrl } from './config';

/**
 * Telemetry hangs off the same control-panel aggregator as the rest of the
 * dashboard. A legacy runtime override is honoured for convenience.
 */
export const telemetryBaseUrl: string =
  dashboardBaseUrl ||
  (typeof window !== 'undefined'
    ? (window as unknown as { __TELEMETRY_BASE_URL__?: string }).__TELEMETRY_BASE_URL__ ?? ''
    : '');

export const telemetry = {
  metrics: async (): Promise<MonitoringMetrics> => {
    if (!telemetryBaseUrl) {
      throw new Error('TELEMETRY_BASE_URL is not configured');
    }
    const response = await fetch(`${telemetryBaseUrl}/metrics`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Telemetry metrics fetch failed: ${response.status}`);
    }
    const json = await response.json();
    return {
      cpu: ensureMetricPoints(json.cpu),
      memory: ensureMetricPoints(json.memory),
      disk: ensureMetricPoints(json.disk),
      networkIn: ensureMetricPoints(json.networkIn),
      networkOut: ensureMetricPoints(json.networkOut),
      requestRate: ensureMetricPoints(json.requestRate),
      errorRate: ensureMetricPoints(json.errorRate),
      activeSessions: ensureMetricPoints(json.activeSessions),
    };
  },

  snapshot: async (): Promise<ResourceSnapshot> => {
    if (!telemetryBaseUrl) {
      throw new Error('TELEMETRY_BASE_URL is not configured');
    }
    const response = await fetch(`${telemetryBaseUrl}/snapshot`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Telemetry snapshot fetch failed: ${response.status}`);
    }
    return response.json();
  },
};

function ensureMetricPoints(input: unknown): MetricPoint[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter(
      (item): item is MetricPoint =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as MetricPoint).timestamp === 'string' &&
        typeof (item as MetricPoint).value === 'number'
    )
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
