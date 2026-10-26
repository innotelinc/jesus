#!/usr/bin/env node
/**
 * End-to-end API test. Repeatable: it removes its own fixtures before running,
 * so it can be pointed at the same database many times.
 *
 *   node scripts/smoke.mjs [http://localhost:8080]
 *
 * Exits non-zero if any expectation fails.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { finalNoticeEmail, invoiceEmail, reminderEmail, suspensionEmail } from '../src/lib/mail.js';
import { payUrlForInvoice } from '../src/lib/payments.js';

/**
 * Two modes:
 *   node scripts/smoke.mjs                 → starts its own server on a random
 *                                            port, so rate-limit windows and
 *                                            in-memory state start clean
 *   node scripts/smoke.mjs http://host:8080 → tests an already-running server
 *
 * The self-hosted mode exists because several endpoints are deliberately rate
 * limited per IP per hour; pointing every run at one long-lived server would
 * make the suite pass once and then fail on limiter state, not on behavior.
 */
const external = (process.argv[2] || process.env.BASE_URL || '').replace(/\/$/, '');
let base = external;
let server = null;
let stripeStub = null;
const stripeCalls = [];
let mailjetStub = null;
const mailjetCalls = [];
// Set to make the stub report a different registered webhook URL, so the
// connection test's "points at an old host" path is exercised.
let stripeEndpointUrl = '';

if (!base) {
  const port = 8100 + Math.floor(Math.random() * 800);
  base = `http://127.0.0.1:${port}`;

  // A local Stripe stand-in: a payment link can be exercised end to end without
  // a card, a key or the internet. It records what the platform sent, which is
  // the part worth asserting.
  //
  // It also answers the reads the connection test makes — balance, webhook
  // endpoint list — and refuses a key ending in `dead`, so the test's failure
  // paths are exercised against a provider that behaves like Stripe instead of
  // one that always says yes.
  stripeStub = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = request.url.split('?')[0];
      stripeCalls.push({ path: request.url, body, method: request.method, authorization: request.headers.authorization || '' });
      const send = (payload, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const presented = Buffer.from(String(request.headers.authorization || '').replace(/^Basic /, ''), 'base64')
        .toString('utf8')
        .split(':')[0];
      if (presented.endsWith('dead')) {
        return send({ error: { message: 'Invalid API Key provided: sk_test_dead' } }, 401);
      }
      if (path === '/v1/balance') {
        return send({ object: 'balance', livemode: false, available: [{ amount: 2500, currency: 'usd' }] });
      }
      if (path === '/v1/webhook_endpoints') {
        return send({
          object: 'list',
          data: [
            {
              id: 'we_test_live',
              object: 'webhook_endpoint',
              url: stripeEndpointUrl || `${base}/api/public/stripe/webhook`,
              status: 'enabled',
              enabled_events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'],
            },
          ],
        });
      }
      if (path.startsWith('/v1/checkout/sessions/') && path.endsWith('/expire')) {
        return send({ id: path.split('/')[4], object: 'checkout.session', status: 'expired' });
      }
      return send({
        id: `cs_test_${stripeCalls.length}`,
        object: 'checkout.session',
        url: `https://checkout.stripe.test/c/cs_test_${stripeCalls.length}`,
      });
    });
  });
  await new Promise((resolve) => stripeStub.listen(0, '127.0.0.1', resolve));
  const stripePort = stripeStub.address().port;

  // Mailjet stand-in: it records what the adapter sent, so the second provider
  // is checked by its request shape and not only by "the call returned".
  mailjetStub = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      mailjetCalls.push({ path: request.url, body, authorization: request.headers.authorization || '' });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Messages: [{ Status: 'success', To: [{ MessageID: 'mj_smoke_1' }] }] }));
    });
  });
  await new Promise((resolve) => mailjetStub.listen(0, '127.0.0.1', resolve));
  const mailjetPort = mailjetStub.address().port;
  server = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      // The same origin the stub will claim is registered in Stripe, so the
      // connection test compares like with like.
      PUBLIC_URL: base,
      SESSION_SECRET: `smoke-${Date.now()}`,
      SUBMISSION_LIMIT_PER_HOUR: '500',
      TELEPHONY_SIMULATED: 'true',
      // Escalation is compressed for the test: a final notice at 21 days and no
      // grace period, so one sweep proves the whole path. Production defaults
      // are 30 days and 14 days of grace.
      FINAL_NOTICE_DAYS: '21',
      SUSPEND_GRACE_DAYS: '0',
      // Card payment, pointed at the stub above. The webhook secret is what the
      // signed callbacks below are checked against.
      STRIPE_API_URL: `http://127.0.0.1:${stripePort}`,
      STRIPE_SECRET_KEY: 'sk_test_smoke',
      STRIPE_WEBHOOK_SECRET: 'whsec_smoke',
      // The mail adapter must never reach the real provider from a test run.
      // Pointing it at a closed loopback port makes "the key was used" and
      // "there is no key" distinguishable without sending anything.
      RESEND_API_URL: 'http://127.0.0.1:1',
      // Mailjet goes to a live stub: the point of this provider is the request
      // it builds, which a closed port cannot show.
      MAILJET_API_URL: `http://127.0.0.1:${mailjetPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => (log += chunk));
  server.stderr.on('data', (chunk) => (log += chunk));
  // The child keeps this process alive, so it must be stopped explicitly at the
  // end of the run — an `exit` handler alone would never fire.
  globalThis.__smokeStopServer = () => {
    if (server && !server.killed) server.kill();
    if (stripeStub) stripeStub.close();
    if (mailjetStub) mailjetStub.close();
  };
  process.on('exit', globalThis.__smokeStopServer);

  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) {
    server.kill();
    console.error(`\nCould not start a test server on ${base}\n${log.slice(-1500)}`);
    process.exit(1);
  }
}

const email = process.env.SMOKE_EMAIL || 'owner@telno.local';
const password = process.env.SMOKE_PASSWORD || 'telno-demo-owner';

const FIXTURE_NUMBER = '+1 415 555 0177';
const FIXTURE_E164 = '+14155550177';
const SUBMISSION_NUMBER = '+44 20 7946 0999';
const SUBMISSION_E164 = '+442079460999';
const OPTED_OUT_NUMBER = '+1 212 555 0142';

let passed = 0;
const failures = [];
let cookie = '';
let token = '';

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

async function call(method, path, body, opts = {}) {
  const headers = { accept: 'application/json', ...(opts.headers || {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie && !opts.noCookie) headers.cookie = cookie;
  if (opts.bearer ?? token) headers.authorization = `Bearer ${opts.bearer ?? token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !opts.noCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json, headers: res.headers };
}

/** Raw upload: the body is the file, the content type is its real type. */
async function upload(method, path, buffer, type, opts = {}) {
  const headers = { 'content-type': type, ...(opts.headers || {}) };
  if (cookie && !opts.noCookie) headers.cookie = cookie;
  if (opts.bearer ?? token) headers.authorization = `Bearer ${opts.bearer ?? token}`;
  const res = await fetch(base + path, { method, headers, body: buffer });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

/** Fetches media and reports its status, type and byte length. */
async function fetchMedia(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie && !opts.noCookie) headers.cookie = cookie;
  if (opts.bearer ?? token) headers.authorization = `Bearer ${opts.bearer ?? token}`;
  const res = await fetch(base + path, { headers });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', length: buffer.length };
}

// A 44-byte WAV header and a minimal PDF: enough to prove type and length.
const SAMPLE_WAV = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');
const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const encode = encodeURIComponent;

console.log(`\nTelno smoke test → ${base}\n`);

// ------------------------------------------------------------------ public --
const health = await call('GET', '/api/healthz');
check('health endpoint', health.status === 200 && health.body.ok === true, health.body);

const domains = await call('GET', '/api/public/domains');
check(
  'six directory hosts are served',
  domains.status === 200 && domains.body.domains.length === 6,
  domains.body.domains?.map((d) => d.host)
);
check(
  'every requested domain present',
  [
    'telno.directory',
    'num.directory',
    'number.directory',
    'directory.telno.services',
    'directory.pbx.services',
    'directory.pbx.technology',
  ].every((h) => domains.body.domains.some((d) => d.host === h)),
  domains.body.domains?.map((d) => d.host)
);

const stats = await call('GET', '/api/public/stats');
check('public stats', stats.status === 200 && stats.body.numbers > 0, stats.body);

const textSearch = await call('GET', '/api/public/search?q=coffee');
check('text search finds a cafe', textSearch.status === 200 && textSearch.body.results.length > 0, textSearch.body);
check('search reports text mode', textSearch.body.mode === 'text', textSearch.body.mode);

const numberSearch = await call('GET', '/api/public/search?q=%2B14155550117');
check('numeric search hits the number index', numberSearch.body.mode === 'number' && numberSearch.body.results.length > 0, numberSearch.body);

const lookup = await call('GET', '/api/public/lookup?number=415-555-0117');
check(
  'lookup normalizes a national-looking input',
  lookup.status === 200 && lookup.body.found === true && lookup.body.parsed.e164 === '+14155550117',
  lookup.body
);

const badLookup = await call('GET', '/api/public/lookup?number=12');
check('impossible number is rejected', badLookup.status === 400, badLookup.body);

const countries = await call('GET', '/api/public/countries');
check('country catalog is worldwide', countries.body.countries.length > 200, countries.body.countries?.length);

// -------------------------------------------------------------------- auth --
const badLogin = await call('POST', '/api/auth/login', { email, password: 'wrong-password' });
check('wrong password is rejected', badLogin.status === 401, badLogin.body);

const login = await call('POST', '/api/auth/login', { email, password });
check('owner can sign in', login.status === 200 && !!login.body.token, login.body);
token = login.body.token || '';
check('session cookie is set', cookie.startsWith('telno_session='), cookie.slice(0, 30));

const me = await call('GET', '/api/auth/me');
check('session resolves to the account', me.status === 200 && me.body.user.email === email, me.body);

const anon = await call('GET', '/api/numbers', undefined, { bearer: '', noCookie: true });
check('registry requires auth', anon.status === 401, anon.body);

// ---------------------------------------------------------------- fixtures --
// Remove anything a previous run left behind so assertions stay deterministic.
for (const value of [FIXTURE_NUMBER, SUBMISSION_NUMBER]) {
  const found = await call('GET', `/api/numbers/lookup/${encode(value)}`);
  if (found.body.number?.id) await call('DELETE', `/api/numbers/${found.body.number.id}`);
}
const oldExtensions = await call('GET', '/api/extensions');
const oldFixture = oldExtensions.body.items?.find((e) => e.extension === '299');
if (oldFixture) await call('DELETE', `/api/extensions/${oldFixture.id}`);
const oldHeld = oldExtensions.body.items?.find((e) => e.extension === '298');
if (oldHeld) await call('DELETE', `/api/extensions/${oldHeld.id}`);
await call('DELETE', `/api/optouts/${encode(OPTED_OUT_NUMBER)}`);

