#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// smoke.mjs — headless-Chromium smoke over the Control Center SPA.
//
// The unit tests (vitest + jsdom) mount pages against mocked modules, and the
// API tests (dashboard-backend/tests) exercise the handlers. Neither ever runs
// the built bundle in a real browser, so a page can be green in both and still
// fail where an operator looks: a chunk that 404s, a route that no longer
// matches, a render that throws on real JSON. This walks the operator entry
// points — Dashboard (/), Agents, Health & Status, Monitoring — in Chromium and
// asserts each one actually paints its heading, with no uncaught error behind
// it.
//
// Two modes:
//   • default (no CAPSTONE_BASE): serve dashboard/dist with `vite preview` and
//     stub every /api call, so the run is hermetic and deterministic — this is
//     what CI runs on a hosted runner.
//   • CAPSTONE_BASE set: run against a real deployment. Without CAPSTONE_COOKIE
//     the expected outcome is the sign-in gate (the SPA loads, then Authentik).
//     With a cookie it walks the pages authenticated and then probes the
//     page-critical API endpoints one at a time, failing any that outlives
//     CAPSTONE_API_BUDGET_MS — the reverse proxy turns a slow backend into a
//     504, which is exactly the regression this guards.
//
// Exit codes: 0 = pass, 1 = failure, 2 = skipped (a live base this runner
// cannot reach — reported as a skip, matching scripts/ci/sso-smoke.py).
// ═══════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolve(HERE, '..');
const DIST_DIR = resolve(DASHBOARD_DIR, 'dist');
const PREVIEW_PORT = Number(process.env.SMOKE_PORT || 4173);

const LIVE_BASE = (process.env.CAPSTONE_BASE || '').replace(/\/+$/, '');
const COOKIE = process.env.CAPSTONE_COOKIE || '';
// The nginx read timeout in dashboard/nginx.conf is 120s; anything nearing this
// budget is a backend the operator will watch spin, and anything past it 504s at
// the proxy. 25s sits comfortably above a healthy call and well below the
// ceiling, so the gate fires before an operator sees a timeout.
const API_BUDGET_MS = Number(process.env.CAPSTONE_API_BUDGET_MS || 25_000);
// Page-critical endpoints, probed sequentially so one slow handler cannot be
// mistaken for another (a browser's parallel fetches queue on a connection pool
// and make everything look slow at once).
// Includes the endpoints that historically walked a slow path (the agents
// repair, the per-container `docker stats` inside /health and /services, and
// the per-user Authentik reachability fan-out behind /authentik/access).
const API_ENDPOINTS = (process.env.CAPSTONE_API_ENDPOINTS || 'agents,services,health,stats,pbx/health,authentik/access')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Pages an operator opens first. `marker` is text that only renders once the
// page's own body (not the shared nav) has painted, so it catches a page that
// mounts to a blank fallback. Matching is case-insensitive (see below).
const PAGES = [
  { path: '/', name: 'dashboard', marker: 'System Status' },
  { path: '/agents', name: 'agents', marker: 'Dograh AI voice agents' },
  { path: '/health', name: 'health', marker: 'Health & Status' },
  { path: '/monitoring', name: 'monitoring', marker: 'Monitoring' },
];

// ── stub payloads (default mode) ────────────────────────────────────────────
// Only the shapes the pages read are needed; each is the minimal object that
// lets a page reach "painted" instead of "fallback".
const point = (v) => ({ timestamp: new Date().toISOString(), value: v });
const METRIC_POINTS = [point(10), point(20), point(30)];

