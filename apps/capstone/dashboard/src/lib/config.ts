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

/**
 * The voice plane lives in the Zeus portal, not here: a call's agent, its
 * Capstone binding and its add-on gate are all authored there. This dashboard
 * links to that screen rather than duplicating it (it must not become a second
 * writer of routing — see the Zeus repo, docs/ava-capstone-convergence.md §7).
 *
 * The link id is the one `build_links` publishes, so the sidebar entry and the
 * Links page resolve from the same payload and cannot disagree; the constants
 * below are only the fallback for the first paint or an unreachable
 * aggregator. The default is the portal's own declared public name (the value
 * the Zeus repo defaults `NEXT_PUBLIC_URL` to), which answers this route —
 * measured through the edge: `app.zeus.innotel.us/dashboard/voice` → 307 to
 * `/login`. The aggregator is authoritative when it is up: on the box it is
 * `ZEUS_PORTAL_URL`, else `ZEUS_API_URL` (the same app), else this default.
 */
export const VOICE_PLANE_LINK_ID = 'ln-voice-plane';

const voicePortalOrigin = (
  (import.meta.env.VITE_ZEUS_PORTAL_URL as string | undefined) || 'https://app.zeus.innotel.us'
).replace(/\/+$/, '');

export const voicePortalVoiceScreenUrl = `${voicePortalOrigin}/dashboard/voice`;

/**
 * The PBX-side door to that same screen, published by `build_links` beside the
 * voice-plane row and resolving from the same payload.
 *
 * The voice plane has exactly two ways in, and both are listed together so an
 * operator never has to know which product owns which: the portal screen above,
 * and the sign-in page of the reverse proxy in front of FreePBX (`pbx-sso`, an
 * oauth2-proxy gateway) whose sign-in banner carries the Voice Plane link. That
 * banner is the module-free route from FreePBX — an admin-menu entry is only
 * expressible as a FreePBX module.
 */
export const PBX_SIGNIN_LINK_ID = 'ln-pbx-signin';

const pbxOrigin = (
  (import.meta.env.VITE_PBX_URL as string | undefined) || 'https://pbx.capstone.innotel.us'
).replace(/\/+$/, '');

export const pbxSigninUrl = pbxOrigin;