// ---------------------------------------------------------------- registry --
const list = await call('GET', '/api/numbers?limit=5');
check('number list', list.status === 200 && list.body.items.length === 5, list.body);

const created = await call('POST', '/api/numbers', {
  number: FIXTURE_NUMBER,
  name: 'Smoke Test Company',
  kind: 'business',
  category: 'Testing',
  city: 'San Francisco',
  country: 'US',
  website: 'https://smoke.example',
});
check('number created', created.status === 201 && created.body.created === true, created.body);
const createdId = created.body.number?.id;

const duplicate = await call('POST', '/api/numbers', {
  number: '14155550177',
  name: 'Smoke Test Co.',
  kind: 'business',
});
check(
  'same number in another format dedupes to one row',
  duplicate.status === 200 && duplicate.body.deduplicated === true && duplicate.body.number.id === createdId,
  { status: duplicate.status, deduped: duplicate.body.deduplicated, sameId: duplicate.body.number?.id === createdId }
);

const listingAgain = await call('POST', `/api/numbers/${createdId}/listings`, {
  name: 'Smoke Test Company',
  kind: 'business',
});
check('identical listing is not duplicated', listingAgain.status === 200 && listingAgain.body.deduplicated === true, listingAgain.body);

const invalid = await call('POST', '/api/numbers', { number: 'not-a-phone' });
check('garbage number is rejected', invalid.status === 400, invalid.body);

// -------------------------------------------------------------- submissions --
const submission = await call('POST', '/api/public/submissions', {
  number: SUBMISSION_NUMBER,
  name: 'Southwark Cycle Works',
  kind: 'business',
  category: 'Repairs',
  city: 'London',
  country: 'GB',
  email: 'shop@southwarkcycle.example',
  channel: 'email',
  domain: 'telno.directory',
});
check('submission accepted', submission.status === 201 && submission.body.status === 'awaiting_verification', submission.body);
const submissionId = submission.body.id;
const devCode = submission.body.devCode;
check('verification code issued in dev mode', typeof devCode === 'string' && devCode.length === 6, devCode);

const wrongCode = await call('POST', `/api/public/submissions/${submissionId}/verify`, { code: '000000' });
check('wrong code rejected', wrongCode.status === 400, wrongCode.body);

const verified = await call('POST', `/api/public/submissions/${submissionId}/verify`, { code: devCode });
check('correct code verifies', verified.status === 200 && verified.body.status === 'verified', verified.body);

const notYetPublic = await call('GET', '/api/public/search?q=Southwark');
check(
  'verified but unapproved listing is not public yet',
  notYetPublic.body.results.length === 0,
  notYetPublic.body
);

const approve = await call('POST', `/api/submissions/${submissionId}/approve`, {});
check('verified submission can be approved', approve.status === 200, approve.body);

const afterApprove = await call('GET', '/api/public/search?q=Southwark');
check(
  'approved listing is publicly searchable',
  afterApprove.body.results.some((r) => r.name === 'Southwark Cycle Works'),
  afterApprove.body
);

const honeypot = await call('POST', '/api/public/submissions', {
  number: '+1 212 555 0188',
  name: 'Bot Entry',
  company_url: 'https://spam.example',
});
// The endpoint is rate limited per hour, so a repeat run can legitimately be
// turned away; either way the bot entry must never reach the review queue.
check(
  'honeypot is answered normally (or rate limited) and never acknowledged',
  (honeypot.status === 200 && honeypot.body.status === 'received') || honeypot.status === 429,
  honeypot.body
);
const queueAfterBot = await call('GET', '/api/submissions');
check(
  'honeypot never reaches the review queue',
  queueAfterBot.status === 200 && !JSON.stringify(queueAfterBot.body).includes('Bot Entry'),
  queueAfterBot.body?.items?.length
);

const missingApprove = await call('POST', '/api/submissions/does-not-exist/approve', {});
check('approving a missing submission 404s', missingApprove.status === 404, missingApprove.body);

// ------------------------------------------------------------------ opt-out --
const visibleBefore = await call('GET', `/api/public/lookup?number=${encode(FIXTURE_NUMBER)}`);
check('fixture number is visible before opt-out', visibleBefore.body.found === true, visibleBefore.body);

const optout = await call('POST', '/api/public/optout', { number: FIXTURE_NUMBER, reason: 'smoke test' });
check('opt-out accepted', optout.status === 200, optout.body);

const afterOptout = await call('GET', `/api/public/lookup?number=${encode(FIXTURE_NUMBER)}`);
check('opted-out number disappears from public view', afterOptout.body.found === false, afterOptout.body);

const optedOutSearch = await call('GET', '/api/public/search?q=Smoke%20Test');
check(
  'opted-out number is excluded from search',
  !optedOutSearch.body.results.some((r) => r.e164 === FIXTURE_E164),
  optedOutSearch.body.results?.map((r) => r.e164)
);

const restored = await call('DELETE', `/api/optouts/${encode(FIXTURE_NUMBER)}`);
check('opt-out can be reversed', restored.status === 200 && restored.body.ok === true, restored.body);

const visibleAgain = await call('GET', `/api/public/lookup?number=${encode(FIXTURE_NUMBER)}`);
check('reversed opt-out restores public visibility', visibleAgain.body.found === true, visibleAgain.body);

// ---------------------------------------------------------------- telephony --
const extensions = await call('GET', '/api/extensions');
check('extensions listed', extensions.status === 200 && extensions.body.items.length >= 5, extensions.body.items?.length);

const newExtension = await call('POST', '/api/extensions', {
  extension: '299',
  displayName: 'Smoke Desk',
  voicemail: true,
});
check('extension created with a generated secret', newExtension.status === 201 && !!newExtension.body.secret, newExtension.body);

const rotate = await call('POST', `/api/extensions/${newExtension.body.extension?.id}/rotate-secret`, {});
check('secret can be rotated', rotate.status === 200 && !!rotate.body.secret, rotate.body);

const status = await call('GET', '/api/system/status');
check('system status', status.status === 200 && !!status.body.telephony, status.body);
check('telephony reports simulated when no switch', status.body.telephony.simulated === true, status.body.telephony);

const preview = await call('GET', '/api/system/config-preview?file=pjsip.conf');
// The desk endpoint is named after the extension and the browser endpoint is
// `webrtc-<ext>`, because chan_pjsip matches a registration against the
// endpoint of the same name. Assert both halves of that contract.
check(
  'generated pjsip config contains the new extension',
  preview.status === 200 &&
    /\n\[299\]\ntype=endpoint/.test(preview.body.content) &&
    /\n\[webrtc-299\]\ntype=endpoint/.test(preview.body.content),
  preview.body.content?.slice(0, 160)
);
check(
  'each endpoint authenticates as its own name',
  preview.status === 200 &&
    /\n\[299-auth\]\ntype=auth[\s\S]*?\nusername=299\n/.test(preview.body.content) &&
    /\n\[webrtc-299-auth\]\ntype=auth[\s\S]*?\nusername=webrtc-299\n/.test(preview.body.content),
  'endpoint and auth user must match for endpoint identification'
);

const dialplan = await call('GET', '/api/system/config-preview?file=extensions.conf');
check(
  'dialplan has internal and outbound contexts',
  dialplan.body.content.includes('[internal]') && dialplan.body.content.includes('[outbound]'),
  dialplan.body.content?.slice(0, 160)
);

const calls = await call('GET', '/api/calls/stats');
check('call stats', calls.status === 200 && calls.body.last24h.total >= 0, calls.body);

// -------------------------------------------------------------- workspace --
for (const [name, path, minimum] of [
  ['voice agents', '/api/voice/agents', 1],
  ['workflows', '/api/workflows', 1],
  ['voicemails', '/api/voicemails', 1],
  ['faxes', '/api/faxes', 1],
  ['messages', '/api/messages', 1],
  ['invoices', '/api/billing/invoices', 1],
  ['sites', '/api/estate/sites', 1],
  ['tasks', '/api/operations/tasks', 1],
]) {
  const res = await call('GET', path);
  check(
    `${name} list is served`,
    res.status === 200 && Array.isArray(res.body.items) && res.body.items.length >= minimum,
    res.body
  );
}

const healthSummary = await call('GET', '/api/health/summary');
check(
  'health summary reports every probe dimension',
  healthSummary.status === 200 && ['counts', 'runtime', 'telephony', 'channels'].every((k) => k in healthSummary.body),
  healthSummary.body
);

const healthRun = await call('POST', '/api/health/checks/run', {});
check(
  'running probes records one row per target',
  healthRun.status === 200 && healthRun.body.checks.length >= 5 && healthRun.body.counts.down === 0,
  healthRun.body?.counts
);
check(
  'database probe is up',
  healthRun.body.checks.some((probe) => probe.target === 'database' && probe.status === 'up'),
  healthRun.body?.checks?.map((probe) => `${probe.target}:${probe.status}`)
);

// Voice agent lifecycle.
const agent = await call('POST', '/api/voice/agents', {
  name: `Smoke Agent ${Date.now()}`,
  greeting: 'Smoke test greeting.',
  status: 'draft',
});
check('voice agent created as a draft', agent.status === 201 && agent.body.agent.status === 'draft', agent.body);

const activated = await call('PATCH', `/api/voice/agents/${agent.body.agent?.id}`, { status: 'active' });
check('voice agent can be activated', activated.status === 200 && activated.body.agent.status === 'active', activated.body);

const editedAgent = await call('PATCH', `/api/voice/agents/${agent.body.agent?.id}`, {
  prompt: 'Updated script from the smoke test.',
  recordInbound: true,
  recordOutbound: false,
});
check(
  'the script and recording policy are editable',
  editedAgent.status === 200 &&
    editedAgent.body.agent.recordInbound === true &&
    editedAgent.body.agent.recordOutbound === false &&
    editedAgent.body.agent.prompt.includes('smoke test'),
  editedAgent.body.agent
);

const agentNumber = await call('PATCH', `/api/voice/agents/${agent.body.agent?.id}`, { number: FIXTURE_NUMBER });
check(
  'voice agent attaches the canonical registry number',
  agentNumber.status === 200 && agentNumber.body.agent.number === '+1 415 555 0177',
  agentNumber.body.agent?.number
);

