#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// smoke.mjs — headless-Chromium smoke over the Control Center SPA.
//
// The unit tests (vitest + jsdom) mount pages against mocked modules, and the
// API tests (dashboard-backend/tests) exercise the handlers. Neither ever runs
// the built bundle in a real browser, so a page can be green in both and still
// fail where an operator looks: a chunk that 404s, a route that no longer
// matches, a render that throws on real JSON. This walks the operator entry
// points — Dashboard (/), Agents, Health & Status, Monitoring, Messages and the
// Softphone — in Chromium and asserts each one actually paints its heading, with
// no uncaught error behind it.
//
// The softphone is walked further: its socket is answered by a fake switch (the
// line protocol, plus a count of the audio the page sends) and the page is
// driven through both directions of a call — one it places and one the switch
// rings it with — holding, resuming, muting and hanging up each, then a third
// call it declines. A page that paints but cannot place, answer, hold, mute or
// reject a call is the exact failure a heading check cannot see.
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
  // The marker must be body text: "SMS Inbox" is also the sidebar label, which
  // would pass on any page.
  { path: '/messages', name: 'sms-inbox', marker: 'Replies the phone received' },
  // The softphone is the one page whose job is a socket, and a socket that is
  // never opened still paints a heading — so "Line socket" is only what proves
  // the page rendered. In the stubbed run its line is faked (see
  // stubLineSocket) and the page is then driven through dial → mute → unmute →
  // hold → resume → hangup, so a phone that connects to nothing, a Hold button
  // that sends nothing, or a Mute that only changes its own label, fails here
  // instead of in an operator's browser.
  { path: '/softphone', name: 'softphone', marker: 'Line socket', mic: true, exercise: exerciseSoftphone },
];

// ── the voice plane, faked ──────────────────────────────────────────────────
// The switch's line protocol, as far as this page uses it: it greets a socket
// with `registered`, mints a call id in `dialing`, says `answered` when the far
// end picks up, and echoes `held`. Faking it is what lets the smoke assert the
// page's own state machine: a page that quietly stops understanding one of these
// frames never writes its registered-line log entry, and the exercise fails.
//
// It also counts the binary frames the page sends. Mute is a change in what the
// switch receives — the capture path stops handing frames to the socket — so a
// count taken while muted is the only evidence a browser test can get that the
// button did something; a page whose Mute only swaps its own label keeps
// sending 50 frames a second and would pass every text assertion.
let stubLine = null;

function stubLineSocket(ws) {
  const ext = new URL(ws.url()).searchParams.get('ext') || '101';
  let frames = 0;
  // The exercise drives the page in a browser; ringing it is the one thing it
  // cannot do by clicking, so the fake switch keeps the handle.
  stubLine = {
    ring: (from = '14132642700', callId = 'call-smoke-in') =>
      ws.send(JSON.stringify({ type: 'incoming', callId, from, to: ext, ext, displayName: 'Smoke Line' })),
    /** 20 ms media frames received so far on this socket. */
    get mediaFrames() { return frames; },
  };
  ws.onMessage((message) => {
    // Playwright hands over a string for a text frame and a Buffer for a binary
    // one, so the frame's own type is the discriminator — `JSON.parse` on a
    // Buffer would only ever land in the catch below.
    if (typeof message !== 'string') {
      frames += 1;
      return;
    }
    let frame;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    switch (frame.type) {
      case 'call':
        ws.send(JSON.stringify({ type: 'dialing', callId: 'call-smoke', to: frame.to, state: 'ringing' }));
        ws.send(JSON.stringify({ type: 'answered', callId: 'call-smoke', from: ext, to: frame.to }));
        return;
      case 'hold':
        ws.send(JSON.stringify({ type: 'held', callId: frame.callId, held: true }));
        return;
      case 'unhold':
        ws.send(JSON.stringify({ type: 'held', callId: frame.callId, held: false }));
        return;
      case 'hangup':
        ws.send(JSON.stringify({ type: 'ended', callId: frame.callId, cause: 'normal' }));
        return;
      default:
        return;
    }
  });
  ws.send(JSON.stringify({ type: 'registered', ext, displayName: 'Smoke Line', codec: 'pcm-s16/8000/1' }));
}

/**
 * Walk a call on the softphone page: connect, dial, mute, unmute, hold, resume,
 * hang up; then answer a call the switch rings it with, and refuse one.
 */
