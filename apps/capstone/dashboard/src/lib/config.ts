/**
 * Base URL of the Capstone control-panel aggregator (dashboard-api service).
 *
 * Resolution order:
 *   1. runtime override  window.__DASHBOARD_BASE_URL__  (set in index.html / host)
 *   2. build-time env     VITE_DASHBOARD_BASE_URL        (injected by Vite)
 *   3. '' — development fallback; pages then use sample data
 *
 * All dashboard/telemetry endpoints hang off this single base, so one value
 * controls the whole data layer. In the containerized build it is `/api`,
 * which nginx reverse-proxies to the dashboard-api service, keeping the app
 * same-origin (no CORS, no host/port wiring).
 */
export const dashboardBaseUrl: string =
  (typeof window !== 'undefined'
    ? (window as unknown as { __DASHBOARD_BASE_URL__?: string }).__DASHBOARD_BASE_URL__
    : undefined) ||
  (import.meta.env.VITE_DASHBOARD_BASE_URL as string | undefined) ||
  '';