const agentGone = await call('DELETE', `/api/voice/agents/${agent.body.agent?.id}`);
check('voice agent deleted', agentGone.status === 200 && agentGone.body.ok === true, agentGone.body);

// Workflow lifecycle, including the two refusal paths.
const workflow = await call('POST', '/api/workflows', {
  name: `Smoke Flow ${Date.now()}`,
  trigger: 'manual',
  steps: [
    { type: 'dial', label: 'ring', target: '201' },
    { type: 'sms', label: 'text', target: 'https://example.test' },
  ],
});
check('workflow created', workflow.status === 201 && workflow.body.workflow.steps.length === 2, workflow.body);

const draftRun = await call('POST', `/api/workflows/${workflow.body.workflow?.id}/run`, {});
check('a draft workflow refuses to run', draftRun.status === 409, draftRun.body);

await call('PATCH', `/api/workflows/${workflow.body.workflow?.id}`, { status: 'active' });
const ran = await call('POST', `/api/workflows/${workflow.body.workflow?.id}/run`, {});
check(
  'an active workflow runs and records the run',
  ran.status === 200 && ran.body.ok === true && ran.body.workflow.runs === 1 && ran.body.workflow.lastStatus === 'success',
  ran.body.workflow
);

const badFlow = await call('POST', '/api/workflows', {
  name: `Smoke Bad Flow ${Date.now()}`,
  status: 'active',
  steps: [{ type: 'teleport', label: 'impossible', target: '' }],
});
const badRun = await call('POST', `/api/workflows/${badFlow.body.workflow?.id}/run`, {});
check(
  'an unknown step type fails the run instead of passing silently',
  badRun.status === 200 && badRun.body.ok === false && badRun.body.workflow.lastStatus === 'failed',
  badRun.body
);
await call('DELETE', `/api/workflows/${badFlow.body.workflow?.id}`);
await call('DELETE', `/api/workflows/${workflow.body.workflow?.id}`);

// Voicemail state, fax queue, message delivery facts.
const voicemail = await call('GET', '/api/voicemails');
const firstMail = voicemail.body.items?.[0];
const marked = await call('PATCH', `/api/voicemails/${firstMail?.id}`, { listened: true });
check('voicemail can be marked heard', marked.status === 200 && marked.body.voicemail.listened === true, marked.body);

// Voicemail audio: attachable, playable, private.
const attachedAudio = await upload('PUT', `/api/voicemails/${firstMail?.id}/audio`, SAMPLE_WAV, 'audio/wav');
check('voicemail audio can be attached', attachedAudio.status === 200 && attachedAudio.body.voicemail.recording === true, attachedAudio.body);
const mailAudio = await fetchMedia(`/api/voicemails/${firstMail?.id}/audio`);
check(
  'voicemail audio streams with a playable type',
  mailAudio.status === 200 && mailAudio.type.startsWith('audio/') && mailAudio.length === SAMPLE_WAV.length,
  mailAudio
);
const anonAudio = await fetchMedia(`/api/voicemails/${firstMail?.id}/audio`, { noCookie: true, bearer: '' });
check('voicemail audio is not public', anonAudio.status === 401, anonAudio);
const badUpload = await upload('PUT', `/api/voicemails/${firstMail?.id}/audio`, Buffer.from('not audio'), 'text/plain');
check('an unsupported upload type is refused', badUpload.status === 400, badUpload.body);

// Call recordings are stored and streamed the same way.
const callRows = await call('GET', '/api/calls?limit=60');
const callTarget = callRows.body.items?.[0];
const callUpload = await upload('PUT', `/api/calls/${callTarget?.id}/audio`, SAMPLE_WAV, 'audio/wav');
check('a call recording can be attached', callUpload.status === 200 && callUpload.body.call.recording === true, callUpload.body);
const callAudio = await fetchMedia(`/api/calls/${callTarget?.id}/audio`);
check(
  'call recordings play back',
  callAudio.status === 200 && callAudio.type.startsWith('audio/') && callAudio.length === SAMPLE_WAV.length,
  callAudio
);

const fax = await call('POST', '/api/faxes', {
  to: FIXTURE_NUMBER,
  subject: 'Smoke fax',
  pages: 2,
  body: 'Plain text page from the smoke test.',
});
check('outbound fax is queued', fax.status === 201 && fax.body.fax.status === 'queued', fax.body);
check('a fax can be a plain-text page', fax.body.fax.body.includes('smoke test'), fax.body.fax);

const faxAttached = await upload('PUT', `/api/faxes/${fax.body.fax?.id}/attachment`, SAMPLE_PDF, 'application/pdf', {
  headers: { 'x-file-name': 'smoke.pdf' },
});
check(
  'a fax can carry an uploaded document',
  faxAttached.status === 200 && faxAttached.body.fax.attachmentName === 'smoke.pdf',
  faxAttached.body
);
const faxDownload = await fetchMedia(`/api/faxes/${fax.body.fax?.id}/attachment`);
check(
  'the fax attachment downloads with its own type',
  faxDownload.status === 200 && faxDownload.type === 'application/pdf' && faxDownload.length > 10,
  faxDownload
);
const faxSent = await call('PATCH', `/api/faxes/${fax.body.fax?.id}`, { status: 'sending' });
check('fax advances to sending', faxSent.status === 200 && faxSent.body.fax.status === 'sending', faxSent.body);

const message = await call('POST', '/api/messages', {
  channel: 'sms',
  to: '+1 415 555 0177',
  body: 'Smoke test message.',
});
check(
  'message resolves the number and is not claimed delivered',
  message.status === 201 && message.body.message.to === '+1 415 555 0177' && message.body.message.status === 'queued',
  message.body
);
const delivered = await call('PATCH', `/api/messages/${message.body.message?.id}`, { status: 'delivered' });
check('message delivery is an explicit transition', delivered.status === 200 && delivered.body.message.status === 'delivered', delivered.body);

// Billing: money stays integer, payment stamps a time.
const invoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Smoke Test Ltd',
  email: 'billing@smoke.example',
  amountCents: 12345,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
});
check('invoice created in minor units', invoice.status === 201 && invoice.body.invoice.amountCents === 12345, invoice.body);

const corrected = await call('PATCH', `/api/billing/invoices/${invoice.body.invoice?.id}`, {
  amountCents: 13000,
  notes: 'Corrected after review',
  dueAt: '2026-02-14',
});
check(
  'an invoice can be corrected before it is settled',
  corrected.status === 200 && corrected.body.invoice.amountCents === 13000 && corrected.body.invoice.notes.includes('Corrected'),
  corrected.body.invoice
);

const resent = await call('POST', `/api/billing/invoices/${invoice.body.invoice?.id}/resend`, {});
check(
  'an invoice can be resent and records the send',
  resent.status === 200 && resent.body.sent === true && !!resent.body.invoice.lastSentAt,
  resent.body
);
check(
  'the send names the provider that carried it',
  resent.body.invoice.lastProvider === 'console' && resent.body.invoice.lastSendError === '',
  { provider: resent.body.invoice.lastProvider, error: resent.body.invoice.lastSendError }
);

// The mail a customer receives is built from the invoice row, not from the
// route: the HTML and the text part have to agree on the amount and the date.
const rendered = invoiceEmail({
  invoice_no: 'INV-2026-0099',
  account_name: 'Harbour & Finch Ltd',
  period_start: '2026-01-01T00:00:00.000Z',
  period_end: '2026-01-31T00:00:00.000Z',
  amount_cents: 13000,
  currency: 'USD',
  status: 'open',
  issued_at: '2026-02-01T00:00:00.000Z',
  due_at: '2026-02-14T00:00:00.000Z',
  paid_at: null,
  notes: 'Two seats added mid-month.',
});
check(
  'an invoice is sent as HTML with the amount and the due date',
  rendered.html.includes('$130.00') && rendered.html.includes('02/14/2026') &&
    rendered.html.startsWith('<!doctype html>') && rendered.subject.includes('$130.00'),
  rendered.subject
);
check(
  'the text part says the same thing as the HTML',
  rendered.text.includes('$130.00') && rendered.text.includes('Due: 02/14/2026'),
  rendered.text
);

// A reminder is the same card with a different point: the amount, the due date
// and how late the invoice is, in the subject, the HTML and the text.
const reminder = reminderEmail(
  {
    invoice_no: 'INV-2026-0101',
    account_name: 'Harbour & Finch Ltd',
    period_start: '2026-01-01T00:00:00.000Z',
    period_end: '2026-01-31T00:00:00.000Z',
    amount_cents: 13000,
    currency: 'USD',
    status: 'overdue',
    due_at: '2026-02-14T00:00:00.000Z',
    notes: 'Two seats added mid-month.',
  },
  { stageDays: 7, daysPastDue: 9 }
);
check(
  'a reminder is HTML carrying the amount, the due date and how late it is',
  reminder.html.startsWith('<!doctype html>') &&
    reminder.html.includes('$130.00') &&
    reminder.html.includes('02/14/2026') &&
    reminder.html.includes('9 days past due') &&
    reminder.subject.includes('$130.00') &&
    reminder.subject.includes('02/14/2026'),
  reminder.subject
);
check(
  'the reminder text part carries the same facts',
  reminder.text.includes('$130.00') && reminder.text.includes('02/14/2026') && reminder.text.includes('9 days past due'),
  reminder.text
);
check(
  'an account name is escaped rather than injected into the markup',
  rendered.html.includes('Harbour &amp; Finch Ltd') && !rendered.html.includes('Harbour & Finch Ltd'),
  'unescaped'
);