async function exerciseSoftphone(page) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Frame counting is node-side: the page cannot see what reached the switch.
  const framesAdvance = async (from, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (stubLine && stubLine.mediaFrames > from) return true;
      await sleep(50);
    }
    return false;
  };
  const seen = async (text, label) =>
    page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
      throw new Error(`the softphone never showed ${label || `"${text}"`}`);
    });
  const gone = async (text, label) =>
    page.waitForFunction(
      (t) => !(document.body?.innerText || '').includes(t),
      text,
      { timeout: 15_000 },
    ).catch(() => {
      throw new Error(`the softphone ${label || `still showed "${text}"`}`);
    });

  // Not the chip: "Not connected" contains "connected", so a substring match on
  // the chip passes in exactly the state this check exists to catch. The log
  // line is written only when the switch has answered the socket.
  await seen('is on the voice plane', 'a registered line');

  // ── a call this line places ──
  await page.getByPlaceholder(/Number or extension/).fill('102');
  await page.getByRole('button', { name: /^Call$/ }).click();
  await seen('On call', 'a connected call after dialling');

  // ── mute ──
  // Audio has to be flowing before its absence means anything, so the first
  // assertion is that the switch is receiving frames at all — a silent capture
  // path would otherwise make the muted count a false pass.
  const talking = stubLine.mediaFrames;
  if (!(await framesAdvance(talking))) {
    throw new Error('the softphone never sent audio frames on a connected call');
  }

  await page.getByRole('button', { name: /^Mute$/ }).click();
  await seen('Microphone muted', 'the mute confirmation');
  await page.getByRole('button', { name: /^Unmute$/ }).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
    throw new Error('the Mute button never turned into Unmute');
  });
  // A frame already clocked through at the moment of the click still arrives; a
  // short settle keeps that race out of the assertion below.
  await sleep(400);
  const quietAt = stubLine.mediaFrames;
  await sleep(900); // ~45 frames at 50/s: a mute that only relabelled a button shows here
  if (stubLine.mediaFrames !== quietAt) {
    throw new Error(`kept sending media while muted (${stubLine.mediaFrames - quietAt} frames in 900ms)`);
  }

  await page.getByRole('button', { name: /^Unmute$/ }).click();
  await seen('Microphone unmuted', 'the unmute confirmation');
  if (!(await framesAdvance(quietAt))) {
    throw new Error('the softphone never resumed sending audio after unmuting');
  }

  await page.getByRole('button', { name: /^Hold$/ }).click();
  await seen('On hold', 'the switch\'s hold confirmation');
  await seen('Resume', 'the Resume button');

  await page.getByRole('button', { name: /^Resume$/ }).click();
  await seen('On call', 'the call coming back from hold');

  await page.getByRole('button', { name: /Hang up/ }).click();
  await gone('On call', 'kept the call after hanging up');

  // ── a call this line receives ──
  // The banner is the only thing that tells an operator a call is waiting, and
  // answering it is a different path through the page than dialling: the call
  // id and the peer both arrive from the switch rather than from the form.
  if (!stubLine) throw new Error('the line socket was never opened');
  stubLine.ring('14132642700');
  // The banner's own copy, not its peer line: the activity log keeps a
  // historical "Incoming call from …" entry, so a body-wide match on that text
  // can never clear — the banner would look stuck after every declined call.
  await seen('Answer to start audio on this line.', 'the incoming call banner');
  await seen('Incoming call from 14132642700', 'the caller on the banner');

  await page.getByRole('button', { name: /^Answer$/ }).click();
  await seen('On call', 'a connected call after answering');

  await page.getByRole('button', { name: /^Hold$/ }).click();
  await seen('On hold', 'the hold confirmation on an answered call');
  await page.getByRole('button', { name: /^Resume$/ }).click();
  await seen('On call', 'the answered call coming back from hold');

  await page.getByRole('button', { name: /Hang up/ }).click();
  await gone('On call', 'kept the answered call after hanging up');

  // ── a call this line refuses ──
  // Declining must clear the banner without starting anything, and must leave
  // the line up: a rejected call is not a disconnected phone. "Not connected"
  // is checked as an absence because it is the chip's own failure label — the
  // state this must not be in — and an absent string cannot be matched by a
  // looser one the way "Connected" could.
  stubLine.ring('14132642701', 'call-smoke-decline');
  await seen('Answer to start audio on this line.', 'the second incoming banner');
  await page.getByRole('button', { name: /^Decline$/ }).click();
  await gone('Answer to start audio on this line.', 'kept the banner after declining');
  await gone('On call', 'started a call after declining');
  await gone('Decline', 'left the incoming call controls up after declining');
  if (await page.getByText('Not connected').count()) {
    throw new Error('declining an incoming call took the line down');
  }
  await page.getByRole('button', { name: /^Call$/ }).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
    throw new Error('the dialer never came back after declining');
  });
}

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
  [/^\/sms-inbound$/, () => ({
    enabled: true,
    token_set: true,
    count: 1,
    messages: [{
      id: 'smoke-1', direction: 'in', from: '+15551234567',
      body: 'smoke reply', received_at: '2026-10-20 10:00:00', sim: 0,
    }],
  })],
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
async function checkPage(context, base, spec, live) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  // A stubbed run never dials the estate: the softphone's socket is answered by
  // the fake switch, and intercepting it (rather than letting it be refused)
  // keeps the run's "no failed request" rule meaningful. A live run uses the
  // deployment's own socket.
  if (!live && spec.exercise) {
    await page.routeWebSocket((url) => url.pathname === '/ws', stubLineSocket);
  }

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

  // A page can paint its heading and still be useless — the softphone did, with
  // a Hold button wired to nothing. This walks the page's own controls and
  // reports the first thing that did not happen.
  let exercise = '';
  if (!live && spec.exercise && markerSeen) {
    try {
      await spec.exercise(page);
    } catch (e) {
      exercise = String(e?.message || e).slice(0, 200);
      await page.screenshot({ path: resolve(DASHBOARD_DIR, 'e2e/artifacts', `${spec.name}.png`), fullPage: true }).catch(() => {});
    }
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
    exercise: exercise || undefined,
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
    if (r.exercise) failures.push(`${r.page} ${r.exercise}`);
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

  // The softphone's first call opens the microphone. Headless Chromium has no
  // device and no user to ask, so the stubbed run gives it a fake one rather
  // than letting `getUserMedia` refuse the call before the page can dial.
  const needsMic = !live && PAGES.some((p) => p.mic);
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      ...(needsMic ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : []),
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  if (needsMic) await context.grantPermissions(['microphone'], { origin: base });

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
    results.push(await checkPage(context, base, spec, live));
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