const STUBS = [
  [/^\/auth\/me$/, () => ({ authenticated: true, name: 'Smoke Runner', email: 'smoke@example.com' })],
  [/^\/agents\/workflows$/, () => [{ id: 1, name: 'Reception', status: 'active' }]],
  [/^\/agents$/, () => ({
    mode: 'standalone',
    configured: true,
    agents: [{
      id: 1, extension: '8000', address: '8000', label: 'Reception', active: true,
      workflowId: 1, workflowName: 'Reception',
      pbx: { status: 'provisioned', customExtension: true, inboundRoute: true, dialplan: true },
    }],
    stasis: { expected: 'dograh_smoke', registered: ['dograh_smoke'], ok: true, dynamicExtensions: [] },
  })],
  [/^\/interviews\/reports/, () => ({ configured: true, docId: 'smoke', reports: [] })],
  [/^\/grading\/workflows$/, () => ({ workflows: [] })],
  [/^\/workflows$/, () => []],
  [/^\/entitlements$/, () => ({
    entitled: true, source: 'standalone', magnate_url: '', reason: null,
    plan: 'standalone', slug: 'capstone', status: 'active',
  })],
  [/^\/pbx\/health$/, () => ({
    mode: 'standalone', running: true, watchdogEnabled: true, watchdogIntervalSeconds: 60,
    recoveries: 0, failures: 0, lastRecoveryAt: null, lastSource: null, events: [],
  })],
  [/^\/authentik\/access$/, () => ({
    configured: true, ok: true, baseUrl: '', generatedAt: new Date().toISOString(), error: null,
    summary: { stacks: 0, users: 0, applications: 0, enforced: 0, ungated: 0 },
    stacks: [], users: [], ungated: [], tilesOnly: [],
  })],
  [/^\/stats$/, () => ({
    totalServices: 0, healthyServices: 0, warningServices: 0, criticalServices: 0,
    activePorts: 0, openAlerts: 0, expiringSecrets: 0, uptimePercent: 100,
  })],
  [/^\/metrics$/, () => ({
    cpu: METRIC_POINTS, memory: METRIC_POINTS, disk: METRIC_POINTS,
    networkIn: METRIC_POINTS, networkOut: METRIC_POINTS, requestRate: METRIC_POINTS,
    errorRate: METRIC_POINTS, activeSessions: METRIC_POINTS,
  })],
  [/^\/snapshot$/, () => ({
    cpuPercent: 10, memoryPercent: 20, memoryBytes: 1, diskPercent: 30, diskBytes: 1,
    networkIn: 0, networkOut: 0, requestRate: 0, errorRate: 0, activeSessions: 0,
  })],
  [/^\/(services|ports|secrets|alerts|users|links|health|incidents|policies|audit)$/, () => []],
];

function stubBody(pathname) {
  for (const [re, make] of STUBS) {
    if (re.test(pathname)) return make();
  }
  return [];
}

// ── local preview server (default mode) ─────────────────────────────────────
async function startPreview() {
  if (!existsSync(resolve(DIST_DIR, 'index.html'))) {
    throw new Error(`no build at ${DIST_DIR} — run \`npm run build\` first`);
  }
  const viteBin = resolve(DASHBOARD_DIR, 'node_modules/vite/bin/vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: DASHBOARD_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', (b) => {
    const line = String(b).trim();
    if (line) console.error(`[preview] ${line}`);
  });
  const base = `http://127.0.0.1:${PREVIEW_PORT}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base, { redirect: 'manual' });
      if (res.status > 0) return { base, child };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill('SIGKILL');
  throw new Error('vite preview did not come up within 30s');
}

// ── page walk ───────────────────────────────────────────────────────────────
async function checkPage(context, base, spec) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 240)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText || ''}`.slice(0, 200)));
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/') && r.status() >= 400) {
      failedRequests.push(`${r.status()} ${r.url()}`);
    }
  });

  let http = 0;
  let markerSeen = false;
  let finalUrl = base + spec.path;
  let bodyText = '';
  try {
    const resp = await page.goto(`${base}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    http = resp?.status() ?? 0;
    // Case-insensitive: several headings are CSS-uppercased, and innerText
    // reports the rendered casing ("SYSTEM STATUS"), not the source casing.
    await page.waitForFunction(
      (m) => (document.body?.innerText || '').toLowerCase().includes(m.toLowerCase()),
      spec.marker,
      { timeout: 25_000 },
    );
    markerSeen = true;
    finalUrl = page.url();
    bodyText = await page.evaluate(() => document.body.innerText);
  } catch (e) {
    finalUrl = page.url();
    bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    consoleErrors.push(`harness: ${String(e).slice(0, 200)}`);
  }

  if (!markerSeen) {
    const artifacts = resolve(DASHBOARD_DIR, 'e2e/artifacts');
    await page.screenshot({ path: resolve(artifacts, `${spec.name}.png`), fullPage: true }).catch(() => {});
  }
  await page.close();

  const redirectedToSso = /auth\.|outpost|goauthentik|application\/o\//.test(finalUrl) && finalUrl !== `${base}${spec.path}`;
  return {
    page: spec.path,
    http,
    markerSeen,
    redirectedToSso,
    finalUrl: finalUrl.replace(base, ''),
    textLen: bodyText.length,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 6),
    pageErrors: [...new Set(pageErrors)].slice(0, 6),
    failedRequests: [...new Set(failedRequests)].slice(0, 8),
  };
}

// ── live API budget (sequential) ────────────────────────────────────────────
async function checkApiBudget(base, cookie) {
  const results = [];
  const failures = [];
  for (const path of API_ENDPOINTS) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/api/${path}`, {
        headers: cookie ? { cookie: `capstone_session=${cookie}` } : {},
      });
      await res.text();
      const ms = Date.now() - started;
      results.push({ path, status: res.status, ms });
      if (res.status >= 500) failures.push(`/api/${path} answered HTTP ${res.status}`);
      else if (ms > API_BUDGET_MS) failures.push(`/api/${path} took ${ms}ms (budget ${API_BUDGET_MS}ms)`);
    } catch (e) {
      const ms = Date.now() - started;
      results.push({ path, status: 0, ms, error: String(e).slice(0, 120) });
      failures.push(`/api/${path} failed after ${ms}ms: ${String(e).slice(0, 120)}`);
    }
  }
  return { results, failures };
}