// A final notice has one job the reminder does not: name the day service stops.
const finalNotice = finalNoticeEmail(
  {
    invoice_no: 'INV-2026-0101',
    account_name: 'Harbour & Finch Ltd',
    period_start: '2026-01-01T00:00:00.000Z',
    period_end: '2026-01-31T00:00:00.000Z',
    amount_cents: 13000,
    currency: 'USD',
    status: 'overdue',
    due_at: '2026-02-14T00:00:00.000Z',
    notes: '',
  },
  { suspendOn: '2026-03-30', daysPastDue: 31, payUrl: 'https://pay.telno.test/i/INV-2026-0101' }
);
check(
  'a final notice is HTML carrying the balance, the due date and the day service stops',
  finalNotice.html.startsWith('<!doctype html>') &&
    finalNotice.html.includes('$130.00') &&
    finalNotice.html.includes('02/14/2026') &&
    finalNotice.html.includes('03/30/2026') &&
    finalNotice.html.includes('31 days past due') &&
    finalNotice.subject.includes('Final notice') &&
    finalNotice.subject.includes('03/30/2026'),
  finalNotice.subject
);
check(
  'the final notice text part says the same thing',
  finalNotice.text.includes('$130.00') && finalNotice.text.includes('03/30/2026') &&
    finalNotice.text.includes('FINAL NOTICE'),
  finalNotice.text
);
check(
  'the final notice carries a Pay now button that opens the payment page',
  finalNotice.html.includes('href="https://pay.telno.test/i/INV-2026-0101"') &&
    finalNotice.html.includes('Pay $130.00 now') &&
    finalNotice.text.includes('Pay online: https://pay.telno.test/i/INV-2026-0101'),
  finalNotice.subject
);
check(
  'no payment link is built while this process has no Stripe key',
  payUrlForInvoice({ id: 'inv_none', status: 'open' }) === '' &&
    payUrlForInvoice({ id: 'inv_none', status: 'paid' }) === '',
  'a link was built without a key'
);
check(
  'a notice without a payment page carries no button',
  !finalNoticeEmail(
    { invoice_no: 'INV-1', account_name: 'A', amount_cents: 100, currency: 'USD', status: 'overdue', due_at: '2026-02-14' },
    { suspendOn: '2026-03-30', daysPastDue: 31 }
  ).html.includes('Pay now'),
  'button leaked'
);

const suspendedMail = suspensionEmail({
  accountName: 'Harbour & Finch Ltd',
  email: 'ap@example.com',
  amount: 13000,
  currency: 'USD',
  suspendOn: '2026-03-30',
  suspendedAt: '2026-03-31T15:00:00.000Z',
  extensionCount: 3,
  invoiceNumbers: ['INV-2026-0101'],
  payUrl: 'https://pay.telno.test/a/acct_1',
});
check(
  'the suspension email says what stopped and how to restore it',
  suspendedMail.html.includes('$130.00') &&
    suspendedMail.html.includes('03/30/2026') &&
    suspendedMail.html.includes('03/31/2026') &&
    suspendedMail.html.includes('restores service automatically') &&
    suspendedMail.text.includes('SERVICE SUSPENDED'),
  suspendedMail.subject
);
check(
  'the suspension email pays the whole balance from one button',
  suspendedMail.html.includes('href="https://pay.telno.test/a/acct_1"') &&
    suspendedMail.html.includes('Pay $130.00 now') &&
    suspendedMail.text.includes('Pay online: https://pay.telno.test/a/acct_1'),
  suspendedMail.subject
);

const noEmailInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'No Email Ltd',
  amountCents: 1000,
  currency: 'USD',
  periodStart: '2026-02-01',
  periodEnd: '2026-02-28',
});
const resendRefused = await call('POST', `/api/billing/invoices/${noEmailInvoice.body.invoice?.id}/resend`, {});
check('resending without an email is refused', resendRefused.status === 400, resendRefused.body);

const paid = await call('PATCH', `/api/billing/invoices/${invoice.body.invoice?.id}`, { status: 'paid' });
check('marking paid records a payment timestamp', paid.status === 200 && paid.body.invoice.status === 'paid' && !!paid.body.invoice.paidAt, paid.body);

const billing = await call('GET', '/api/billing/invoices');
check(
  'billing totals are grouped per currency',
  billing.status === 200 && billing.body.summary.byCurrency.length >= 2 &&
    billing.body.summary.byCurrency.every((row) => typeof row.openCents === 'number'),
  billing.body.summary
);

// Automatic reminders. The ladder is a ledger: a rung that has been sent can
// never be sent again, so a sweep, a restart or an impatient operator cannot
// produce a duplicate email.
const overdueInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Overdue Smoke Co',
  email: 'ap@overdue-smoke.example',
  amountCents: 9900,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
});
const overdueId = overdueInvoice.body.invoice?.id;
check('an invoice can be issued with a past due date', overdueInvoice.status === 201 && !!overdueId, overdueInvoice.body);

const sweep = await call('POST', '/api/billing/reminders/run', {});
const swept = sweep.body.items?.find((item) => item.id === overdueId);
check(
  'the sweep marks a past-due invoice overdue and reminds it once',
  sweep.status === 200 && swept?.action === 'sent' && swept.stage === 7,
  { swept, summary: { checked: sweep.body.checked, sent: sweep.body.sent } }
);
check(
  'rungs the ladder overtook are recorded as skipped, not sent late',
  Array.isArray(swept?.skippedStages) && swept.skippedStages.includes(1) && swept.skippedStages.includes(3),
  swept
);

const overdueNow = await call('GET', `/api/billing/invoices/${overdueId}/reminders`);
check(
  'the reminder ledger keeps the send and the skipped rungs',
  overdueNow.status === 200 &&
    overdueNow.body.items.some((row) => row.status === 'sent' && row.stageDays === 7) &&
    overdueNow.body.items.filter((row) => row.status === 'skipped').length === 2,
  overdueNow.body.items
);

const secondSweep = await call('POST', '/api/billing/reminders/run', {});
const rematched = secondSweep.body.items?.find((item) => item.id === overdueId);
check(
  'a second sweep does not send the same reminder again',
  secondSweep.status === 200 && rematched?.action === 'skipped' && rematched.reason === 'recently-reminded',
  rematched
);

const paused = await call('PATCH', `/api/billing/invoices/${overdueId}`, { remindersPaused: true });
const pausedSend = await call('POST', `/api/billing/invoices/${overdueId}/reminder`, {});
check(
  'a paused invoice is not reminded, even by hand',
  paused.status === 200 &&
    paused.body.invoice.remindersPaused === true &&
    pausedSend.body.action === 'skipped' &&
    pausedSend.body.reason === 'paused',
  { paused: paused.body.invoice?.remindersPaused, send: pausedSend.body }
);

await call('PATCH', `/api/billing/invoices/${overdueId}`, { remindersPaused: false });
const manualReminder = await call('POST', `/api/billing/invoices/${overdueId}/reminder`, {});
check(
  'an operator can send a reminder now, past the gap',
  manualReminder.status === 200 && manualReminder.body.action === 'sent' && manualReminder.body.simulated === true,
  manualReminder.body
);

await call('PATCH', `/api/billing/invoices/${overdueId}`, { status: 'paid' });
const paidReminder = await call('POST', `/api/billing/invoices/${overdueId}/reminder`, {});
check('a paid invoice is never reminded', paidReminder.status === 409, paidReminder.body);

const reminderSummary = await call('GET', '/api/billing/invoices');
check(
  'billing reports the reminder schedule it is running',
  reminderSummary.body.summary.reminders?.enabled === true &&
    JSON.stringify(reminderSummary.body.summary.reminders.scheduleDays) === JSON.stringify([1, 3, 7, 14, 30]),
  reminderSummary.body.summary.reminders
);

// Escalation. The billing identity is a real non-owner login, so the switch-off
// can be proved at every layer: the invoice, the extension, the sign-in and the
// automatic restoration once it is paid.
const heldLogin = 'ops@telno.local';
const escalationInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Escalation Smoke Co',
  email: heldLogin,
  amountCents: 5000,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10),
});
const escalationId = escalationInvoice.body.invoice?.id;
const heldExtension = await call('POST', '/api/extensions', {
  extension: '298',
  displayName: 'Billing hold smoke',
  email: heldLogin,
  voicemail: false,
});
check(
  'a fixture extension exists for the account being suspended',
  escalationInvoice.status === 201 && heldExtension.status === 201 && !!escalationId,
  { invoice: escalationInvoice.body, extension: heldExtension.body }
);

const finalSweep = await call('POST', '/api/billing/reminders/run', {});
const finalItem = finalSweep.body.items?.find((item) => item.id === escalationId);
check(
  'twenty-five days late sends a final notice instead of another reminder',
  finalItem?.action === 'sent' && finalItem.kind === 'final' && finalItem.stage === 0,
  finalItem
);
check(
  'the final notice names the day service stops',
  /^\d{4}-\d{2}-\d{2}$/.test(finalItem?.suspendOn || ''),
  finalItem?.suspendOn
);

const finalLedger = await call('GET', `/api/billing/invoices/${escalationId}/reminders`);
check(
  'the ledger records the final notice as its own kind',
  finalLedger.body.items?.some((row) => row.kind === 'final' && row.status === 'sent'),
  finalLedger.body.items
);
check(
  'the rungs the notice replaced are spent, not sent after it',
  finalLedger.body.items.filter((row) => row.kind === 'reminder' && row.status === 'skipped').length >= 4,
  finalLedger.body.items
);

const dunningList = await call('GET', '/api/billing/accounts');
const heldAccount = dunningList.body.items?.find((row) => row.email === heldLogin);
check(
  'the billing account is suspended once its stated date arrives',
  heldAccount?.state === 'suspended' && !!heldAccount.suspendedAt,
  heldAccount
);
check(
  'suspension switched off the extensions on that account',
  heldAccount?.extensionsOff === 1 && heldAccount?.loginsBlocked === 1,
  heldAccount
);
check('the customer is told what happened', !!heldAccount?.noticeSentAt, heldAccount);

const extensionsAfterHold = (await call('GET', '/api/extensions')).body.items || [];
const heldNow = extensionsAfterHold.find((row) => row.extension === '298');
check(
  'the suspended extension is disabled and the platform says why',
  heldNow?.enabled === false && heldNow?.suspendedByBilling === true,
  heldNow
);

const blockedLogin = await call('POST', '/api/auth/login', { email: heldLogin, password }, { noCookie: true });
check(
  'a suspended customer cannot sign in, even with the right password',
  blockedLogin.status === 402 && blockedLogin.body.error?.code === 'payment_required',
  blockedLogin.body
);
const ownerStillIn = await call('GET', '/api/auth/me');
check('an unrelated suspension leaves the owner signed in', ownerStillIn.status === 200, ownerStillIn.body);

// The owner is never locked out, even when the invoice on the owner's own billing
// email goes bad: locking the last administrator out is not a billing remedy.
const ownerInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Owner Billing Hold',
  email: 'owner@telno.local',
  amountCents: 12000,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
});
await call('POST', '/api/billing/reminders/run', {});
const ownerAccount = (await call('GET', '/api/billing/accounts')).body.items?.find(
  (row) => row.email === 'owner@telno.local'
);
const ownerAfter = await call('GET', '/api/auth/me');
check(
  'the owner account is warned and suspended like any other, but never blocked',
  ownerAccount?.state === 'suspended' && ownerAccount.loginsBlocked === 0 && ownerAfter.status === 200,
  { account: ownerAccount, me: ownerAfter.status }
);
await call('PATCH', `/api/billing/invoices/${ownerInvoice.body.invoice?.id}`, { status: 'paid' });
await call('POST', '/api/billing/reminders/run', {});
const ownerRestored = (await call('GET', '/api/billing/accounts')).body.items?.find(
  (row) => row.email === 'owner@telno.local'
);
check('paying the owner invoice restores the owner account too', ownerRestored?.state === 'current', ownerRestored);

const afterHoldSweep = await call('POST', '/api/billing/reminders/run', {});
const heldAgain = afterHoldSweep.body.items?.find((item) => item.id === escalationId);
check(
  'a suspended account is not reminded again',
  heldAgain?.action === 'skipped' && heldAgain.reason === 'account-suspended',
  heldAgain
);
const manualWhileHeld = await call('POST', `/api/billing/invoices/${escalationId}/reminder`, {});
check(
  'even a manual reminder is refused while the account is suspended',
  manualWhileHeld.status === 200 && manualWhileHeld.body.reason === 'account-suspended',
  manualWhileHeld.body
);

await call('PATCH', `/api/billing/invoices/${escalationId}`, { status: 'paid' });
const recovery = await call('POST', '/api/billing/reminders/run', {});
check(
  'paying reinstates the account automatically',
  recovery.body.escalation?.reinstated?.some((row) => row.email === heldLogin),
  recovery.body.escalation
);
const restoredAccount = (await call('GET', '/api/billing/accounts')).body.items?.find((row) => row.email === heldLogin);
check(
  'the account is current with nothing left switched off',
  restoredAccount?.state === 'current' && restoredAccount.extensionsOff === 0 && restoredAccount.loginsBlocked === 0,
  restoredAccount
);
const extensionBack = (await call('GET', '/api/extensions')).body.items?.find((row) => row.extension === '298');
check(
  'the extension that was switched off registers again',
  extensionBack?.enabled === true && extensionBack?.suspendedByBilling === false,
  extensionBack
);
const repairedLogin = await call('POST', '/api/auth/login', { email: heldLogin, password }, { noCookie: true });
check('the customer can sign in again', repairedLogin.status === 200, repairedLogin.body);

// An invoice nobody typed a due date for a human to chase — paused reminders —
// must never escalate, however late it is.
const pausedLate = await call('POST', '/api/billing/invoices', {
  accountName: 'Paused Smoke Co',
  email: 'ap@paused-smoke.example',
  amountCents: 7700,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10),
});
await call('PATCH', `/api/billing/invoices/${pausedLate.body.invoice?.id}`, { remindersPaused: true });
await call('POST', '/api/billing/reminders/run', {});
const pausedLedger = await call('GET', `/api/billing/invoices/${pausedLate.body.invoice?.id}/reminders`);
check(
  'a paused invoice is never warned and never suspends its account',
  !pausedLedger.body.items.some((row) => row.kind === 'final') &&
    !(await call('GET', '/api/billing/accounts')).body.items.some(
      (row) => row.email === 'ap@paused-smoke.example' && row.state === 'suspended'
    ),
  pausedLedger.body.items
);
await call('PATCH', `/api/billing/invoices/${pausedLate.body.invoice?.id}`, { status: 'void' });
await call('DELETE', `/api/extensions/${heldExtension.body.extension?.id}`);

const escalationSummary = await call('GET', '/api/billing/invoices');
check(
  'billing reports the escalation policy and the final notices it sent',
  escalationSummary.body.summary.escalation?.finalNoticeDays === 21 &&
    escalationSummary.body.summary.escalation?.graceDays === 0 &&
    escalationSummary.body.summary.reminders?.finalNotices >= 1,
  escalationSummary.body.summary.escalation
);

// ---------------------------------------------------------------- payments --
// Stripe is stubbed at the HTTP boundary (see the top of this file), so these
// checks prove the request the platform actually makes and the webhook it acts on.

const payInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Card Smoke Co',
  email: 'ap@card-smoke.example',
  amountCents: 12900,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
});
const payInvoiceId = payInvoice.body.invoice?.id;
const payUrl = payInvoice.body.invoice?.payUrl || '';
check(
  'an open invoice carries a signed payment link',
  payUrl.includes('/api/public/pay/invoice/') && payUrl.includes('?t=') && payUrl.includes(payInvoiceId),
  payUrl
);
check(
  'billing reports Stripe as configured and which key it is',
  escalationSummary.body.summary.payments?.configured === true &&
    escalationSummary.body.summary.payments?.mode === 'test',
  escalationSummary.body.summary.payments
);

if (!external) {
  // The link is absolute (built from PUBLIC_URL); the test talks to its own port.
  const link = new URL(payUrl);
  const payPath = link.pathname + link.search;
  const redirect = await call('GET', payPath);
  check(
    'the payment link redirects to a Stripe checkout page',
    redirect.status === 303 && (redirect.headers.get('location') || '').startsWith('https://checkout.stripe.test/'),
    { status: redirect.status, location: redirect.headers.get('location') }
  );
  const sent = stripeCalls.at(-1) || { body: '', authorization: '' };
  const decoded = decodeURIComponent(sent.body);
  check(
    'Stripe is asked for exactly this invoice, in cents, with a reference',
    sent.path === '/v1/checkout/sessions' &&
      decoded.includes('[unit_amount]=12900') &&
      decoded.includes('[currency]=usd') &&
      decoded.includes('invoiceIds]=' + payInvoiceId) &&
      sent.authorization.startsWith('Basic '),
    decoded.slice(0, 400)
  );

  const tampered = await call('GET', payPath.replace(/t=.+$/, 't=not-the-real-token'));
  check('a forged payment token is refused', tampered.status === 403, tampered.body);

  const unpaidAgain = await call('GET', `/api/billing/invoices`);
  const stillOpen = unpaidAgain.body.items?.find((row) => row.id === payInvoiceId);
  check('opening the checkout page does not mark anything paid', stillOpen?.status === 'open', stillOpen?.status);

  // A suspended account that pays from the email gets switched back on by the
  // webhook, without waiting for the next sweep.
  const heldForCard = await call('POST', '/api/billing/invoices', {
    accountName: 'Card Hold Co',
    email: 'audit@telno.local',
    amountCents: 4500,
    currency: 'USD',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    status: 'open',
    dueAt: new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10),
  });
  const heldForCardId = heldForCard.body.invoice?.id;
  await call('POST', '/api/billing/reminders/run', {});
  const heldBefore = (await call('GET', '/api/billing/accounts')).body.items?.find(
    (row) => row.email === 'audit@telno.local'
  );
  check(
    'the unblocked account is suspended before it pays',
    heldBefore?.state === 'suspended',
    heldBefore
  );

  const event = {
    id: 'evt_smoke_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        client_reference_id: heldForCard.body.invoice?.invoiceNo,
        metadata: { invoiceIds: heldForCardId },
        customer_details: { email: 'audit@telno.local' },
      },
    },
  };
  const rawEvent = JSON.stringify(event);
  const signature = (body, secret = 'whsec_smoke') => {
    const stamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex');
    return `t=${stamp},v1=${digest}`;
  };

  const unsigned = await fetch(`${base}/api/public/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawEvent,
  });
  check('a webhook without a signature is rejected', unsigned.status === 400, await unsigned.text());

  const wrongKey = await fetch(`${base}/api/public/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature(rawEvent, 'whsec_wrong') },
    body: rawEvent,
  });
  check('a webhook signed with the wrong secret is rejected', wrongKey.status === 400, await wrongKey.text());

  const signed = await fetch(`${base}/api/public/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature(rawEvent) },
    body: rawEvent,
  });
  const signedBody = await signed.json();
  check(
    'a signed webhook marks the invoice paid',
    signed.status === 200 && (signedBody.paid || []).includes(heldForCard.body.invoice?.invoiceNo),
    signedBody
  );

  const heldInvoice = (await call('GET', '/api/billing/invoices')).body.items?.find((row) => row.id === heldForCardId);
  check(
    'the paid invoice keeps the Stripe reference as its receipt',
    heldInvoice?.status === 'paid' && heldInvoice?.paymentRef === 'pi_test_1' && !!heldInvoice?.paidAt,
    heldInvoice
  );
  check('a settled invoice no longer offers a payment link', heldInvoice?.payUrl === '', heldInvoice?.payUrl);

  const heldAfter = (await call('GET', '/api/billing/accounts')).body.items?.find(
    (row) => row.email === 'audit@telno.local'
  );
  check(
    'paying online reinstates the account without waiting for a sweep',
    heldAfter?.state === 'current' && signedBody.reinstated?.includes('audit@telno.local'),
    { account: heldAfter, reply: signedBody }
  );

  // Paying twice must not undo anything or error.
  const replay = await fetch(`${base}/api/public/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature(rawEvent) },
    body: rawEvent,
  });
  check(
    'a replayed webhook is idempotent',
    replay.status === 200 && (await replay.json()).paid.length === 0,
    'replay'
  );
}

// The account-level link settles the whole balance, not one invoice.
const balanceInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Balance Smoke Co',
  email: 'ap@balance-smoke.example',
  amountCents: 3200,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10),
});
await call('POST', '/api/billing/reminders/run', {});
const balanceAccount = (await call('GET', '/api/billing/accounts')).body.items?.find(
  (row) => row.email === 'ap@balance-smoke.example'
);
if (!external) {
  const forged = await call('GET', `/api/public/pay/account/${balanceAccount?.id}?t=x`);
  check('an account payment link needs its own token', forged.status === 403, forged.body);

  const accountLink = new URL(balanceAccount?.payUrl || 'http://localhost/');
  const accountPath = accountLink.pathname + accountLink.search;
  const accountPage = await call('GET', accountPath);
  const accountCheckout = decodeURIComponent(stripeCalls.at(-1)?.body || '');
  check(
    'the balance link asks Stripe for every invoice on the account',
    accountPage.status === 303 &&
      accountCheckout.includes('[unit_amount]=3200') &&
      accountCheckout.includes('[invoiceIds]=' + balanceInvoice.body.invoice?.id),
    accountCheckout.slice(0, 300)
  );
}
await call('PATCH', `/api/billing/invoices/${balanceInvoice.body.invoice?.id}`, { status: 'void' });
await call('POST', '/api/billing/reminders/run', {});
const balanceAfter = (await call('GET', '/api/billing/accounts')).body.items?.find(
  (row) => row.email === 'ap@balance-smoke.example'
);
check(
  'voiding the only invoice brings the account back without a payment',
  balanceAfter?.state === 'current',
  balanceAfter
);