function judge(results, live) {
  const failures = [];
  for (const r of results) {
    if (live && r.redirectedToSso) {
      continue; // expected without a session: the gate is doing its job
    }
    if (r.pageErrors.length) failures.push(`${r.page} threw: ${r.pageErrors[0]}`);
    if (r.http !== 200) failures.push(`${r.page} answered HTTP ${r.http}`);
    if (!r.markerSeen) failures.push(`${r.page} never painted its heading (marker missing)`);
    if (!live) {
      // A stubbed run should be spotless: any console error or failed request is
      // a real defect in the bundle, not the estate being degraded.
      const unexpected = r.consoleErrors.filter((e) => !/Failed to load resource/.test(e));
      if (unexpected.length) failures.push(`${r.page} console error: ${unexpected[0]}`);
      if (r.failedRequests.length) failures.push(`${r.page} failed request: ${r.failedRequests[0]}`);
    }
  }
  return failures;
}

// ── main ────────────────────────────────────────────────────────────────────
let previewChild = null;
try {
  const live = Boolean(LIVE_BASE);
  let base = LIVE_BASE;

  if (!live) {
    const started = await startPreview();
    base = started.base;
    previewChild = started.child;
  } else if (!COOKIE) {
    console.error('note: CAPSTONE_BASE set without CAPSTONE_COOKIE — checking the sign-in gate only');
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });

  if (!live) {
    // The bundle's API base depends on how it was built: the Docker image sets
    // VITE_DASHBOARD_BASE_URL=/api, while a bare `npm run build` leaves it empty
    // (same-origin relative). Match both, and only fetch/xhr requests, so a
    // route named like an API path (/health) still serves the SPA document.
    await context.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      const pathname = new URL(req.url()).pathname;
      const stripped = pathname.replace(/^\/api/, '');
      const known = STUBS.some(([re]) => re.test(stripped));
      const isApi = (type === 'fetch' || type === 'xhr') && (pathname.startsWith('/api/') || known);
      if (!isApi) return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubBody(stripped)),
      });
    });
  } else if (COOKIE) {
    const host = new URL(base).hostname;
    await context.addCookies([{ name: 'capstone_session', value: COOKIE, domain: host, path: '/' }]);
  }

  const results = [];
  for (const spec of PAGES) {
    results.push(await checkPage(context, base, spec));
  }
  await browser.close();

  console.log(JSON.stringify(results, null, 2));

  if (live && results.every((r) => r.http === 0)) {
    console.error('skip: the deployment at', base, 'did not answer');
    process.exitCode = 2;
  } else {
    const failures = judge(results, live);

    if (live && COOKIE) {
      const { results: api, failures: apiFailures } = await checkApiBudget(base, COOKIE);
      console.log('\nAPI budget (sequential):');
      for (const a of api) console.log(`  ${String(a.status).padStart(3)}  ${String(a.ms).padStart(6)}ms  /api/${a.path}`);
      failures.push(...apiFailures);
    }

    if (failures.length) {
      console.error(`\n✗ ${failures.length} smoke failure(s):`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ ${results.length} page(s) rendered cleanly (${live ? 'live' : 'stubbed'})`);
      process.exitCode = 0;
    }
  }
} catch (err) {
  console.error('smoke harness error:', err);
  process.exitCode = 1;
} finally {
  if (previewChild) previewChild.kill('SIGTERM');
}