// ------------------------------------------------------- stripe connection --
// The Test button's job is to catch what a stored key hides: a dead key, a key
// that cannot write, a webhook left on an old host, a secret that is not the
// one Stripe signs with.

const connected = await call('POST', '/api/billing/payments/test', {});
const checkOf = (result, id) => result.body.checks?.find((entry) => entry.id === id);

check(
  'the connection test asks Stripe and reports each piece',
  connected.status === 200 && (connected.body.checks || []).length >= 6,
  connected.body.checks?.map((entry) => `${entry.id}:${entry.state}`)
);
check(
  'a working key, secret and webhook pass',
  connected.body.ok === true &&
    checkOf(connected, 'api')?.state === 'pass' &&
    checkOf(connected, 'webhook-secret')?.state === 'pass' &&
    checkOf(connected, 'webhook-endpoint')?.state === 'pass',
  connected.body
);
check(
  'the key is proven by the balance call, not by being present',
  /test mode/.test(checkOf(connected, 'api')?.detail || ''),
  checkOf(connected, 'api')
);
check(
  'the probe creates a payment page and expires it',
  stripeCalls.some((entry) => entry.path === '/v1/checkout/sessions' && entry.body.includes('connectionTest')) &&
    stripeCalls.some((entry) => /^\/v1\/checkout\/sessions\/cs_test_\d+\/expire$/.test(entry.path)),
  stripeCalls.map((entry) => entry.path)
);
check(
  'the test names the exact webhook URL to register',
  String(connected.body.webhookUrl || '').endsWith('/api/public/stripe/webhook'),
  connected.body.webhookUrl
);
check(
  'a loopback public URL is flagged, because Stripe cannot call it',
  checkOf(connected, 'public-url')?.state === 'warn',
  checkOf(connected, 'public-url')
);

// A webhook still pointing at last week's host answers Stripe happily and pays
// nothing. That is the failure this check exists for.
stripeEndpointUrl = 'https://old.example/api/public/stripe/webhook';
const staleWebhook = await call('POST', '/api/billing/payments/test', {});
stripeEndpointUrl = '';
check(
  'an endpoint pointing at another host fails the test',
  staleWebhook.body.ok === false &&
    checkOf(staleWebhook, 'webhook-endpoint')?.state === 'fail' &&
    /No endpoint points at/.test(checkOf(staleWebhook, 'webhook-endpoint')?.detail || ''),
  checkOf(staleWebhook, 'webhook-endpoint')
);

// A revoked key is the other silent failure: the vault still holds a string.
await call('PUT', '/api/system/vault/STRIPE_SECRET_KEY', { value: 'sk_test_dead' });
const deadKey = await call('POST', '/api/billing/payments/test', {});
await call('DELETE', '/api/system/vault/STRIPE_SECRET_KEY');
check(
  'a rejected key fails with Stripe\'s own reason and stops there',
  deadKey.body.ok === false &&
    checkOf(deadKey, 'api')?.state === 'fail' &&
    /rejected the key/.test(checkOf(deadKey, 'api')?.detail || '') &&
    !checkOf(deadKey, 'checkout'),
  checkOf(deadKey, 'api')
);
const restoredKey = await call('POST', '/api/billing/payments/test', {});
check('removing the bad key leaves the working one in place', restoredKey.body.ok === true, restoredKey.body.summary);

// Estate and operations.
const site = await call('POST', '/api/estate/sites', {
  name: `Smoke Site ${Date.now()}`,
  city: 'Leeds',
  country: 'GB',
  status: 'active',
});
check('site created with no devices', site.status === 201 && site.body.site.deviceCount === 0, site.body);

const siteDegraded = await call('PATCH', `/api/estate/sites/${site.body.site?.id}`, { status: 'degraded' });
check('site status can be changed', siteDegraded.status === 200 && siteDegraded.body.site.status === 'degraded', siteDegraded.body);

// Devices are rows, not a counter: the site's numbers come from the inventory.
const siteId = site.body.site?.id;
const extensionList = await call('GET', '/api/extensions');
const extension = extensionList.body.items?.[0]?.extension || '';

const device = await call('POST', '/api/estate/devices', {
  name: 'Smoke handset',
  siteId,
  kind: 'handset',
  model: 'Yealink T54W',
  mac: 'aa:bb:cc:dd:ee:ff',
  ip: '10.0.0.9',
  ...(extension ? { extension } : {}),
  status: 'online',
});
check(
  'device created against a site with a canonical MAC',
  device.status === 201 && device.body.device.mac === 'AA:BB:CC:DD:EE:FF' && device.body.device.siteId === siteId,
  device.body
);
check(
  'device links to a real extension',
  !extension || device.body.device?.extension === extension,
  device.body.device
);

const duplicateMac = await call('POST', '/api/estate/devices', {
  name: 'Clone of the handset',
  siteId,
  mac: 'AA-BB-CC-DD-EE-FF',
});
check('a MAC can only be provisioned once', duplicateMac.status === 409, duplicateMac.body);

const wrongKind = await call('POST', '/api/estate/devices', { name: 'Toaster', siteId, kind: 'toaster' });
check('unknown device kinds are rejected', wrongKind.status === 400, wrongKind.body);

const wrongSite = await call('POST', '/api/estate/devices', { name: 'Orphan', siteId: 'ste_nowhere' });
check('a device must belong to a known site', wrongSite.status === 400, wrongSite.body);

const inventory = await call('GET', `/api/estate/devices?site=${siteId}`);
check(
  'inventory filters by site and counts states',
  inventory.status === 200 && inventory.body.items.length === 1 && inventory.body.summary.online === 1,
  inventory.body.summary
);

const withCounts = await call('GET', '/api/estate/sites');
const countedSite = withCounts.body.items?.find((item) => item.id === siteId);
check(
  'site counts are derived from device rows',
  countedSite?.deviceCount === 1 && countedSite?.onlineCount === 1 && countedSite?.problemCount === 0,
  countedSite
);

const deviceFaulty = await call('PATCH', `/api/estate/devices/${device.body.device?.id}`, { status: 'faulty' });
check('device status can change', deviceFaulty.status === 200 && deviceFaulty.body.device.status === 'faulty', deviceFaulty.body);

const recounted = await call('GET', `/api/estate/devices?site=${siteId}`);
check('a faulty device counts as needing attention', recounted.body.summary.faulty === 1, recounted.body.summary);

// Check-ins: a device reports itself with the token it was provisioned with.
const deviceToken = device.body.token;
check(
  'provisioning issues a check-in token',
  typeof deviceToken === 'string' && deviceToken.startsWith('dv_'),
  deviceToken ? 'token present' : device.body
);

const noToken = await call('POST', '/api/devices/heartbeat', { status: 'online' }, { noCookie: true, bearer: '' });
check('a heartbeat without a token is rejected', noToken.status === 401, noToken.body);

const badToken = await call(
  'POST',
  '/api/devices/heartbeat',
  { status: 'online' },
  { noCookie: true, bearer: '', headers: { 'x-device-token': 'dv_not_a_real_token' } }
);
check('an unknown device token is rejected', badToken.status === 401, badToken.body);

const beat = await call(
  'POST',
  '/api/devices/heartbeat',
  { status: 'online', ip: '10.0.0.77', firmware: '5.9.9.1' },
  { noCookie: true, bearer: '', headers: { 'x-device-token': deviceToken } }
);
check(
  'a heartbeat marks the device online and tells it when to return',
  beat.status === 200 && beat.body.device?.status === 'online' && !!beat.body.device?.lastSeenAt && beat.body.checkInSec > 0,
  beat.body
);

const afterBeat = await call('GET', `/api/estate/devices?site=${siteId}`);
const beatDevice = afterBeat.body.items?.find((item) => item.id === device.body.device?.id);
check('a heartbeat updates the reported ip and firmware', beatDevice?.ip === '10.0.0.77' && beatDevice?.firmware === '5.9.9.1', beatDevice);
check('a device that just checked in is not silent', beatDevice?.silent === false, beatDevice);

const quiet = await call('POST', '/api/estate/devices', {
  name: 'Quiet handset',
  siteId,
  status: 'online',
  lastSeenAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
});
const quietList = await call('GET', `/api/estate/devices?site=${siteId}`);
const quietRow = quietList.body.items?.find((item) => item.id === quiet.body.device?.id);
check('a live device that stopped checking in is silent', quietRow?.silent === true, quietRow);
check(
  'silent devices are counted in the estate summary',
  (await call('GET', '/api/estate/sites')).body.summary.silentDevices >= 1,
  quietList.body.summary
);

const rotated = await call('POST', `/api/estate/devices/${device.body.device?.id}/token`, {});
check(
  'a check-in token can be rotated',
  rotated.status === 200 && typeof rotated.body.token === 'string' && rotated.body.token !== deviceToken,
  rotated.body
);

const staleToken = await call(
  'POST',
  '/api/devices/heartbeat',
  {},
  { noCookie: true, bearer: '', headers: { 'x-device-token': deviceToken } }
);
check('the previous token stops working after a rotation', staleToken.status === 401, staleToken.body);

const freshBeat = await call(
  'POST',
  '/api/devices/heartbeat',
  {},
  { noCookie: true, bearer: '', headers: { 'x-device-token': rotated.body.token } }
);
check('the rotated token checks in', freshBeat.status === 200 && freshBeat.body.ok === true, freshBeat.body);

const retire = await call(
  'DELETE',
  '/api/devices/heartbeat',
  undefined,
  { noCookie: true, bearer: '', headers: { 'x-device-token': rotated.body.token } }
);
check('a device can retire its own token', retire.status === 200, retire.body);

const afterRetire = await call(
  'POST',
  '/api/devices/heartbeat',
  {},
  { noCookie: true, bearer: '', headers: { 'x-device-token': rotated.body.token } }
);
check('a retired token can no longer check in', afterRetire.status === 401, afterRetire.body);

// Provisioning: the config carries SIP credentials and a fresh check-in token.
const provisioned = await call('GET', `/api/estate/devices/${device.body.device?.id}/provisioning?format=yealink`);
check(
  'a device config carries the account and heartbeats',
  provisioned.status === 200 &&
    provisioned.body.fileName.endsWith('.cfg') &&
    provisioned.body.config.includes('/api/devices/heartbeat') &&
    provisioned.body.config.includes('sip_server'),
  provisioned.body && { fileName: provisioned.body.fileName }
);
const provisionedToken = /device\.checkin\.token = (dv_\S+)/.exec(provisioned.body.config || '')?.[1];
const provisionedBeat = await call(
  'POST',
  '/api/devices/heartbeat',
  {},
  { noCookie: true, bearer: '', headers: { 'x-device-token': provisionedToken || 'dv_missing' } }
);
check('a device provisioned from its config checks in', provisionedBeat.status === 200, provisionedBeat.body);

const badFormat = await call('GET', `/api/estate/devices/${device.body.device?.id}/provisioning?format=cisco`);
check('an unknown config format is refused', badFormat.status === 400, badFormat.body);

const xmlConfig = await call('GET', `/api/estate/devices/${device.body.device?.id}/provisioning?format=grandstream`);
check(
  'a Grandstream config is XML',
  xmlConfig.status === 200 && xmlConfig.body.fileName.endsWith('.xml') && xmlConfig.body.config.includes('<gs_provision'),
  xmlConfig.body && { fileName: xmlConfig.body.fileName }
);

const task = await call('POST', '/api/operations/tasks', {
  title: 'Smoke task',
  priority: 'high',
  siteId: site.body.site?.id,
});
check('task created against a site', task.status === 201 && task.body.task.site === site.body.site?.name, task.body);

const taskDone = await call('PATCH', `/api/operations/tasks/${task.body.task?.id}`, { status: 'done' });
check('task can be completed', taskDone.status === 200 && taskDone.body.task.status === 'done', taskDone.body);

await call('DELETE', `/api/operations/tasks/${task.body.task?.id}`);

// Deleting a device removes it; deleting a site retires the equipment on it.
const orphanHost = await call('POST', '/api/estate/devices', { name: 'Spare gateway', siteId, kind: 'gateway' });
const sitesAfterDeviceDelete = await call('DELETE', `/api/estate/devices/${orphanHost.body.device?.id}`);
check('device can be removed', sitesAfterDeviceDelete.status === 200, sitesAfterDeviceDelete.body);

await call('POST', '/api/estate/devices', { name: 'Cascade handset', siteId });
await call('DELETE', `/api/estate/sites/${siteId}`);
const afterSiteDelete = await call('GET', '/api/estate/devices');
check(
  'deleting a site takes its devices with it',
  afterSiteDelete.status === 200 && !afterSiteDelete.body.items.some((item) => item.siteId === siteId),
  afterSiteDelete.body.items?.length
);

const missingDevice = await call('PATCH', '/api/estate/devices/dev_missing', { status: 'online' });
check('updating a missing device is a 404', missingDevice.status === 404, missingDevice.body);

// The whole surface is authenticated: no session, no data.
const anonymous = await call('GET', '/api/voice/agents', undefined, { noCookie: true, bearer: '' });
check('workspace endpoints reject anonymous reads', anonymous.status === 401, anonymous.body);

// ------------------------------------------------------------- systems list --
// Probes are off in this run: the checks are about the catalog, not the network.
const systems = await call('GET', '/api/systems?probe=0');
check(
  'connected systems list every external console',
  systems.status === 200 && systems.body.items.length >= 6 && systems.body.summary.total === systems.body.items.length,
  systems.body.summary
);
check(
  'the Capstone dashboard registers its full module catalog',
  (systems.body.items.find((item) => item.id === 'sys_control')?.links.length || 0) >= 20,
  systems.body.items.map((item) => [item.id, item.links.length])
);
check(
  'every requested console is a destination',
  ['https://dashboard.pbx.it.com/interviews', 'https://workflow.pbx.it.com/', 'https://pbx.it.com/workflow', 'https://pbx.pbx.it.com/admin/config.php'].every(
    (url) => systems.body.items.some((item) => item.url === url)
  ),
  systems.body.items.map((item) => item.url)
);
check(
  'module links carry a label and a path',
  systems.body.items.every((item) => item.links.every((link) => link.label && link.path.startsWith('/'))),
  systems.body.items[0]?.links?.slice(0, 3)
);

const privateSystem = await call('POST', '/api/systems', { name: 'Loopback', url: 'http://127.0.0.1:9000/x' });
check('a loopback system is refused', privateSystem.status === 400, privateSystem.body);

const newSystem = await call('POST', '/api/systems', {
  name: 'Smoke console',
  url: 'https://example.com/admin',
  description: 'created by the smoke suite',
});
check(
  'a registered system keeps host and path apart',
  newSystem.status === 201 && newSystem.body.system.host === 'https://example.com' && newSystem.body.system.path === '/admin',
  newSystem.body
);

const disabled = await call('PATCH', `/api/systems/${newSystem.body.system.id}`, { enabled: false });
check('a system can be disabled', disabled.status === 200 && disabled.body.system.enabled === false, disabled.body);

const anonSystemWrite = await call(
  'POST',
  '/api/systems',
  { name: 'Nope', url: 'https://example.org/' },
  { bearer: '', noCookie: true }
);
check('anonymous callers cannot register systems', anonSystemWrite.status === 401, anonSystemWrite.body);

const removedSystem = await call('DELETE', `/api/systems/${newSystem.body.system.id}`);
check('a system can be removed', removedSystem.status === 200, removedSystem.body);

// --------------------------------------------------------------- softphone --
const softphoneStatus = await call('GET', '/api/softphone/status');
check(
  'the softphone reports its secure signaling endpoint',
  softphoneStatus.status === 200 &&
    softphoneStatus.body.enabled === true &&
    String(softphoneStatus.body.wssUrl).startsWith('wss://') &&
    softphoneStatus.body.webSocket === true,
  softphoneStatus.body
);
check(
  'TLS material is ready for the WebSocket listener',
  softphoneStatus.body.tls?.ready === true && /^[0-9a-f]{64}$/.test(softphoneStatus.body.tls?.fingerprint || ''),
  softphoneStatus.body.tls
);

const sipExtension = await call('POST', '/api/extensions', {
  extension: '297',
  displayName: 'Smoke Softphone',
  number: FIXTURE_NUMBER,
  secret: 'smoke-softphone-1',
});
check('an extension can own a DID for the softphone', sipExtension.status === 201, sipExtension.body);

const sipAgent = await call('POST', '/api/voice/agents', {
  name: `Smoke Recording ${Date.now()}`,
  greeting: 'Recording policy transport test.',
  number: FIXTURE_NUMBER,
  status: 'active',
});
await call('PATCH', `/api/voice/agents/${sipAgent.body.agent.id}`, { recordInbound: true, recordOutbound: false });

const DID_DIGITS = FIXTURE_E164.replace(/\D/g, '');
const didBlock = (content) => {
  const match = new RegExp(`exten => ${DID_DIGITS},1([\\s\\S]*?)(?=\\nexten|\\n\\[)`).exec(content);
  return match ? match[0] : '';
};

const recordedConfig = await call('GET', '/api/system/config-preview?file=extensions.conf');
const recordedBlock = didBlock(recordedConfig.body.content || '');
check(
  'an agent recording policy reaches the dialplan',
  /MixMonitor\(/.test(recordedBlock) && /TELNO_AGENT=/.test(recordedBlock),
  recordedBlock
);

await call('PATCH', `/api/voice/agents/${sipAgent.body.agent.id}`, { recordInbound: false });
const unrecordedConfig = await call('GET', '/api/system/config-preview?file=extensions.conf');
check(
  'turning the policy off removes the recording from the dialplan',
  !/MixMonitor\(/.test(didBlock(unrecordedConfig.body.content || '')),
  didBlock(unrecordedConfig.body.content || '')
);

const pjsipConfig = await call('GET', '/api/system/config-preview?file=pjsip.conf');
check(
  'the softphone endpoint is WebRTC and DTLS-SRTP only',
  /\[transport-wss\]/.test(pjsipConfig.body.content || '') &&
    /protocol=wss/.test(pjsipConfig.body.content) &&
    /webrtc=yes/.test(pjsipConfig.body.content) &&
    /media_encryption=dtls/.test(pjsipConfig.body.content),
  (pjsipConfig.body.content || '').split('\n').filter((line) => /wss|webrtc=yes|dtls/.test(line)).slice(0, 6)
);
check(
  'video codecs are offered when video calling is on',
  /allow=vp8/.test(pjsipConfig.body.content) && /allow=opus/.test(pjsipConfig.body.content),
  'codecs'
);

const httpConfig = await call('GET', '/api/system/config-preview?file=http.conf');
check(
  'the switch listens for a secure WebSocket',
  /tlsenable=yes/.test(httpConfig.body.content) && /tlsbindaddr=0\.0\.0\.0:8089/.test(httpConfig.body.content),
  httpConfig.body.content
);

const softphoneSession = await call('POST', '/api/softphone/session', { extension: '297' });
check(
  'a session carries a single-use ticket, SIP credentials and ICE servers',
  softphoneSession.status === 201 &&
    String(softphoneSession.body.ticket).startsWith('sf_') &&
    softphoneSession.body.sip.authUser === 'webrtc-297' &&
    softphoneSession.body.sip.uri === 'sip:webrtc-297@127.0.0.1' &&
    softphoneSession.body.media.encryption === 'dtls-srtp' &&
    softphoneSession.body.iceServers.some((server) => String(server.urls).startsWith('stun:')),
  softphoneSession.body
);
check(
  'the session states the recording policy the switch will apply',
  softphoneSession.body.recording?.inbound === false &&
    softphoneSession.body.recording?.source === 'voice-agent' &&
    !!softphoneSession.body.recording?.agent,
  softphoneSession.body.recording
);

const wsBase = base.replace(/^http/, 'ws');
const socketRun = await new Promise((resolve) => {
  const socket = new WebSocket(`${wsBase}/api/softphone/ws?ticket=${softphoneSession.body.ticket}`, {
    headers: { cookie, origin: base },
  });
  const seen = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    seen.push(message.type);
    if (message.type === 'ready') socket.send(JSON.stringify({ type: 'ping' }));
    if (message.type === 'pong') {
      socket.close();
      resolve(seen);
    }
  });
  socket.on('error', () => resolve(seen));
  setTimeout(() => {
    socket.terminate();
    resolve(seen);
  }, 5000);
});
check(
  'the signaling socket accepts a ticket, sends presence and answers ping',
  ['ready', 'presence', 'pong'].every((type) => socketRun.includes(type)),
  socketRun
);

const replay = await new Promise((resolve) => {
  const socket = new WebSocket(`${wsBase}/api/softphone/ws?ticket=${softphoneSession.body.ticket}`, {
    headers: { cookie, origin: base },
  });
  socket.on('close', (code) => resolve(code));
  socket.on('error', () => resolve(0));
  setTimeout(() => {
    socket.terminate();
    resolve(-1);
  }, 4000);
});
check('a ticket cannot be replayed', replay === 4401, replay);

const badOriginSession = await call('POST', '/api/softphone/session', { extension: '297' });
const crossOrigin = await new Promise((resolve) => {
  const socket = new WebSocket(`${wsBase}/api/softphone/ws?ticket=${badOriginSession.body.ticket}`, {
    headers: { cookie, origin: 'https://evil.example' },
  });
  socket.on('close', (code) => resolve(code));
  socket.on('error', () => resolve(0));
  setTimeout(() => {
    socket.terminate();
    resolve(-1);
  }, 4000);
});
check('a cross-origin socket is refused even with a valid ticket', crossOrigin === 4403, crossOrigin);

const unknownExtension = await call('POST', '/api/softphone/session', { extension: '999999' });
check('a session needs a real extension', unknownExtension.status === 404, unknownExtension.body);

await call('DELETE', `/api/voice/agents/${sipAgent.body.agent.id}`);
await call('DELETE', `/api/extensions/${sipExtension.body.extension.id}`);

// ----------------------------------------------------------------- api keys --
const key = await call('POST', '/api/system/keys', { label: 'smoke', scope: 'registry:read' });
check('api key created', key.status === 201 && key.body.key.startsWith('tl_'), key.body);
const keySecret = key.body.key;

const keyed = await call('GET', '/api/numbers?limit=1', undefined, {
  bearer: '',
  noCookie: true,
  headers: { 'x-api-key': keySecret },
});
check('api key authenticates registry reads', keyed.status === 200 && Array.isArray(keyed.body.items), keyed.body);

const keyedWrite = await call(
  'POST',
  '/api/numbers',
  { number: '+1 212 555 0166', name: 'Keyed Co' },
  { bearer: '', noCookie: true, headers: { 'x-api-key': keySecret } }
);
check('read-only key cannot write', keyedWrite.status === 403, keyedWrite.body);

// -------------------------------------------------------------------- vault --
// Runs last: a stored mail key changes which provider billing and verification
// use, and the checks above exercise those with the log channel.
await call('DELETE', '/api/system/vault/RESEND_API_KEY');

const secretBefore = await call('POST', '/api/system/email/test', {});
check(
  'without a key the test send reports "not configured" instead of failing',
  secretBefore.status === 200 && secretBefore.body.sent === false && secretBefore.body.error === 'email_not_configured',
  secretBefore.body
);

const storedKey = await call('PUT', '/api/system/vault/RESEND_API_KEY', { value: 're_smoke_0000000000000000' });
check(
  'a provider key is stored with only its last four characters readable',
  storedKey.status === 200 && storedKey.body.secret.name === 'RESEND_API_KEY' && storedKey.body.secret.hint.endsWith('0000'),
  storedKey.body
);
check(
  'storing a key publishes it nowhere: no value in the response',
  !JSON.stringify(storedKey.body).includes('re_smoke_0000000000000000'),
  storedKey.body
);

const vaultList = await call('GET', '/api/system/vault');
const listed = (vaultList.body.items || []).find((item) => item.name === 'RESEND_API_KEY');
check(
  'the vault lists names and hints but never a value',
  vaultList.status === 200 && !!listed && !('value' in listed) && !('cipher' in listed) &&
    !JSON.stringify(vaultList.body).includes('re_smoke_0000000000000000'),
  vaultList.body
);
check(
  'a stored key switches mail to Resend',
  vaultList.body.channels?.email?.configured === true && vaultList.body.channels?.email?.provider === 'resend',
  vaultList.body.channels
);

// The adapter is pointed at a closed port, so a send attempt can only fail at
// the transport. That error proves the key was read from the vault and used.
const testSend = await call('POST', '/api/system/email/test', { to: 'owner@smoke.example' });
check(
  'the stored key reaches the provider adapter',
  testSend.status === 200 && testSend.body.sent === false &&
    testSend.body.error && testSend.body.error !== 'resend_not_configured',
  testSend.body
);

const badName = await call('PUT', '/api/system/vault/not-a-name', { value: 'x' });
check('a secret name has to look like a credential name', badName.status === 400, badName.body);

const emptyValue = await call('PUT', '/api/system/vault/EMAIL_FROM', { value: '   ' });
check('an empty secret is refused', emptyValue.status === 400, emptyValue.body);

const sender = await call('PUT', '/api/system/vault/EMAIL_FROM', { value: 'billing@telno.services' });
check('a sender address can live in the vault too', sender.status === 200 && sender.body.channels.email.from === 'billing@telno.services', sender.body);

const removedKey = await call('DELETE', '/api/system/vault/RESEND_API_KEY');
check(
  'removing the key returns mail to the log channel',
  removedKey.status === 200 && removedKey.body.channels?.email?.configured === false,
  removedKey.body
);

const missingSecret = await call('DELETE', '/api/system/vault/RESEND_API_KEY');
check('deleting a missing secret is a 404, not a silent success', missingSecret.status === 404, missingSecret.body);

// --------------------------------------------------------------- mailjet --
// A second email provider behind an explicit choice: the presence of a key is
// not the decision, and a chosen provider without credentials has to refuse
// instead of quietly dropping mail into the log.

const chosenMailjet = await call('PUT', '/api/system/vault/EMAIL_PROVIDER', { value: 'mailjet' });
check(
  'choosing Mailjet switches the provider before a key exists',
  chosenMailjet.status === 200 &&
    chosenMailjet.body.channels?.email?.provider === 'mailjet' &&
    chosenMailjet.body.channels?.email?.configured === false,
  chosenMailjet.body.channels?.email
);

const mailjetMissing = await call('POST', '/api/system/email/test', {});
check(
  'a chosen provider with no key refuses instead of falling back to the log',
  mailjetMissing.body.sent === false && mailjetMissing.body.error === 'mailjet_not_configured',
  mailjetMissing.body
);

await call('PUT', '/api/system/vault/MAILJET_API_KEY', { value: 'mj_key_smoke' });
const mailjetHalf = await call('POST', '/api/system/email/test', {});
check(
  'a Mailjet key without its secret is still not configured',
  mailjetHalf.body.sent === false && mailjetHalf.body.error === 'mailjet_secret_missing',
  mailjetHalf.body
);

await call('PUT', '/api/system/vault/MAILJET_API_SECRET', { value: 'mj_secret_smoke' });

// A resend and a reminder, both through Mailjet: the invoice row and the ledger
// each have to say who carried the message.
const mjInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Mailjet Trace Co',
  email: 'ap@mj-trace.example',
  amountCents: 7800,
  currency: 'USD',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  status: 'open',
  dueAt: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
});
const mjInvoiceId = mjInvoice.body.invoice?.id;
const mjResend = await call('POST', `/api/billing/invoices/${mjInvoiceId}/resend`, {});
check(
  'a resend records the provider that delivered it',
  mjResend.body.sent === true &&
    mjResend.body.invoice.lastProvider === 'mailjet' &&
    mjResend.body.invoice.lastSendError === '' &&
    !!mjResend.body.invoice.lastSentAt,
  mjResend.body.invoice
);

const mjReminder = await call('POST', `/api/billing/invoices/${mjInvoiceId}/reminder`, {});
const mjLedgerRow = (mjReminder.body.items || [])[0];
check(
  'the reminder ledger records the provider per message',
  mjReminder.body.action === 'sent' && mjLedgerRow?.provider === 'mailjet' && mjLedgerRow?.status === 'sent' && !mjLedgerRow?.error,
  mjLedgerRow
);

const mailjetSend = await call('POST', '/api/system/email/test', { to: 'owner@smoke.example' });
const mailjetCall = mailjetCalls.at(-1) || { path: '', body: '', authorization: '' };
check(
  'a Mailjet send carries the message, the sender and key + secret auth',
  mailjetSend.body.sent === true &&
    mailjetSend.body.provider === 'mailjet' &&
    mailjetCall.path === '/v3.1/send' &&
    mailjetCall.authorization === 'Basic ' + Buffer.from('mj_key_smoke:mj_secret_smoke').toString('base64') &&
    mailjetCall.body.includes('owner@smoke.example') &&
    // The sender is whatever EMAIL_FROM resolved to, not a constant.
    mailjetCall.body.includes('"From":{"Email"') &&
    mailjetCall.body.includes('TextPart'),
  { result: mailjetSend.body, call: mailjetCall }
);

// Choice beats presence: Resend is selected while Mailjet still has a key.
await call('PUT', '/api/system/vault/RESEND_API_KEY', { value: 're_smoke_0000000000000000' });
const mailjetCallsBefore = mailjetCalls.length;
const switched = await call('PUT', '/api/system/vault/EMAIL_PROVIDER', { value: 'resend' });
check(
  'choosing Resend wins while Mailjet still has a key',
  switched.body.channels?.email?.provider === 'resend' && switched.body.channels?.email?.configured === true,
  switched.body.channels?.email
);
const resendSend = await call('POST', '/api/system/email/test', {});
check(
  'only the chosen provider is called',
  resendSend.body.provider === 'resend' && mailjetCalls.length === mailjetCallsBefore,
  { result: resendSend.body, extraMailjetCalls: mailjetCalls.length - mailjetCallsBefore }
);

// A provider that is chosen but unreachable: the invoice has to remember the
// failure, not just wait for somebody to read the service log.
const failedResend = await call('POST', `/api/billing/invoices/${mjInvoiceId}/resend`, {});
check(
  'a failed send records the provider and the reason on the invoice',
  failedResend.body.sent === false &&
    failedResend.body.invoice.lastProvider === 'resend' &&
    /network/.test(failedResend.body.invoice.lastSendError || ''),
  { provider: failedResend.body.invoice.lastProvider, error: failedResend.body.invoice.lastSendError }
);
// The earlier success is not overwritten by the failure: the timestamp stays,
// the error says the latest attempt did not land.
check(
  'a failure keeps the last successful send time',
  !!failedResend.body.invoice.lastSentAt,
  failedResend.body.invoice.lastSentAt
);

await call('DELETE', '/api/system/vault/RESEND_API_KEY');
await call('DELETE', '/api/system/vault/MAILJET_API_KEY');
await call('DELETE', '/api/system/vault/MAILJET_API_SECRET');
await call('DELETE', '/api/system/vault/EMAIL_PROVIDER');
await call('DELETE', '/api/system/vault/EMAIL_FROM');

// ------------------------------------------------------------------- logout --
const logout = await call('POST', '/api/auth/logout', {});
check('logout succeeds', logout.status === 200, logout.body);

const afterLogout = await call('GET', '/api/auth/me', undefined, { bearer: token });
check('token is invalid after logout', afterLogout.status === 401, afterLogout.body);

globalThis.__smokeStopServer?.();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
console.log('All checks passed.\n');
