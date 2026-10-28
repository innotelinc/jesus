#!/usr/bin/env node
/**
 * End-to-end API test. Repeatable: it removes its own fixtures before running,
 * so it can be pointed at the same database many times.
 *
 *   node scripts/smoke.mjs [http://localhost:8080]
 *
 * Exits non-zero if any expectation fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// The temporary data directory this run started its own server with, if any,
// and the switch configuration directory beside it.
let dataDir = '';
let configDir = '';

// The account this run signs in as. When the suite starts its own server these
// are handed to first boot, so the owner exists with a known password; when it
// is pointed at a running instance they are whoever that instance has.
const email = process.env.SMOKE_EMAIL || 'owner@telno.local';
const password = process.env.SMOKE_PASSWORD || 'telno-demo-owner';
// Assigned when this run starts its own server; see startServer() below.
let startServer = null;
let serverLog = () => '';
let stripeStub = null;
const stripeCalls = [];
let mailjetStub = null;
const mailjetCalls = [];
// Set to make the stub report a different registered webhook URL, so the
// connection test's "points at an old host" path is exercised.
let stripeEndpointUrl = '';
// What the registered endpoint is subscribed to. A stand-in that can never
// change would pass a repair test without proving the repair did anything.
let stripeEndpointEvents = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
// The endpoint's own state in the dashboard. A paused endpoint receives
// nothing, which the screen has to tell apart from a healthy one.
let stripeEndpointStatus = 'enabled';
// A key that may read the balance but not the endpoint list. The read fails
// with a permission error, which is a different problem from the network being
// down and must not be reported as one.
let stripeListRefusal = false;
// A path to drop instead of answering, for the network-failure checks. Stripe
// timing out and Stripe refusing a key are different failures with different
// fixes, and only a dropped connection exercises the first one.
let stripeDropPath = '';

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
      if (stripeDropPath && path.startsWith(stripeDropPath)) {
        stripeDropPath = '';
        request.socket.destroy();
        return;
      }
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
        if (stripeListRefusal) {
          return send(
            { error: { message: 'The provided key does not have the required permissions for this endpoint.' } },
            403
          );
        }
        return send({
          object: 'list',
          data: [
            {
              id: 'we_test_live',
              object: 'webhook_endpoint',
              url: stripeEndpointUrl || `${base}/api/public/stripe/webhook`,
              status: stripeEndpointStatus,
              enabled_events: stripeEndpointEvents,
            },
          ],
        });
      }
      if (request.method === 'POST' && path.startsWith('/v1/webhook_endpoints/')) {
        // The update replaces the whole list on Stripe's side, so the stand-in
        // does the same: what the platform sent is what the endpoint now has.
        // Stripe takes the list as indexed form fields (`enabled_events[0]`), so
        // the stand-in reads those as well as the bare `enabled_events[]`.
        const events = [...new URLSearchParams(body).entries()]
          .filter(([name]) => /^enabled_events\[\d*\]$/.test(name))
          .map(([, value]) => value);
        if (events.length) stripeEndpointEvents = events;
        return send({
          id: path.split('/').pop(),
          object: 'webhook_endpoint',
          url: stripeEndpointUrl || `${base}/api/public/stripe/webhook`,
          status: stripeEndpointStatus,
          enabled_events: stripeEndpointEvents,
        });
      }
      if (path.startsWith('/v1/checkout/sessions/') && path.endsWith('/expire')) {
        return send({ id: path.split('/')[4], object: 'checkout.session', status: 'expired' });
      }
      // What a card-billed subscriber's history is rebuilt from: the paid invoice
      // and one that is still open, so the backfill has to filter, not just copy.
      if (path === '/v1/invoices') {
        const paidAt = Math.floor(Date.now() / 1000) - 26 * 24 * 3600;
        return send({
          object: 'list',
          data: [
            {
              id: 'in_smoke_backfill_1',
              object: 'invoice',
              status: 'paid',
              paid: true,
              amount_paid: 7900,
              currency: 'usd',
              customer: 'cus_test_smoke_1',
              subscription: 'sub_test_smoke_1',
              billing_reason: 'subscription_create',
              period_start: paidAt,
              period_end: paidAt + 30 * 24 * 3600,
              status_transitions: { paid_at: paidAt },
            },
            {
              id: 'in_smoke_backfill_open',
              object: 'invoice',
              status: 'open',
              paid: false,
              amount_paid: 0,
              amount_due: 7900,
              currency: 'usd',
              customer: 'cus_test_smoke_1',
              subscription: 'sub_test_smoke_1',
            },
          ],
        });
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

  // The run owns its database. Without this the suite tested whatever
  // `./data` happened to hold on the machine it ran on: a fresh clone bootstraps
  // `admin@telno.local` with a generated password, so the owner sign-in below
  // failed on precisely the machine that had never run the platform before.
  // A temporary directory also means the suite cannot touch a developer's data.
  dataDir = await mkdtemp(join(tmpdir(), 'telno-smoke-'));
  configDir = join(dataDir, 'asterisk');

  // The checks below assert against demo data — voicemail, call history, the
  // connected systems, the demo accounts — so a run that starts its own server
  // seeds its own instance rather than assuming someone ran `npm run seed`.
  // `--force` also writes the switch configuration and, with openssl on PATH,
  // the listener certificate the softphone checks report on.
  const seed = spawnSync(process.execPath, ['src/seed.js', '--force'], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ASTERISK_CONFIG_DIR: configDir,
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: password,
    },
    encoding: 'utf8',
  });
  if (seed.status !== 0) {
    console.error(`\nCould not seed a test instance\n${(seed.stdout || '') + (seed.stderr || '')}`.slice(-1500));
    process.exit(1);
  }

  const serverEnv = {
    ...process.env,
    PORT: String(port),
    // More archives than the retention limit keeps, so the prune path has
    // something to prune when the backup checks run.
    BACKUP_KEEP: '2',
    BACKUP_INTERVAL_HOURS: '0',
    // The owner this run will sign in as. Set explicitly so first boot creates
    // the account the suite expects instead of printing a random password.
    DATA_DIR: dataDir,
    ASTERISK_CONFIG_DIR: configDir,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
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
  };

  // Starting the server is a function because the backup checks restart the
  // platform on purpose: a staged restore is applied at boot, and the only
  // honest way to test that is to boot again.
  startServer = () => {
    server = spawn(process.execPath, ['src/index.js'], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', (chunk) => (log += chunk));
    server.stderr.on('data', (chunk) => (log += chunk));
    serverLog = () => log;
    return server;
  };
  startServer();
  // The child keeps this process alive, so it must be stopped explicitly at the
  // end of the run — an `exit` handler alone would never fire.
  globalThis.__smokeStopServer = () => {
    if (server && !server.killed) server.kill();
    if (stripeStub) stripeStub.close();
    if (mailjetStub) mailjetStub.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* a leftover temp directory is not a test failure */
      }
    }
  };
  globalThis.__smokeStartServer = () => startServer();
  globalThis.__smokeServerLog = () => serverLog();
  process.on('exit', globalThis.__smokeStopServer);

  const ready = await waitForServer();
  if (!ready) {
    server.kill();
    console.error(`\nCould not start a test server on ${base}\n${serverLog().slice(-1500)}`);
    process.exit(1);
  }
}

/** Poll until the platform answers, or give up. */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Restart the platform this run started. Used by the backup checks: a restore
 * is staged and applied at boot, so proving it means booting again.
 */
async function restartServer() {
  if (!startServer) return false;
  if (server && !server.killed) {
    server.kill();
    // Let the old process release its port before the new one takes it.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      server.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  startServer();
  return waitForServer();
}

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

// ------------------------------------------------------------- first login --
// A new account may not use the console until it has agreed to the terms,
// confirmed its details, proved its address and its phone, and holds a line.
// The suite walks the wizard rather than switching it off: the gate is the
// feature, and every check below this point depends on it having been finished.
const wizard = await call('GET', '/api/onboarding');
check('a fresh account is sent to the first login', wizard.status === 200 && wizard.body.required === true, wizard.body);
check(
  'the first step is the terms',
  wizard.body.next === 'terms',
  wizard.body.steps?.map((step) => `${step.id}:${step.done}`)
);

check(
  'the wizard says where a number can be bought, without inventing a carrier',
  typeof wizard.body.line?.carrier?.voipms === 'boolean',
  wizard.body.line?.carrier
);

const wizardGated = await call('GET', '/api/numbers');
check(
  'the console is closed until the first login is finished',
  wizardGated.status === 403 &&
    wizardGated.body.error?.code === 'onboarding_required' &&
    wizardGated.body.error?.details?.next === 'terms',
  wizardGated.body
);

const accepted = await call('POST', '/api/onboarding/terms', { accept: true });
check(
  'the terms are recorded with the version that was on screen',
  accepted.status === 200 &&
    accepted.body.steps.find((step) => step.id === 'terms').done === true &&
    accepted.body.terms.acceptedVersion === accepted.body.terms.version,
  accepted.body.terms
);

const confirmed = await call('POST', '/api/onboarding/profile', {
  name: 'Telno Owner',
  company: 'Telno',
  address: '1 Main Street',
  city: 'Austin',
  country: 'TX',
  website: '',
  directoryOptIn: false,
});
check(
  'the account and billing details are confirmed',
  confirmed.status === 200 && confirmed.body.steps.find((step) => step.id === 'profile').done === true,
  confirmed.body
);

const emailCode = await call('POST', '/api/onboarding/email/code', {});
check('a code is sent to the address on the account', emailCode.status === 200 && !!emailCode.body.devCode, emailCode.body);
const emailOk = await call('POST', '/api/onboarding/email/verify', { code: emailCode.body.devCode });
check(
  'the address is verified with the code that was sent',
  emailOk.status === 200 && emailOk.body.steps.find((step) => step.id === 'email').done === true,
  emailOk.body
);

const phoneCode = await call('POST', '/api/onboarding/phone/code', { phone: '+15550107777' });
check('a code is sent by text to the phone given', phoneCode.status === 200 && !!phoneCode.body.devCode, phoneCode.body);
const phoneOk = await call('POST', '/api/onboarding/phone/verify', { code: phoneCode.body.devCode });
check(
  'the phone number is verified with the code that was sent',
  phoneOk.status === 200 && phoneOk.body.steps.find((step) => step.id === 'phone').done === true,
  phoneOk.body
);

if (phoneOk.body.next === 'line') {
  // A seeded instance already holds lines with numbers on them. A truly empty
  // one — the case this step exists for — creates its first line here.
  const plan = await call('GET', '/api/setup');
  const made = await call('POST', '/api/setup/line', {
    extension: plan.body.suggested?.extension || '101',
    displayName: 'Owner',
    number: '+15550107788',
  });
  check('the first line and number are created on the switch', made.status === 201 && !!made.body.extension?.secret, made.body);
}

const finished = await call('GET', '/api/onboarding');
check(
  'the first login is finished',
  finished.body.required === false && finished.body.complete === true,
  finished.body.steps?.map((step) => `${step.id}:${step.done}`)
);
const reopened = await call('GET', '/api/numbers');
check('the console answers again once the first login is done', reopened.status === 200, reopened.body);

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

// --------------------------------------------------------- number provider --
// The carrier is optional, and this suite runs with no VoIP.ms credentials on
// purpose: what is asserted is that a deployment without one behaves — the
// console learns the provider is not connected instead of meeting a 500, and no
// request tries to buy a number it cannot pay for.
const providerStatus = await call('GET', '/api/provider/voipms');
check(
  'number provider reports itself disconnected without credentials',
  providerStatus.status === 200 &&
    providerStatus.body.provider === 'voipms' &&
    providerStatus.body.configured === false &&
    providerStatus.body.error === 'not_configured',
  providerStatus.body
);
check(
  'provider status says where credentials would come from, never what they are',
  providerStatus.body.credentials?.username === '' && providerStatus.body.credentials?.password === '',
  providerStatus.body.credentials
);

const providerSearch = await call('GET', '/api/provider/voipms/search?country=US&region=CA&q=415');
check(
  'search without a connected provider is refused, not crashed',
  providerSearch.status === 409 && providerSearch.body.error?.code === 'not_configured',
  providerSearch.body
);

const providerOrder = await call('POST', '/api/provider/voipms/numbers', { dids: ['+14155550199'], monthlyCostCents: 85 });
check(
  'ordering without a connected provider is refused before anything is bought',
  providerOrder.status === 409 && providerOrder.body.error?.code === 'not_configured',
  providerOrder.body
);

const providerBadOrder = await call('POST', '/api/provider/voipms/numbers', { dids: ['not-a-number'] });
check(
  'a garbage DID never reaches the carrier',
  providerBadOrder.status === 400 && providerBadOrder.body.failed?.[0]?.did === 'not-a-number',
  providerBadOrder.body
);

const providerEmptyOrder = await call('POST', '/api/provider/voipms/numbers', {});
check('an empty order is rejected', providerEmptyOrder.status === 400, providerEmptyOrder.body);

const providerCosts = await call('GET', '/api/provider/voipms/costs');
check(
  'rent roll-up answers for the current month',
  providerCosts.status === 200 &&
    /^\d{4}-\d{2}$/.test(providerCosts.body.period) &&
    providerCosts.body.totalCents === 0,
  providerCosts.body
);

const providerBadPeriod = await call('GET', '/api/provider/voipms/costs?period=2026-13');
check('a nonsense rent period is rejected', providerBadPeriod.status === 400, providerBadPeriod.body);

const providerCostsForAccount = await call('GET', `/api/provider/voipms/costs?account=${encode(email)}`);
check(
  'rent can be asked for one account',
  providerCostsForAccount.status === 200 && Array.isArray(providerCostsForAccount.body.charges),
  providerCostsForAccount.body
);

// ---------------------------------------------------------------- telephony --
const extensions = await call('GET', '/api/extensions');
check('extensions listed', extensions.status === 200 && extensions.body.items.length >= 5, extensions.body.items?.length);

const newExtension = await call('POST', '/api/extensions', {
  extension: '299',
  displayName: 'Smoke Desk',
  voicemail: true,
});
check('extension created with a generated secret', newExtension.status === 201 && !!newExtension.body.secret, newExtension.body);
// There is no Apply button anywhere in the console: saving the row has to be
// what writes the file and reloads the switch, or a saved endpoint stays dark.
check(
  'saving an extension writes the switch config and reloads it, with no apply step',
  newExtension.body.applied?.written === true &&
    readFileSync(join(configDir, 'pjsip.conf'), 'utf8').includes('[299]'),
  newExtension.body.applied
);

// A DID is just a number joined to an extension, so the number routes have to
// write the switch as well. Without that, a new DID stays unroutable until
// somebody presses Apply — and there is no Apply button to press any more.
const switchNumber = await call('POST', '/api/numbers', {
  number: '+14155550198',
  name: 'Switch Smoke Line',
  visibility: 'unlisted',
});
check(
  'creating a number rewrites the switch config with no apply step',
  switchNumber.body.applied?.written === true,
  switchNumber.body.applied
);

const linked = await call('PATCH', `/api/extensions/${newExtension.body.extension.id}`, { number: '+14155550198' });
check(
  'a number linked to an extension lands in the generated dialplan',
  linked.status === 200 && readFileSync(join(configDir, 'extensions.conf'), 'utf8').includes('+14155550198'),
  linked.body
);

const unlinked = await call('DELETE', `/api/numbers/${switchNumber.body.number.id}`);
check(
  'deleting the number takes the DID back out of the dialplan',
  unlinked.status === 200 && !readFileSync(join(configDir, 'extensions.conf'), 'utf8').includes('+14155550198'),
  unlinked.body
);

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
  account_name: 'Harbor & Finch Ltd',
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
    account_name: 'Harbor & Finch Ltd',
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
  rendered.html.includes('Harbor &amp; Finch Ltd') && !rendered.html.includes('Harbor & Finch Ltd'),
  'unescaped'
);

// A final notice has one job the reminder does not: name the day service stops.
const finalNotice = finalNoticeEmail(
  {
    invoice_no: 'INV-2026-0101',
    account_name: 'Harbor & Finch Ltd',
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
  accountName: 'Harbor & Finch Ltd',
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

// Stored in the vault, so rejections recorded before it was written have a
// timestamp to be measured against. The earlier wrong-signature checks in this
// run would otherwise look like a rotated secret that nobody rotated.
await call('PUT', '/api/system/vault/STRIPE_WEBHOOK_SECRET', { value: 'whsec_smoke_rotated' });
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

// A timeout is not a refusal, and telling an operator to re-scope their key
// because the host could not reach Stripe sends them to the wrong screen.
stripeDropPath = '/v1/checkout/sessions';
const offlineProbe = await call('POST', '/api/billing/payments/test', {});
check(
  'a probe that cannot reach Stripe says so instead of blaming the key',
  checkOf(offlineProbe, 'checkout')?.state === 'fail' &&
    /Could not reach/.test(checkOf(offlineProbe, 'checkout')?.detail || '') &&
    !/restricted key/.test(checkOf(offlineProbe, 'checkout')?.detail || ''),
  checkOf(offlineProbe, 'checkout')
);
check(
  'the checks that did reach Stripe still report honestly',
  checkOf(offlineProbe, 'api')?.state === 'pass' && checkOf(offlineProbe, 'webhook-secret')?.state === 'pass',
  offlineProbe.body.checks?.map((entry) => `${entry.id}:${entry.state}`)
);

// The endpoint's event list drifts: a feature adds an event, or someone tidies
// the list in the dashboard. The test sees the gap; repair closes it.
check(
  'the test notices events this deployment needs are missing',
  checkOf(connected, 'webhook-ledger')?.state === 'warn' &&
    /invoice\.paid/.test(checkOf(connected, 'webhook-ledger')?.detail || ''),
  checkOf(connected, 'webhook-ledger')
);
// The screen reads the event list itself, so the gap is visible on the page
// instead of only behind a button. That read has to be cheap: the full test
// creates a Checkout session and expires it, which a page load must not do.
const probesBefore = stripeCalls.filter(
  (entry) => entry.method === 'POST' && entry.path === '/v1/checkout/sessions'
).length;
const gapHook = await call('GET', '/api/billing/payments/webhook');
const probesAfter = stripeCalls.filter(
  (entry) => entry.method === 'POST' && entry.path === '/v1/checkout/sessions'
).length;
check(
  'the webhook status is one read, with no payment page created',
  gapHook.status === 200 && probesAfter === probesBefore,
  stripeCalls.slice(-3).map((entry) => `${entry.method} ${entry.path}`)
);
check(
  'the screen sees which events are missing and that repair can close them',
  gapHook.body.webhook?.state === 'missing' &&
    gapHook.body.webhook.missing.includes('invoice.paid') &&
    gapHook.body.webhook.missingLedger.length === 1 &&
    gapHook.body.webhook.repairable === true,
  gapHook.body.webhook
);
const repaired = await call('POST', '/api/billing/payments/webhook/repair', {});
check(
  'repair adds every missing event and keeps the ones already registered',
  repaired.status === 200 &&
    repaired.body.changed === true &&
    repaired.body.added.includes('invoice.paid') &&
    repaired.body.added.includes('invoice.payment_failed') &&
    repaired.body.after.includes('invoice.paid') &&
    repaired.body.after.includes('checkout.session.completed'),
  repaired.body
);
const repairedAgain = await call('POST', '/api/billing/payments/webhook/repair', {});
check(
  'repairing a complete endpoint changes nothing',
  repairedAgain.status === 200 &&
    repairedAgain.body.changed === false &&
    repairedAgain.body.reason === 'nothing_missing',
  repairedAgain.body
);
const healthyAfterRepair = await call('POST', '/api/billing/payments/test', {});
check(
  'the ledger and subscription checks pass once the events are repaired',
  checkOf(healthyAfterRepair, 'webhook-ledger')?.state === 'pass' &&
    checkOf(healthyAfterRepair, 'webhook-subscriptions')?.state === 'pass',
  healthyAfterRepair.body.checks?.map((entry) => `${entry.id}:${entry.state}`)
);

const hookAfterRepair = await call('GET', '/api/billing/payments/webhook');
check(
  'the screen goes quiet once every event is registered',
  hookAfterRepair.body.webhook?.state === 'ok' &&
    hookAfterRepair.body.webhook.missing.length === 0 &&
    hookAfterRepair.body.webhook.repairable === false,
  hookAfterRepair.body.webhook
);

// A rotated secret is the one failure no local check can see: the stored value
// is well formed and verifies its own signature, because it is compared with
// itself. The evidence is a delivery Stripe already sent that failed, so the
// status carries the shape check and the rejections recorded since the secret
// was stored.
await call('PUT', '/api/system/vault/STRIPE_WEBHOOK_SECRET', { value: 'whsec_smoke_rotated' });
const secretOk = await call('GET', '/api/billing/payments/webhook');
check(
  'the status reports a signing secret that works',
  secretOk.body.webhook?.secretState === 'ok' && secretOk.body.webhook.rejections.count === 0,
  secretOk.body.webhook
);

const rejectedBody = JSON.stringify({ id: 'evt_rotated_secret', type: 'invoice.paid', data: { object: {} } });
const rejectedStamp = Math.floor(Date.now() / 1000);
const wrongDigest = createHmac('sha256', 'whsec_someone_elses')
  .update(`${rejectedStamp}.${rejectedBody}`)
  .digest('hex');
const rejectedCall = await fetch(`${base}/api/public/stripe/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'stripe-signature': `t=${rejectedStamp},v1=${wrongDigest}` },
  body: rejectedBody,
});
await rejectedCall.text();
const rotatedSecret = await call('GET', '/api/billing/payments/webhook');
check(
  'a delivery that fails to verify is reported as a rotated secret',
  rotatedSecret.body.webhook?.secretState === 'rejected' &&
    rotatedSecret.body.webhook.rejections.count >= 1 &&
    /not the one Stripe is signing with/.test(rotatedSecret.body.webhook.secretDetail || ''),
  rotatedSecret.body.webhook
);
const rotatedTest = await call('POST', '/api/billing/payments/test', {});
check(
  'the full test names the same deliveries, and still passes the secret itself',
  checkOf(rotatedTest, 'webhook-secret')?.state === 'pass' &&
    checkOf(rotatedTest, 'webhook-rejections')?.state === 'fail',
  rotatedTest.body.checks?.map((entry) => `${entry.id}:${entry.state}`)
);

await call('PUT', '/api/system/vault/STRIPE_WEBHOOK_SECRET', { value: 'sk_test_pasted_by_mistake' });
const malformed = await call('GET', '/api/billing/payments/webhook');
check(
  'a pasted API key is reported as not being a signing secret',
  malformed.body.webhook?.secretState === 'malformed' && /whsec_/.test(malformed.body.webhook.secretDetail || ''),
  malformed.body.webhook
);

// Storing a fresh secret answers for the past: rejections older than it are
// history, not evidence about the value in place now. Without this, a corrected
// deployment would carry a warning forever.
await call('PUT', '/api/system/vault/STRIPE_WEBHOOK_SECRET', { value: 'whsec_smoke_rotated' });
const afterReset = await call('GET', '/api/billing/payments/webhook');
check(
  'rejections older than the stored secret stop counting',
  afterReset.body.webhook?.secretState === 'ok' && afterReset.body.webhook.rejections.count === 0,
  afterReset.body.webhook
);
// Restored to the value the rest of the run signs with, so the replay checks
// below still verify. A fresh write also re-bases the evidence, which is what
// keeps a corrected secret from being warned about forever.
await call('PUT', '/api/system/vault/STRIPE_WEBHOOK_SECRET', { value: 'whsec_smoke' });
const backToEnv = await call('GET', '/api/billing/payments/webhook');
check(
  'a rewritten secret answers for the past and verifies again',
  backToEnv.body.webhook?.secretState === 'ok' && backToEnv.body.webhook.rejections.count === 0,
  backToEnv.body.webhook
);

// A paused endpoint delivers nothing. It is not "fine" and repair is not the
// fix, so the screen has to say what the actual next step is.
stripeEndpointStatus = 'disabled';
const disabledHook = await call('GET', '/api/billing/payments/webhook');
stripeEndpointStatus = 'enabled';
check(
  'a switched-off endpoint is named as switched off, with no repair offered',
  disabledHook.body.webhook?.state === 'disabled' &&
    disabledHook.body.webhook.repairable === false &&
    /disabled/.test(disabledHook.body.webhook.detail || ''),
  disabledHook.body.webhook
);

// The read can fail two ways. A timeout is the network; a 403 is the key. The
// screen says which, because the fixes are in completely different places.
stripeDropPath = '/v1/webhook_endpoints';
const offlineHook = await call('GET', '/api/billing/payments/webhook');
check(
  'a timeout reading the endpoint list says the network, not the key',
  offlineHook.body.webhook?.state === 'unreachable' &&
    /Could not reach/.test(offlineHook.body.webhook.detail || '') &&
    !/read access/.test(offlineHook.body.webhook.detail || ''),
  offlineHook.body.webhook
);
stripeListRefusal = true;
const refusedHook = await call('GET', '/api/billing/payments/webhook');
stripeListRefusal = false;
check(
  'a key without webhook read access is reported as a permission problem',
  refusedHook.body.webhook?.state === 'unreadable' &&
    /read access/.test(refusedHook.body.webhook.detail || '') &&
    refusedHook.body.webhook.repairable === false,
  refusedHook.body.webhook
);

stripeEndpointEvents = ['*'];
const wildcardRepair = await call('POST', '/api/billing/payments/webhook/repair', {});
check(
  'an endpoint subscribed to everything is left alone',
  wildcardRepair.body.changed === false && wildcardRepair.body.reason === 'all_events',
  wildcardRepair.body
);
stripeEndpointEvents = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

// A webhook still pointing at last week's host answers Stripe happily and pays
// nothing. That is the failure this check exists for.
stripeEndpointUrl = 'https://old.example/api/public/stripe/webhook';
const staleWebhook = await call('POST', '/api/billing/payments/test', {});
const orphanRepair = await call('POST', '/api/billing/payments/webhook/repair', {});
check(
  'repair refuses when no endpoint points at this host',
  orphanRepair.status === 400 && /No endpoint points at/.test(orphanRepair.body.error?.message || ''),
  orphanRepair.body
);
const staleHook = await call('GET', '/api/billing/payments/webhook');
check(
  'an endpoint on another host is reported on the page, with no repair offered',
  staleHook.body.webhook?.state === 'not_registered' &&
    staleHook.body.webhook.repairable === false &&
    /No endpoint points at/.test(staleHook.body.webhook.detail || ''),
  staleHook.body.webhook
);
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

// ------------------------------------------------------------------ backups --
// These run last and on their own session, because the restore check restarts
// the platform: a staged restore is applied at boot, so proving it means
// booting again, and everything the suite built before this point lives in the
// database that is about to be replaced.
if (startServer) {
  const again = await call('POST', '/api/auth/login', { email, password });
  token = again.body.token || '';
  check('the owner can sign in again for the backup checks', again.status === 200, again.body);

  // A row that exists before the backup, and one that does not.
  const marker = `Backup marker ${Date.now()}`;
  const created = await call('POST', '/api/operations/tasks', {
    title: marker,
    kind: 'maintenance',
    priority: 'low',
    note: 'created by the backup checks',
  });
  check('a task is created to survive a restore', created.status === 201 || created.status === 200, created.body);

  const taken = await call('POST', '/api/system/backups', {});
  check(
    'a backup can be taken on demand',
    taken.status === 200 && taken.body.ok === true && taken.body.bytes > 0 && taken.body.name.endsWith('.tar.gz'),
    taken.body
  );
  check(
    'the backup records what it holds',
    (taken.body.manifest?.counts?.calls ?? 0) > 0 && taken.body.manifest.database.bytes > 0,
    taken.body.manifest
  );
  check(
    'the manifest names the secrets it does not carry',
    Array.isArray(taken.body.manifest?.secrets_not_included) &&
      taken.body.manifest.secrets_not_included.includes('session.secret'),
    taken.body.manifest?.secrets_not_included
  );

  const listed = await call('GET', '/api/system/backups');
  check(
    'the backup appears in the list with its contents',
    listed.status === 200 &&
      listed.body.items.some((item) => item.name === taken.body.name && item.counts && item.complete),
    listed.body.items?.slice(0, 3)
  );
  check(
    'backup status reports the schedule and where they live',
    listed.body.status.enabled === true && listed.body.status.keep === 2 && !!listed.body.status.dir,
    listed.body.status
  );

  const inspector = await call('GET', `/api/system/backups/${taken.body.name}`);
  check(
    'an archive can be inspected without restoring it',
    inspector.status === 200 && (inspector.body.records?.calls ?? 0) > 0,
    inspector.body
  );

  // A row created after the archive must be gone once it is put back.
  const afterward = `After the archive ${Date.now()}`;
  await call('POST', '/api/operations/tasks', { title: afterward, kind: 'change', priority: 'low' });
  const beforeRestore = await call('GET', '/api/operations/tasks');
  const beforeTitles = (beforeRestore.body.items || []).map((task) => task.title);
  check(
    'both tasks are in the database before the restore',
    beforeTitles.includes(marker) && beforeTitles.includes(afterward),
    beforeTitles.slice(0, 4)
  );

  const badName = await call('POST', '/api/system/backups/restore', { name: '../../etc/passwd' });
  check('a restore cannot be pointed outside the backup directory', badName.status === 400, badName.body);
  const missing = await call('POST', '/api/system/backups/restore', { name: 'telno-19700101-000000.tar.gz' });
  check('restoring an archive that does not exist is refused', missing.status === 400, missing.body);

  const dry = await call('POST', '/api/system/backups/restore', { name: taken.body.name, dryRun: true });
  check(
    'a dry run reports the plan without touching the database',
    dry.status === 200 && dry.body.dryRun === true && (dry.body.records?.calls ?? 0) > 0,
    dry.body
  );

  const staged = await call('POST', '/api/system/backups/restore', { name: taken.body.name });
  check(
    'a restore is staged and asks for the restart it needs',
    staged.status === 200 && staged.body.staged === true && staged.body.restartRequired === true,
    staged.body
  );

  // The platform restarts itself; this is the supervisor's part of that.
  const backUp = await restartServer();
  check('the platform comes back up after staging a restore', backUp === true, globalThis.__smokeServerLog?.()?.slice(-400));
  check(
    'boot reports the restore it applied',
    /restored telno-/.test(globalThis.__smokeServerLog?.() || ''),
    globalThis.__smokeServerLog?.()?.slice(-600)
  );

  const relogin = await call('POST', '/api/auth/login', { email, password });
  token = relogin.body.token || '';
  const afterRestore = await call('GET', '/api/operations/tasks');
  const afterTitles = (afterRestore.body.items || []).map((task) => task.title);
  check('the restored database is served after the restart', afterRestore.status === 200, afterRestore.body);
  check('a row from before the backup is back', afterTitles.includes(marker), afterTitles.slice(0, 4));
  check('a row created after the archive is gone', !afterTitles.includes(afterward), afterTitles.slice(0, 4));

  const cleared = await call('GET', '/api/system/backups');
  check(
    'the staged restore is cleared once it has been applied',
    cleared.body.status.pendingRestore === null && cleared.body.status.failedRestore === null,
    cleared.body.status
  );

  // Retention: BACKUP_KEEP is 2 for this run, so a third archive prunes the oldest.
  const second = await call('POST', '/api/system/backups', {});
  const third = await call('POST', '/api/system/backups', {});
  check(
    'old archives are pruned to the retention limit',
    second.status === 200 && third.status === 200 && third.body.items.length === 2,
    third.body.items?.map((item) => item.name)
  );
  check(
    'pruning removed the oldest archive',
    !third.body.items.some((item) => item.name === taken.body.name),
    third.body.items?.map((item) => item.name)
  );

  const removed = await call('DELETE', `/api/system/backups/${third.body.items[0].name}`);
  check('an archive can be deleted', removed.status === 200 && removed.body.deleted === true, removed.body);
  const gone = await call('GET', `/api/system/backups/${third.body.items[0].name}`);
  check('a deleted archive is not inspectable', gone.status === 404, gone.body);

  // The boot gate that keeps a weak deployment from starting at all.
  const prodRefused = spawnSync(
    process.execPath,
    ['-e', "import('./src/config.js').then((m) => m.assertConfig())"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SESSION_SECRET: 'test-secret-for-the-boot-gate',
        ADMIN_PASSWORD: 'telno-demo-owner',
        PUBLIC_URL: 'https://telno.example',
      },
    }
  );
  check(
    'a production boot refuses the demo password',
    prodRefused.status !== 0 && /known default/.test(`${prodRefused.stdout}${prodRefused.stderr}`),
    `${prodRefused.status} ${(prodRefused.stderr || '').slice(-200)}`
  );

  const httpRefused = spawnSync(
    process.execPath,
    ['-e', "import('./src/config.js').then((m) => m.assertConfig())"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SESSION_SECRET: 'test-secret-for-the-boot-gate',
        ADMIN_PASSWORD: 'a-long-enough-password',
        PUBLIC_URL: 'http://telno.example',
      },
    }
  );
  check(
    'a production boot refuses an http public URL on a real host',
    httpRefused.status !== 0 && /PUBLIC_URL is http/.test(`${httpRefused.stdout}${httpRefused.stderr}`),
    `${httpRefused.status} ${(httpRefused.stderr || '').slice(-200)}`
  );

  const localOkay = spawnSync(
    process.execPath,
    ['-e', "import('./src/config.js').then((m) => m.assertConfig())"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SESSION_SECRET: 'test-secret-for-the-boot-gate',
        ADMIN_PASSWORD: 'a-long-enough-password',
        PUBLIC_URL: 'http://localhost:8080',
      },
    }
  );
  check(
    'a production boot on localhost is allowed to be plain HTTP',
    localOkay.status === 0,
    `${localOkay.status} ${(localOkay.stderr || '').slice(-200)}`
  );

  // The first-run credential. A fresh install without ADMIN_PASSWORD used to
  // print the generated owner password to the log and nowhere else, which for
  // the one credential to a new platform is the wrong place. This boots a
  // second, throwaway instance on its own port and data directory, so both
  // halves are proved: the password is on the volume, and it is not in the log.
  const firstRunDir = await mkdtemp(join(tmpdir(), 'telno-first-run-'));
  const firstRunPort = 8100 + Math.floor(Math.random() * 800);
  const firstRunBase = `http://127.0.0.1:${firstRunPort}`;
  const firstRunEmail = 'first-run@telno.local';
  const firstRunInstance = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(firstRunPort),
      HOST: '127.0.0.1',
      DATA_DIR: firstRunDir,
      ASTERISK_CONFIG_DIR: join(firstRunDir, 'asterisk'),
      ADMIN_EMAIL: firstRunEmail,
      // Empty on purpose: this is the branch that generates a password.
      ADMIN_PASSWORD: '',
      SESSION_SECRET: 'smoke-first-run-secret',
      PUBLIC_URL: firstRunBase,
      TELEPHONY_SIMULATED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstRunLog = '';
  firstRunInstance.stdout.on('data', (chunk) => (firstRunLog += chunk));
  firstRunInstance.stderr.on('data', (chunk) => (firstRunLog += chunk));
  const firstRunFile = join(firstRunDir, 'first-run-password.txt');
  let firstRunPassword = '';
  for (let attempt = 0; attempt < 100 && !firstRunPassword; attempt += 1) {
    if (existsSync(firstRunFile)) {
      firstRunPassword = (readFileSync(firstRunFile, 'utf8').match(/password:\s*(\S+)/) || [])[1] || '';
    }
    if (!firstRunPassword) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  check(
    'a fresh install writes its owner password to the data volume',
    !!firstRunPassword,
    firstRunPassword ? 'found' : firstRunLog.slice(-300)
  );
  // Windows keeps no Unix mode bits, so a writable file there always reports
  // 666 and the assertion would be theatre. It is strict where it means
  // something (Linux, macOS, and the container), and the real 0600 is checked
  // in the container as well.
  const firstRunMode = existsSync(firstRunFile) ? statSync(firstRunFile).mode & 0o777 : 0;
  const windows = process.platform === 'win32';
  check(
    windows ? 'the first-run credential file is written' : 'the first-run credential file is readable only by its owner',
    windows ? !!firstRunPassword : firstRunMode === 0o600,
    `mode ${firstRunMode.toString(8)}`
  );
  check(
    'the generated password is kept out of the log',
    !!firstRunPassword && !firstRunLog.includes(firstRunPassword),
    'the log mentions the password'
  );
  check('boot says where the password went', firstRunLog.includes('first-run-password.txt'), firstRunLog.slice(-200));

  // And the loop closes: it signs in, and setting your own password takes the
  // file away, because the generated password is dead from then on.
  let firstRunReady = false;
  for (let attempt = 0; attempt < 60 && !firstRunReady; attempt += 1) {
    try {
      firstRunReady = (await fetch(`${firstRunBase}/api/healthz`)).ok;
    } catch {
      /* not up yet */
    }
    if (!firstRunReady) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const firstRunLogin = await fetch(`${firstRunBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: firstRunEmail, password: firstRunPassword }),
  });
  const firstRunCookie = (firstRunLogin.headers.get('set-cookie') || '').split(';')[0];
  check('the owner signs in with the password from the volume', firstRunLogin.status === 200, firstRunLogin.status);

  // The console's Account screen is how that credential gets retired, so the
  // session it reads has to say the file is still there — and hand over the
  // path, so the screen can show the command that reads it, without ever
  // receiving the credential itself.
  const firstRunMe = await fetch(`${firstRunBase}/api/auth/me`, { headers: { cookie: firstRunCookie } });
  const firstRunMeBody = await firstRunMe.json().catch(() => ({}));
  check(
    'the owner session says the generated credential is still on the volume',
    firstRunMeBody.firstRun?.pending === true &&
      String(firstRunMeBody.firstRun?.file).endsWith('first-run-password.txt'),
    JSON.stringify(firstRunMeBody.firstRun)
  );
  check(
    'the session payload never carries the credential itself',
    !!firstRunPassword && !JSON.stringify(firstRunMeBody).includes(firstRunPassword),
    'the credential is in the /auth/me payload'
  );
  const firstRunChange = await fetch(`${firstRunBase}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: firstRunCookie },
    body: JSON.stringify({ currentPassword: firstRunPassword, newPassword: 'a-real-owner-password' }),
  });
  const changedBody = await firstRunChange.json().catch(() => ({}));
  check(
    'setting your own password removes the first-run file',
    firstRunChange.status === 200 && changedBody.firstRunCredentialRemoved === true && !existsSync(firstRunFile),
    `${firstRunChange.status} ${JSON.stringify(changedBody).slice(0, 120)}`
  );
  // The other half of the screen's contract: once the password is the owner's
  // own, the file is gone and the notice has to go with it. The cookie from
  // before the change is dead by design, so this uses the one the change set.
  const refreshedCookie = (firstRunChange.headers.get('set-cookie') || '').split(';')[0];
  const firstRunMeAfter = await fetch(`${firstRunBase}/api/auth/me`, { headers: { cookie: refreshedCookie } });
  const firstRunMeAfterBody = await firstRunMeAfter.json().catch(() => ({}));
  check(
    'the screen is told the generated credential is gone',
    firstRunMeAfter.status === 200 && firstRunMeAfterBody.firstRun?.pending === false,
    `${firstRunMeAfter.status} ${JSON.stringify(firstRunMeAfterBody.firstRun)}`
  );

  if (!firstRunInstance.killed) firstRunInstance.kill();
  try {
    rmSync(firstRunDir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not a test failure */
  }
}

/* --------------------------------------------------------------- marketing -- */
// A campaign is the whole pipeline in one feature: a list that de-duplicates,
// an exclusive queue, a disposition that becomes a grade, and a report that
// leaves as a real PDF. Each of those is checked separately because each one
// failing looks different to the operator.

console.log('\nMarketing');

const anonymousMarketing = await fetch(`${base}/api/marketing/overview`);
check(
  'the marketing pipeline is not readable without a session',
  anonymousMarketing.status === 401,
  anonymousMarketing.status
);

const templates = await call('GET', '/api/marketing/overview');
check(
  'the campaign templates carry a goal, a script and coaching notes',
  templates.body.templates?.length >= 4 &&
    templates.body.templates.every((entry) => entry.goal && entry.script && entry.tips?.length),
  templates.body.templates?.map((entry) => entry.id)
);
check(
  'the overview says whether grading is on a model or on rules',
  typeof templates.body.ai?.configured === 'boolean' && !!templates.body.ai?.model,
  templates.body.ai
);

const campaignName = `Smoke renewal ${Date.now()}`;
const createdCampaign = await call('POST', '/api/marketing/campaigns', { name: campaignName, template: 'renewal' });
const campaignId = createdCampaign.body.campaign?.id;
check('a campaign can be created from a template', createdCampaign.status === 201 && !!campaignId, createdCampaign.body);
check(
  'the template copies its goal and script into the campaign',
  /Renew a subscription/.test(createdCampaign.body.campaign?.goal || '') &&
    /Innotel Labs/.test(createdCampaign.body.campaign?.script || ''),
  createdCampaign.body.campaign
);
check(
  'a second campaign with the same name is refused',
  (await call('POST', '/api/marketing/campaigns', { name: campaignName })).status === 409
);

// Dedupe is the point of the importer: the same list, pasted twice, must not
// dial anybody twice.
const imported = await call('POST', `/api/marketing/campaigns/${campaignId}/contacts`, {
  text: [
    'Dana Reed, (415) 555-0150',
    'dana@example.com, +1 415 555 0150',
    'Acme Ltd 0044 20 7946 0026',
    'this line is not a phone number',
    '+1 415 555 0162',
  ].join('\n'),
});
check(
  'a pasted list is imported, de-duplicated and counted honestly',
  imported.body.report?.added === 3 &&
    imported.body.report?.duplicates === 1 &&
    imported.body.report?.invalid === 1,
  imported.body.report
);
check(
  'the same person pasted again adds nothing',
  (
    await call('POST', `/api/marketing/campaigns/${campaignId}/contacts`, {
      text: 'Dana Reed, (415) 555-0150',
    })
  ).body.report?.added === 0
);

const draftCampaignRun = await call('POST', `/api/marketing/campaigns/${campaignId}/run`, { limit: 5 });
check('a draft campaign refuses to dial', draftCampaignRun.status === 400, draftCampaignRun.body);

await call('PATCH', `/api/marketing/campaigns/${campaignId}`, { status: 'running' });
const firstBatch = await call('POST', `/api/marketing/campaigns/${campaignId}/run`, { limit: 2 });
const secondBatch = await call('POST', `/api/marketing/campaigns/${campaignId}/run`, { limit: 2 });
const firstIds = (firstBatch.body.batch || []).map((contact) => contact.id);
check(
  'a run claims a batch and moves the contacts to calling',
  firstIds.length === 2 && firstBatch.body.batch.every((contact) => contact.status === 'calling'),
  firstBatch.body.batch
);
check(
  'a second run never claims the same contact',
  (secondBatch.body.batch || []).every((contact) => !firstIds.includes(contact.id)),
  { first: firstIds, second: (secondBatch.body.batch || []).map((contact) => contact.id) }
);
check(
  'the batch says whether the switch is real or simulated',
  typeof firstBatch.body.telephony?.simulate === 'boolean',
  firstBatch.body.telephony
);

const graded = await call('POST', `/api/marketing/contacts/${firstIds[0]}/outcome`, {
  outcome: 'interested',
  durationSec: 190,
  transcript:
    'Customer: yes, send the quote by email and book Thursday at 2pm. Agent: I will send it now.',
});
check(
  'a disposition is recorded and graded with reasons',
  graded.status === 200 &&
    Number.isFinite(graded.body.contact?.grade) &&
    graded.body.contact?.reasons?.length > 0,
  graded.body.contact
);
check(
  'a call that agrees a next step scores as a lead',
  graded.body.contact?.grade >= 60,
  graded.body.contact?.grade
);

const blocked = await call('POST', `/api/marketing/contacts/${firstIds[1]}/outcome`, {
  outcome: 'do-not-call',
  durationSec: 25,
  transcript: 'Please stop calling me.',
});
check(
  'a do-not-call is honored and scores zero, not averaged in',
  blocked.body.contact?.status === 'do_not_call' && blocked.body.contact?.grade === 0,
  blocked.body.contact
);
// Same number, same list, second import: the opt-out is checked before the
// duplicate, because honoring a do-not-call matters more than tidiness.
const blockedNumber = blocked.body.contact?.number || '';
const afterDoNotCall = await call('POST', `/api/marketing/campaigns/${campaignId}/contacts`, {
  text: blockedNumber,
});
const optouts = await call('GET', '/api/optouts');
check(
  'the number that asked not to be called cannot be imported again',
  afterDoNotCall.body.report?.added === 0 && afterDoNotCall.body.report?.optedOut === 1,
  { report: afterDoNotCall.body.report, number: blockedNumber }
);
check(
  'the platform-wide opt-out list knows about it',
  (optouts.body.items || []).some((row) => row.e164 === blocked.body.contact?.e164),
  optouts.body.items
);

const report = await call('POST', `/api/marketing/campaigns/${campaignId}/report`, {});
check(
  'a report is built for the campaign with its own numbers',
  report.status === 201 && report.body.report?.bytes > 800 && report.body.report?.totals?.dialed >= 2,
  report.body.report && { bytes: report.body.report.bytes, totals: report.body.report.totals }
);
check(
  'the report totals exclude the blocked contact from the average',
  report.body.report?.totals?.averageGrade >= 60 && report.body.report?.totals?.blocked === 1,
  report.body.report?.totals
);
const pdf = await fetch(`${base}${report.body.report.downloadPath}`, { headers: { cookie } });
const pdfBytes = Buffer.from(await pdf.arrayBuffer());
check(
  'the report downloads as a real PDF, not a renamed text file',
  pdf.status === 200 &&
    pdf.headers.get('content-type') === 'application/pdf' &&
    pdfBytes.subarray(0, 5).toString() === '%PDF-' &&
    pdfBytes.length > 800,
  { status: pdf.status, type: pdf.headers.get('content-type'), bytes: pdfBytes.length }
);

const reportEmailBecauseUnconfigured = await call('POST', `/api/marketing/campaigns/${campaignId}/report`, {
  email: 'reports@example.com',
});
check(
  'a report email records which provider carried it, or why it did not',
  reportEmailBecauseUnconfigured.status === 201 &&
    !!reportEmailBecauseUnconfigured.body.report?.delivery?.channel &&
    (reportEmailBecauseUnconfigured.body.report.delivery.delivered === true ||
      !!reportEmailBecauseUnconfigured.body.report.delivery.error),
  reportEmailBecauseUnconfigured.body.report?.delivery
);

const suggestion = await call('POST', '/api/marketing/suggest', { goal: 'Book a review call', script: '' });
check(
  'a script suggestion works or explains that no model key is set',
  suggestion.status === 200 && (suggestion.body.ok === true || suggestion.body.error === 'ai_not_configured'),
  suggestion.body.error || 'suggested'
);

await call('DELETE', `/api/marketing/campaigns/${campaignId}`);
check('a campaign can be deleted', (await call('GET', `/api/marketing/campaigns/${campaignId}`)).status === 404);

/* ---------------------------------------------------------------- commerce -- */

console.log('\nPlans and the subscriber portal');

const pricing = await call('GET', '/api/public/plans', undefined, { noCookie: true, bearer: '' });
check(
  'the public pricing page lists sellable plans and what each includes',
  pricing.status === 200 &&
    pricing.body.plans?.length >= 3 &&
    pricing.body.plans.every((plan) => plan.features.length > 0 && plan.price),
  pricing.body.plans?.map((plan) => `${plan.slug}:${plan.features.length}`)
);
check(
  'the pricing page is public and names the product and vendor',
  pricing.body.product === 'Telno' && pricing.body.vendor === 'Innotel Labs',
  { product: pricing.body.product, vendor: pricing.body.vendor }
);
// The catalog is flat rate with unlimited calling, and it carries a second
// ladder for households: a plan that is priced per seat, or one that appears on
// the wrong shelf, is the thing this asserts against.
const audienceOf = (plan) => plan.audience || 'business';
check(
  'every plan is flat rate with unlimited minutes',
  pricing.body.plans.every((plan) => plan.minutesUnlimited === true),
  pricing.body.plans.map((plan) => `${plan.slug}=${plan.minutesUnlimited}`)
);
check(
  'the catalog sells both a business and a residential ladder',
  pricing.body.plans.filter((plan) => audienceOf(plan) === 'business').length >= 3 &&
    pricing.body.plans.filter((plan) => audienceOf(plan) === 'residential').length >= 2,
  pricing.body.plans.map((plan) => `${plan.slug}:${audienceOf(plan)}`)
);
const residential = pricing.body.plans.find((plan) => audienceOf(plan) === 'residential');
check(
  'a residential plan carries calling and encryption but no campaign machinery',
  !!residential &&
    residential.features.some((feature) => feature.key === 'calling') &&
    residential.features.some((feature) => feature.key === 'encrypted-media') &&
    !residential.features.some((feature) => feature.key === 'campaigns'),
  residential?.features.map((feature) => feature.key)
);

const featureKey = `smoke-feature-${Date.now()}`;
const newFeature = await call('POST', '/api/features', {
  key: featureKey,
  label: 'Smoke feature',
  description: 'Created by the smoke suite',
  category: 'calling',
});
check('a feature can be added to the catalog', newFeature.status === 201 && newFeature.body.feature?.key === featureKey, newFeature.body);

const planSlug = `smoke-plan-${Date.now()}`;
const newPlan = await call('POST', '/api/plans', {
  name: 'Smoke plan',
  slug: planSlug,
  tagline: 'Created by the smoke suite',
  priceCents: 4900,
  currency: 'USD',
  interval: 'month',
  seats: 3,
  includedMinutes: 500,
  features: ['calling', featureKey],
});
const planId = newPlan.body.plan?.id;
check(
  'a plan can be created with a chosen set of features',
  newPlan.status === 201 && newPlan.body.plan?.features?.some((feature) => feature.key === featureKey),
  newPlan.body.plan?.features?.map((feature) => feature.key)
);
const publicWithPlan = await call('GET', '/api/public/plans', undefined, { noCookie: true, bearer: '' });
check(
  'a new plan appears on the public page immediately, with its price',
  publicWithPlan.body.plans?.some((plan) => plan.slug === planSlug && plan.priceCents === 4900),
  publicWithPlan.body.plans?.map((plan) => plan.slug)
);

const repriced = await call('PATCH', `/api/plans/${planId}`, { priceCents: 5900, features: ['calling'] });
check(
  'editing a plan changes its price and drops a feature in one save',
  repriced.body.plan?.priceCents === 5900 &&
    !repriced.body.plan?.features?.some((feature) => feature.key === featureKey),
  repriced.body.plan
);

const retired = await call('DELETE', `/api/plans/${planId}`);
const publicAfterRetire = await call('GET', '/api/public/plans', undefined, { noCookie: true, bearer: '' });
check(
  'a retired plan stops being sold but is not deleted',
  retired.body.ok === true && !publicAfterRetire.body.plans?.some((plan) => plan.slug === planSlug),
  publicAfterRetire.body.plans?.map((plan) => plan.slug)
);
check('deleting a feature for good works', (await call('DELETE', `/api/features/${featureKey}`)).status === 200);

// The gate: a customer without a live subscription cannot use the console, and
// a staff account is never locked out by the commerce side.
//
// The signup path is exercised against the local Stripe stand-in, and the
// subscription is granted by a signed webhook rather than by the browser
// returning to the success page: the event is what the platform trusts.
const subscriberEmail = `smoke-subscriber-${Date.now()}@example.com`;
const signedUp = await call(
  'POST',
  '/api/public/subscribe',
  {
    plan: 'business',
    name: 'Smoke Subscriber',
    email: subscriberEmail,
    password: 'smoke-subscriber-password',
    origin: 'http://subscribe.telno.services',
  },
  { noCookie: true, bearer: '' }
);
check(
  'a public signup creates the account and returns a Stripe checkout page',
  signedUp.status === 201 && /checkout\.stripe\.test/.test(signedUp.body.checkoutUrl || '') && !!signedUp.body.subscriptionId,
  signedUp.body
);
check(
  'the checkout page is a subscription, priced from the plan, with the account attached',
  stripeCalls.some(
    (entry) =>
      entry.path.startsWith('/v1/checkout/sessions') &&
      entry.body.includes('mode=subscription') &&
      entry.body.includes('%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month') &&
      entry.body.includes(encodeURIComponent(signedUp.body.subscriptionId))
  ),
  stripeCalls.filter((entry) => entry.path.startsWith('/v1/checkout/sessions')).slice(-1)
);

const subscriberLogin = await call(
  'POST',
  '/api/auth/login',
  { email: subscriberEmail, password: 'smoke-subscriber-password' },
  { noCookie: true, bearer: '' }
);
const subscriberCookie = (subscriberLogin.headers.get('set-cookie') || '').split(';')[0];
check('the new subscriber can sign in', subscriberLogin.status === 200 && !!subscriberCookie, subscriberLogin.status);

// The line comes from the platform, the number from the subscriber: the operator
// assigns the line the plan bought, and the first login puts a number on it. Both
// happen before the portal checks below, because an account that has not finished
// the wizard is refused every portal route with the step it stopped at.
const assignedLine = await call('POST', '/api/extensions', {
  extension: '296',
  displayName: 'Subscriber Line',
  voicemail: true,
  account: subscriberEmail,
});
check(
  'an operator can assign a line to a customer account',
  assignedLine.status === 201 && assignedLine.body.extension?.accountEmail === subscriberEmail,
  assignedLine.body.extension
);

const subscriberSetup = await finishFirstLogin(subscriberCookie, { extension: '296', number: '+14155550112' });
check(
  'a paying subscriber finishes the first login and then holds their line',
  subscriberSetup.body?.complete === true,
  subscriberSetup.body?.steps?.map((step) => `${step.id}:${step.done}`)
);

const gated = await fetch(`${base}/api/auth/me`, { headers: { cookie: subscriberCookie } });
const gatedBody = await gated.json().catch(() => ({}));
check(
  'an unpaid subscriber is locked out of the console with a 402 and a reason',
  gated.status === 402 && gatedBody.error?.code === 'payment_required',
  { status: gated.status, error: gatedBody.error }
);
const portalStatus = await fetch(`${base}/api/portal/status`, { headers: { cookie: subscriberCookie } });
const portalBody = await portalStatus.json().catch(() => ({}));
check(
  'the locked-out subscriber can still see their status and the plans',
  portalStatus.status === 200 && portalBody.entitlement?.active === false && portalBody.plans?.length > 0,
  portalBody.entitlement
);
const customerAdmin = await fetch(`${base}/api/plans`, { headers: { cookie: subscriberCookie } });
check('a customer cannot reach the commerce admin', customerAdmin.status === 403, customerAdmin.status);

// The webhook is the authority: until Stripe confirms, the account stays shut.
const subscriptionEvent = (event, object) =>
  JSON.stringify({ id: `evt_${event.replace(/\W/g, '_')}`, type: event, data: { object } });
const postStripeEvent = async (payload) => {
  const stamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', 'whsec_smoke').update(`${stamp}.${payload}`).digest('hex');
  const res = await fetch(`${base}/api/public/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${stamp},v1=${digest}` },
    body: payload,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const subscriptionActivated = await postStripeEvent(
  subscriptionEvent('checkout.session.completed', {
    id: 'cs_test_sub_1',
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'paid',
    subscription: 'sub_test_smoke_1',
    customer: 'cus_test_smoke_1',
    client_reference_id: signedUp.body.account?.id || '',
    metadata: { kind: 'subscription', subscriptionId: signedUp.body.subscriptionId, platform: 'telno' },
  })
);
check(
  'a signed subscription webhook activates the subscription',
  subscriptionActivated.status === 200 && subscriptionActivated.body.subscription?.ok === true,
  subscriptionActivated.body
);
const afterActivation = await fetch(`${base}/api/auth/me`, { headers: { cookie: subscriberCookie } });
check('paying for the plan opens the console', afterActivation.status === 200, afterActivation.status);
const entitled = await fetch(`${base}/api/portal/status`, { headers: { cookie: subscriberCookie } });
const entitledBody = await entitled.json();
check(
  'the portal reports the plan and the features it carries',
  entitledBody.entitlement?.active === true &&
    entitledBody.entitlement?.plan?.slug === 'business' &&
    entitledBody.entitlement?.features?.includes('video-calling'),
  entitledBody.entitlement
);

// What Stripe collects for a plan is money, and money belongs in the ledger:
// a bill for rent never carries the plan charge, so without these rows the panel
// shows a customer paying every month and nothing collected from them.
console.log('\nPlan charges in the ledger');
const planPaidAt = Math.floor(Date.now() / 1000) - 3600;
const planChargeEvent = subscriptionEvent('invoice.paid', {
  id: 'in_smoke_plan_1',
  object: 'invoice',
  status: 'paid',
  paid: true,
  amount_paid: 7900,
  currency: 'usd',
  customer: 'cus_test_smoke_1',
  subscription: 'sub_test_smoke_1',
  billing_reason: 'subscription_create',
  period_start: planPaidAt,
  period_end: planPaidAt + 30 * 24 * 3600,
  status_transitions: { paid_at: planPaidAt },
});
const planCharge = await postStripeEvent(planChargeEvent);
const planRows = async () => {
  const detail = await call('GET', `/api/crm/customers/${signedUp.body.account?.id}`);
  return (detail.body.billing?.payments || []).filter((row) => row.reference === 'in_smoke_plan_1');
};
const recordedPlan = await planRows();
check(
  'a paid plan invoice is recorded against the customer',
  planCharge.status === 200 &&
    planCharge.body.charge?.recorded === true &&
    recordedPlan.length === 1 &&
    recordedPlan[0].amountCents === 7900 &&
    recordedPlan[0].method === 'stripe' &&
    /^Plan — /.test(recordedPlan[0].note || ''),
  { webhook: planCharge.body, rows: recordedPlan }
);

// Stripe retries an event it did not see a 200 for, and sends both a paid and a
// succeeded flavour of the same collection.
const planChargeRetry = await postStripeEvent(planChargeEvent);
const succeededFlavour = await postStripeEvent(planChargeEvent.replace('invoice.paid', 'invoice.payment_succeeded'));
check(
  'a retried plan charge is never recorded twice',
  planChargeRetry.body.charge?.recorded === false &&
    succeededFlavour.body.charge?.recorded === false &&
    (await planRows()).length === 1,
  { retry: planChargeRetry.body.charge, succeeded: succeededFlavour.body.charge }
);

const foreignCharge = await postStripeEvent(
  subscriptionEvent('invoice.paid', {
    id: 'in_smoke_foreign_1',
    object: 'invoice',
    status: 'paid',
    amount_paid: 5000,
    currency: 'usd',
    customer: 'cus_someone_else',
    subscription: 'sub_someone_else',
  })
);
check(
  'a paid invoice for an account we do not know is ignored',
  foreignCharge.status === 200 && foreignCharge.body.charge?.recorded === false &&
    foreignCharge.body.charge?.reason === 'unknown_subscription',
  foreignCharge.body
);

const emptyCharge = await postStripeEvent(
  subscriptionEvent('invoice.paid', {
    id: 'in_smoke_empty_1',
    object: 'invoice',
    status: 'open',
    amount_paid: 0,
    currency: 'usd',
    customer: 'cus_test_smoke_1',
    subscription: 'sub_test_smoke_1',
  })
);
check(
  'an invoice that collected nothing adds no money',
  emptyCharge.body.charge?.recorded === false && emptyCharge.body.charge?.reason === 'nothing_collected',
  emptyCharge.body
);

const backfilled = await call('POST', `/api/crm/customers/${signedUp.body.account?.id}/payments/sync`, {});
check(
  'the panel can pull the plan charges Stripe already collected',
  backfilled.status === 200 && backfilled.body.scanned === 1 && backfilled.body.recorded === 1,
  backfilled.body
);
const backfilledAgain = await call('POST', `/api/crm/customers/${signedUp.body.account?.id}/payments/sync`, {});
check(
  'a second sync adds nothing, so pressing the button twice is safe',
  backfilledAgain.status === 200 && backfilledAgain.body.recorded === 0 && backfilledAgain.body.scanned === 1,
  backfilledAgain.body
);

// A failed renewal is what the gate exists for on an established account.
const failedRenewal = await postStripeEvent(
  subscriptionEvent('invoice.payment_failed', { id: 'in_smoke_1', subscription: 'sub_test_smoke_1' })
);
// The paid gate is probed on the customer's own surface: /api/calls is the
// platform's, and a customer is refused that outright whether they are paid or
// not. What their subscription buys is their own portal.
const afterFailed = await fetch(`${base}/api/me`, { headers: { cookie: subscriberCookie } });
check(
  'a failed renewal closes the portal again',
  failedRenewal.body.ok === true && afterFailed.status === 402,
  { webhook: failedRenewal.body, access: afterFailed.status }
);

// A webhook endpoint can run a newer API version than the one the platform
// itself calls Stripe with. Version 2025-03-31 moved two fields this code
// reads, so both shapes have to work: otherwise a paid account silently never
// expires, and a lapsed renewal is never noticed.
console.log('\nStripe API versions');

const itemPeriodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const itemShaped = await postStripeEvent(
  subscriptionEvent('customer.subscription.updated', {
    id: 'sub_test_smoke_1',
    status: 'active',
    // No top-level current_period_end: only the item carries it now.
    items: { data: [{ id: 'si_smoke_1', current_period_end: itemPeriodEnd }] },
  })
);
const itemStatus = await fetch(`${base}/api/portal/status`, { headers: { cookie: subscriberCookie } });
const itemBody = await itemStatus.json();
check(
  'a 2025+ subscription event stores the period from the subscription item',
  itemShaped.body.ok === true &&
    itemBody.entitlement?.active === true &&
    itemBody.subscription?.currentPeriodEnd === new Date(itemPeriodEnd * 1000).toISOString(),
  { webhook: itemShaped.body, subscription: itemBody.subscription }
);

const parentShaped = await postStripeEvent(
  subscriptionEvent('invoice.payment_failed', {
    id: 'in_smoke_2',
    // The invoice itself no longer names the subscription; its parent does.
    parent: { subscription_details: { subscription: 'sub_test_smoke_1' } },
  })
);
const afterParentFailed = await fetch(`${base}/api/me`, { headers: { cookie: subscriberCookie } });
check(
  'a 2025+ invoice failure finds the subscription under the invoice parent',
  parentShaped.body.ok === true && afterParentFailed.status === 402,
  { webhook: parentShaped.body, access: afterParentFailed.status }
);

const ownerCookie = cookie;
const comped = await call('POST', '/api/subscriptions', { email: subscriberEmail, planId: 'business', status: 'active' });
check(
  'an operator can restore access without a card',
  comped.status === 201 && comped.body.subscription?.status === 'active',
  comped.body.subscription
);
const afterComp = await fetch(`${base}/api/me`, { headers: { cookie: subscriberCookie } });
check('the restored subscription opens the customer portal', afterComp.status === 200, afterComp.status);

/**
 * Walk the required first login for a session, the way a person does.
 *
 * The gate is part of the product, so every account the suite expects to use the
 * console has to finish it: terms, details, a code typed back for the address and
 * for the phone, and a line with a number on it. `extension` names the line to
 * put the number on when the account has one, `makeLine` the line to create when
 * it has none.
 */
async function finishFirstLogin(cookie, { extension = '', number = '', makeLine = '' } = {}) {
  const send = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  await send('POST', '/api/onboarding/terms', { accept: true });
  await send('POST', '/api/onboarding/profile', {
    name: 'Smoke Subscriber',
    company: 'Smoke Subscriber Co',
    address: '120 Harbor Way',
    city: 'Austin',
    country: 'US',
    website: 'smoke.example',
    directoryOptIn: false,
  });
  const email = await send('POST', '/api/onboarding/email/code', {});
  if (email.body?.devCode) await send('POST', '/api/onboarding/email/verify', { code: email.body.devCode });
  const phone = await send('POST', '/api/onboarding/phone/code', { phone: '+14155550111' });
  if (phone.body?.devCode) await send('POST', '/api/onboarding/phone/verify', { code: phone.body.devCode });

  const state = await send('GET', '/api/onboarding');
  if (state.body?.next === 'line') {
    // A line of their own takes the number; without one the step creates the line
    // itself, which is what a subscriber who has just paid is looking at.
    const made = state.body.line?.lines
      ? await send('POST', '/api/setup/number', { extension, number })
      : await send('POST', '/api/setup/line', { extension: makeLine || '275', displayName: 'Smoke Subscriber', number });
    if (made.status >= 400) throw new Error(`first login could not finish the line step: ${made.status} ${JSON.stringify(made.body)}`);
  }
  return send('GET', '/api/onboarding');
}

/* --------------------------------------------------- the customer portal -- */
// A paying customer is not an operator. Their own line, plan and invoices are
// theirs; the switch, the registry and the campaigns are not, and the boundary
// is a single check in the auth plugin rather than a habit of each route.

console.log('\nThe customer portal');

const customerMe = await fetch(`${base}/api/me`, { headers: { cookie: subscriberCookie } });
const customerMeBody = await customerMe.json().catch(() => ({}));
check(
  'the portal serves the customer their own line, plan and brand',
  customerMe.status === 200 &&
    customerMeBody.lines?.some((line) => line.extension === '296') &&
    customerMeBody.plan?.slug === 'business' &&
    !!customerMeBody.brand?.name,
  { lines: customerMeBody.lines?.map((line) => line.extension), plan: customerMeBody.plan?.slug }
);
check(
  'the portal lists only lines that belong to the customer',
  (customerMeBody.lines || []).length > 0 &&
    (customerMeBody.lines || []).every((line) => line.extension === '296'),
  customerMeBody.lines?.map((line) => line.extension)
);

const staffSurface = ['/api/calls', '/api/extensions', '/api/numbers', '/api/plans', '/api/system/status', '/api/marketing/campaigns', '/api/estate/sites', '/api/billing/summary'];
const reached = [];
for (const path of staffSurface) {
  const res = await fetch(base + path, { headers: { cookie: subscriberCookie } });
  reached.push(`${path}=${res.status}`);
}
check(
  'a customer cannot reach platform operations, campaigns or the switch inventory',
  reached.every((entry) => entry.endsWith('=403')),
  reached
);

// The invoice ledger is the one place where a wrong filter shows somebody else
// their neighbor's bill, so it gets its own two-sided test.
const ownInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Smoke Subscriber',
  email: subscriberEmail,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  amountCents: 7900,
});
const otherEmail = `portal-other-${Date.now()}@example.com`;
await call('POST', '/api/billing/invoices', {
  accountName: 'Someone Else',
  email: otherEmail,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  amountCents: 19900,
});
const meWithInvoices = await (await fetch(`${base}/api/me`, { headers: { cookie: subscriberCookie } })).json();
check(
  'the portal shows the customer their own invoices and nobody else\u2019s',
  ownInvoice.status === 201 &&
    (meWithInvoices.invoices || []).some((invoice) => invoice.id === ownInvoice.body.invoice?.id) &&
    (meWithInvoices.invoices || []).every((invoice) => !invoice.number.includes('Someone Else')),
  meWithInvoices.invoices?.map((invoice) => invoice.number)
);

// ...whereas the operator still sees the whole ledger.
const wholeLedger = (await call('GET', '/api/billing/invoices')).body.items || [];
check(
  'the operator still sees every invoice on the platform',
  wholeLedger.some((invoice) => invoice.id === ownInvoice.body.invoice?.id) && wholeLedger.length > 1,
  wholeLedger.length
);

const foreignLine = await fetch(`${base}/api/softphone/session`, {
  method: 'POST',
  headers: { cookie: subscriberCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ extension: '101' }),
});
check('a customer cannot open a softphone session for another line', foreignLine.status === 403, foreignLine.status);

const ownLine = await fetch(`${base}/api/softphone/session`, {
  method: 'POST',
  headers: { cookie: subscriberCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ extension: '296' }),
});
const ownLineBody = await ownLine.json().catch(() => ({}));
check(
  'a customer can open a softphone session on their own line, with encrypted media',
  ownLine.status === 201 && ownLineBody.media?.encryption === 'dtls-srtp' && !!ownLineBody.ticket,
  { status: ownLine.status, media: ownLineBody.media }
);

const lineId = (customerMeBody.lines || []).find((line) => line.extension === '296')?.id;
const selfService = await fetch(`${base}/api/me/line/${lineId}`, {
  method: 'PATCH',
  headers: { cookie: subscriberCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ voicemail: false, displayName: 'Subscriber Desk' }),
});
const selfBody = await selfService.json().catch(() => ({}));
check(
  'a customer can rename and reconfigure their own line',
  selfService.status === 200 && selfBody.line?.voicemail === false && selfBody.line?.displayName === 'Subscriber Desk',
  selfBody.line
);

const staffLine = (await call('GET', '/api/extensions')).body.items.find((row) => row.extension === '101');
const foreignPatch = await fetch(`${base}/api/me/line/${staffLine.id}`, {
  method: 'PATCH',
  headers: { cookie: subscriberCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ voicemail: false }),
});
check("a customer cannot touch a line that is not theirs", foreignPatch.status === 404, foreignPatch.status);

// Onboarding by hand: the customer who pays by transfer has no checkout page.
const handEmail = `smoke-hand-${Date.now()}@example.com`;
const onboarded = await call('POST', '/api/customers', {
  email: handEmail,
  name: 'Hand Onboarded',
  password: 'smoke-hand-password',
  planId: 'starter',
  status: 'active',
});
check(
  'an operator can onboard a customer account with a plan in one step',
  onboarded.status === 201 && onboarded.body.subscription?.planSlug === 'starter',
  onboarded.body
);
const handLogin = await call(
  'POST',
  '/api/auth/login',
  { email: handEmail, password: 'smoke-hand-password' },
  { noCookie: true, bearer: '' }
);
const handCookie = (handLogin.headers.get('set-cookie') || '').split(';')[0];
const handSetup = await finishFirstLogin(handCookie, { number: '+14155550144', makeLine: '285' });
check(
  'a hand-onboarded customer finishes the same first login',
  handSetup.body?.complete === true && handSetup.body?.line?.lines === 1,
  handSetup.body?.steps?.map((step) => `${step.id}:${step.done}`)
);
const handAccess = await fetch(`${base}/api/me`, { headers: { cookie: handCookie } });
check('the hand-onboarded customer can use the portal immediately', handAccess.status === 200, handAccess.status);

// A staff account is never gated: the owner can still reach everything above.
const staffStillIn = await fetch(`${base}/api/plans`, { headers: { cookie: ownerCookie } });
check('a staff account is never gated by the commerce side', staffStillIn.status === 200, staffStillIn.status);
cookie = ownerCookie;

/* ------------------------------------------------- invoice lines and rent -- */
// An invoice used to be one number. A line item is what lets a customer see
// what they are paying for, and what lets a month of number rent live on the
// bill instead of only in the ledger.
console.log('\nInvoice line items and number rent');

const today = new Date().toISOString().slice(0, 10);
const lineInvoice = await call('POST', '/api/billing/invoices', {
  accountName: 'Line Items Co',
  email: 'lines@example.com',
  periodStart: today,
  periodEnd: today,
  items: [
    { description: 'Number rent — office line', amountCents: 1450 },
    { description: 'Installation', amountCents: 5000 },
    { description: 'Loyalty discount', kind: 'discount', amountCents: -500 },
  ],
});
const lineInvoiceId = lineInvoice.body.invoice?.id;
check(
  'an invoice built from lines totals their sum',
  lineInvoice.status === 201 &&
    lineInvoice.body.invoice?.amountCents === 5950 &&
    (lineInvoice.body.invoice?.items || []).length === 3,
  lineInvoice.body.invoice
);
check(
  'a discount is a negative line, not a special case in the total',
  (lineInvoice.body.invoice?.items || []).some((item) => item.kind === 'discount' && item.amountCents === -500),
  lineInvoice.body.invoice?.items
);

const typedTotal = await call('PATCH', `/api/billing/invoices/${lineInvoiceId}`, { amountCents: 100 });
check('a typed total cannot overwrite a line-built invoice', typedTotal.status === 400, typedTotal.body);

const extraLine = await call('POST', `/api/billing/invoices/${lineInvoiceId}/items`, {
  description: 'Extra handset',
  unitAmountCents: 2500,
});
check(
  'adding a line raises the total by that line',
  extraLine.status === 200 && extraLine.body.invoice?.amountCents === 8450,
  extraLine.body.invoice?.amountCents
);

const dropLine = await call('DELETE', `/api/billing/invoice-items/${extraLine.body.item?.id}`);
check(
  'removing a line brings the total back',
  dropLine.status === 200 && dropLine.body.invoice?.amountCents === 5950,
  dropLine.body.invoice?.amountCents
);

const lineDetail = await call('GET', `/api/billing/invoices/${lineInvoiceId}`);
check(
  'the invoice detail carries the lines behind its total',
  lineDetail.status === 200 && (lineDetail.body.invoice?.items || []).length === 3,
  lineDetail.body.invoice?.items?.map((item) => item.kind)
);

const rentOverview = await call('GET', '/api/billing/rent');
check(
  'rent reports the month, its label and what is not yet billed',
  rentOverview.status === 200 &&
    /^\d{4}-\d{2}$/.test(rentOverview.body.period) &&
    /\d{4}/.test(rentOverview.body.label || '') &&
    typeof rentOverview.body.uninvoiced?.lines === 'number',
  rentOverview.body
);

// One bill per subscriber per month: the plan fee and the number rent are lines
// on the same invoice, so a customer is never sent a rent-only statement.
const rentForAccount = await call('POST', '/api/billing/invoices', {
  account: subscriberEmail,
  periodStart: today,
  periodEnd: today,
  rentPeriod: rentOverview.body.period,
});
const duplicateRent = await call('POST', '/api/billing/invoices', {
  account: subscriberEmail,
  periodStart: today,
  periodEnd: today,
  rentPeriod: rentOverview.body.period,
});
check(
  'one invoice per account per rent month',
  rentForAccount.status === 201 && duplicateRent.status === 409,
  { first: rentForAccount.status, second: duplicateRent.status, body: duplicateRent.body }
);
check(
  'an invoice created for a rent month is linked to the account it bills',
  rentForAccount.body.invoice?.accountId &&
    rentForAccount.body.invoice?.rentPeriod === rentOverview.body.period &&
    rentForAccount.body.invoice?.email === subscriberEmail,
  rentForAccount.body.invoice
);

// The subscriber's plan was comped, so nothing collected its fee and the plan
// fee is payable on the same bill as the rent.
const monthPlanLine = (rentForAccount.body.invoice?.items || []).find((item) => item.kind === 'plan');
check(
  'a month invoice carries the plan next to the rent',
  monthPlanLine?.settledBy === 'invoice' &&
    /Plan/.test(monthPlanLine?.description || '') &&
    rentForAccount.body.plan?.added === 1,
  { line: monthPlanLine, plan: rentForAccount.body.plan }
);

const rentOnto = await call('POST', `/api/billing/invoices/${rentForAccount.body.invoice?.id}/rent`, {
  period: rentOverview.body.period,
});
check(
  'pulling rent onto an invoice with no rented lines adds none',
  rentOnto.status === 200 && rentOnto.body.billed?.added === 0 && rentOnto.body.billed?.cents === 0,
  rentOnto.body
);

// A second run for the same account and month must not add a line or a bill.
const rentRun = await call('POST', '/api/billing/rent/run', {
  account: subscriberEmail,
  period: rentOverview.body.period,
});
check(
  'a monthly run for an account already billed adds nothing',
  rentRun.status === 200 &&
    rentRun.body.billedLines === 0 &&
    rentRun.body.planLines === 0 &&
    rentRun.body.invoices.length === 0,
  rentRun.body
);

/* ------------------------------------------- the first-login confirmation -- */
// A paying customer's number must not appear in a worldwide directory because a
// form defaulted to yes — and must not be missing because nobody asked.
console.log('\nThe first-login confirmation');

const listedNumber = await call('POST', '/api/numbers', { number: '+1 415 555 0196', lineType: 'voip' });
const ownedNumber = await call('PATCH', `/api/numbers/${listedNumber.body.number?.id}`, {
  account: subscriberEmail,
  visibility: 'private',
});
check(
  'a customer can be given a number',
  ownedNumber.status === 200 && ownedNumber.body.number?.e164 === '+14155550196',
  ownedNumber.body.number?.e164
);

const asCustomer = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie: subscriberCookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const freshPortal = await asCustomer('GET', '/api/me');
check(
  'the portal reads back the details the first login confirmed, and no guessed directory answer',
  freshPortal.status === 200 &&
    freshPortal.body.profile?.confirmed === true &&
    freshPortal.body.profile?.directoryOptIn === false,
  freshPortal.body.profile
);

const guessingDirectory = await asCustomer('POST', '/api/me/profile', { name: 'Smoke Subscriber' });
check(
  'the confirmation refuses to guess the directory answer',
  guessingDirectory.status === 400 && /directory/i.test(guessingDirectory.body.error?.message || ''),
  guessingDirectory.body
);

const optedOut = await asCustomer('POST', '/api/me/profile', {
  name: 'Smoke Subscriber',
  company: 'Smoke Subscriber Co',
  address: '120 Harbor Way',
  city: 'Austin',
  country: 'us',
  website: 'smoke.example',
  kind: 'business',
  directoryOptIn: false,
});
check(
  'confirming with an opt-out keeps the number out of the directory',
  optedOut.status === 200 &&
    optedOut.body.profile?.confirmed === true &&
    optedOut.body.profile?.directoryOptIn === false &&
    (optedOut.body.profile?.numbers || []).every((number) => number.visibility === 'private' && !number.listed),
  optedOut.body
);
const hiddenLookup = await call('GET', `/api/public/lookup?number=${encode('+14155550196')}`, undefined, {
  noCookie: true,
  bearer: '',
});
check('an opted-out number is not in the public directory', hiddenLookup.body.found === false, hiddenLookup.body);

const optedIn = await asCustomer('POST', '/api/me/profile', {
  name: 'Smoke Subscriber',
  company: 'Smoke Subscriber Co',
  address: '120 Harbor Way',
  city: 'Austin',
  country: 'US',
  website: 'smoke.example',
  kind: 'business',
  directoryOptIn: true,
});
check(
  'opting in publishes the number and writes the listing',
  optedIn.status === 200 &&
    optedIn.body.applied?.listed >= 1 &&
    (optedIn.body.profile?.numbers || []).some((number) => number.listed && number.visibility === 'public'),
  optedIn.body
);
const publishedLookup = await call('GET', `/api/public/lookup?number=${encode('+14155550196')}`, undefined, {
  noCookie: true,
  bearer: '',
});
check(
  'the directory finds it under the name the customer gave',
  publishedLookup.body.found === true &&
    (publishedLookup.body.entry?.listings || []).some((entry) => entry.name === 'Smoke Subscriber Co'),
  publishedLookup.body.entry
);

const withdrawn = await asCustomer('POST', '/api/me/profile', {
  name: 'Smoke Subscriber',
  company: 'Smoke Subscriber Co',
  directoryOptIn: false,
});
const withdrawnLookup = await call('GET', `/api/public/lookup?number=${encode('+14155550196')}`, undefined, {
  noCookie: true,
  bearer: '',
});
check(
  'opting out again withdraws the listing and hides the number',
  withdrawn.status === 200 &&
    withdrawn.body.profile?.directoryOptIn === false &&
    withdrawnLookup.body.found === false,
  { profile: withdrawn.body.profile, lookup: withdrawnLookup.body.found }
);

/* ------------------------------------------------------------------ SCIF -- */
// SCIF is a promise the switch keeps, not a badge in the UI: the line withholds
// its caller ID, never records, and the app masks what it shows.
console.log('\nSCIF — the secure line profile');

const scifLine = await call('PATCH', `/api/extensions/${assignedLine.body.extension?.id}`, {
  number: '+14155550196',
});
const scifAgent = await call('POST', '/api/voice/agents', {
  name: `SCIF Recording ${Date.now()}`,
  greeting: 'SCIF recording policy test.',
  number: '+14155550196',
  status: 'active',
  recordInbound: true,
});
const blockFor = (content, digits) => {
  const match = new RegExp(`exten => ${digits},1([\\s\\S]*?)(?=\\nexten|\\n\\[)`).exec(content);
  return match ? match[0] : '';
};
const preScif = await call('GET', '/api/system/config-preview?file=extensions.conf');
check(
  'the agent would record this line before SCIF is armed',
  scifLine.status === 200 &&
    scifAgent.status === 201 &&
    /MixMonitor\(/.test(blockFor(preScif.body.content || '', '14155550196')),
  blockFor(preScif.body.content || '', '14155550196')
);

const scifSave = await asCustomer('POST', '/api/softphone/scif', {
  extension: '296',
  scif: true,
  callerIdMode: 'anonymous',
  voiceMask: 'low',
  maskText: true,
});
check(
  'SCIF arms the line with a withheld caller ID, a mask and no recording',
  scifSave.status === 200 &&
    scifSave.body.scif?.enabled === true &&
    scifSave.body.scif?.callerId?.presentation === 'prohibited' &&
    scifSave.body.scif?.voiceMask === 'low' &&
    scifSave.body.scif?.maskText === true &&
    scifSave.body.scif?.recording === 'off',
  scifSave.body
);

const postScif = await call('GET', '/api/system/config-preview?file=extensions.conf');
check(
  'the switch stops recording a SCIF line, whatever the agent asks for',
  !/MixMonitor\(/.test(blockFor(postScif.body.content || '', '14155550196')) &&
    /SCIF lines never record: 296/.test(postScif.body.content || ''),
  blockFor(postScif.body.content || '', '14155550196')
);
const scifPjsip = await call('GET', '/api/system/config-preview?file=pjsip.conf');
check(
  'the endpoints present an anonymous caller ID',
  (scifPjsip.body.content || '').split('callerid="Anonymous" <anonymous>').length - 1 >= 2,
  (scifPjsip.body.content || '')
    .split('\n')
    .filter((line) => line.startsWith('callerid='))
    .slice(0, 4)
);

const badMask = await asCustomer('POST', '/api/softphone/scif', { extension: '296', voiceMask: 'helium' });
check('an unknown voice mask is refused', badMask.status === 400, badMask.body);

const customWithoutNumber = await asCustomer('POST', '/api/softphone/scif', {
  extension: '296',
  callerIdMode: 'custom',
});
check('presenting another number needs that number', customWithoutNumber.status === 400, customWithoutNumber.body);

const foreignScif = await asCustomer('POST', '/api/softphone/scif', { extension: '101', scif: true });
check(
  'a customer cannot arm a line that is not theirs',
  foreignScif.status === 403 || foreignScif.status === 404,
  foreignScif.status
);

const scifSession = await asCustomer('POST', '/api/softphone/session', { extension: '296' });
check(
  'the session tells the browser to require encryption',
  scifSession.status === 201 &&
    scifSession.body.scif?.requiresEncryption === true &&
    scifSession.body.scif?.recording === 'off',
  scifSession.body.scif
);

// Masking: the line asked for redaction, so identifiers do not leave the API.
await call('POST', '/api/messages', {
  to: '+14155550196',
  channel: 'sms',
  body: 'Call +1 415 555 0177 or write sam@example.com',
});
const scifMessages = await call('GET', '/api/messages?channel=sms');
const maskedRow = (scifMessages.body.items || [])[0];
check(
  'a masked line redacts numbers and addresses in its messages',
  maskedRow?.masked === true &&
    !/415 555 0177/.test(maskedRow.body || '') &&
    !/sam@example\.com/.test(maskedRow.body || ''),
  maskedRow
);

/* ------------------------------------------------------------------ voice -- */
// Voice on the line: a voiceprint computed by the platform, and the gate a
// softphone session has to spend a passed check on. The audio here is synthetic
// — two formant patterns, one "person" each — so the check is repeatable and no
// microphone is involved.

console.log('\nVoice: voiceprint and the session gate');

const voiceWav = ({ f0, formants, seed = 1, seconds = 1.6 }) => {
  const rate = 16000;
  const length = Math.floor(rate * seconds);
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(length * 2, 40);

  let state = seed;
  const random = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const offsets = Array.from({ length: 40 }, () => random() * Math.PI * 2);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    const frequency = f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t));
    phase += (2 * Math.PI * frequency) / rate;
    let value = 0;
    for (let h = 1; h <= 12; h += 1) {
      const harmonic = frequency * h;
      if (harmonic > 7500) break;
      let amp = 0.05 / h;
      for (const formant of formants) amp += Math.exp(-((harmonic - formant) ** 2) / (2 * 180 ** 2));
      value += amp * Math.sin(h * phase + offsets[h - 1]);
    }
    const envelope = Math.min(1, t / 0.1, (seconds - t) / 0.15);
    const sample = 0.35 * envelope * value + (random() - 0.5) * 0.01;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), 44 + i * 2);
  }
  return buffer.toString('base64');
};

const ownerTake = (seed) => voiceWav({ f0: 196, formants: [760, 1400, 2700], seed });
const otherTake = (seed) => voiceWav({ f0: 112, formants: [520, 960, 2400], seed });

const voiceBefore = await asCustomer('GET', '/api/voice/status?extension=296');
check(
  'a line starts with no voiceprint and no gate',
  voiceBefore.status === 200 &&
    voiceBefore.body.voiceprint?.enrolled === false &&
    voiceBefore.body.gate?.required === false &&
    voiceBefore.body.available === true,
  voiceBefore.body
);

const junkEnroll = await asCustomer('POST', '/api/voice/enroll', {
  extension: '296',
  phrase: 'my voice unlocks this line',
  samples: ['not even base64!!'],
});
check('junk audio is refused at enrollment', junkEnroll.status === 400, junkEnroll.body);

const enrolledVoice = await asCustomer('POST', '/api/voice/enroll', {
  extension: '296',
  phrase: 'my voice unlocks this line',
  samples: [ownerTake(7), ownerTake(99)],
});
check(
  'two takes enroll a voiceprint on the line',
  enrolledVoice.status === 200 &&
    enrolledVoice.body.voiceprint?.samples === 2 &&
    enrolledVoice.body.voiceprint?.consistency > 0.75,
  enrolledVoice.body.voiceprint
);

const voiceAfter = await asCustomer('GET', '/api/voice/status?extension=296');
check(
  'the status reports the print without handing back the vector',
  voiceAfter.status === 200 &&
    voiceAfter.body.voiceprint?.enrolled === true &&
    voiceAfter.body.voiceprint?.embedding === undefined &&
    voiceAfter.body.sample?.minSeconds >= 1,
  voiceAfter.body.voiceprint
);

const impostor = await asCustomer('POST', '/api/voice/verify', {
  extension: '296',
  audio: otherTake(3),
  heard: 'my voice unlocks this line',
});
check(
  'another voice does not pass, and gets no ticket',
  impostor.status === 200 &&
    impostor.body.ok === false &&
    impostor.body.score < impostor.body.threshold &&
    !impostor.body.ticket,
  impostor.body
);

const ownerCheck = await asCustomer('POST', '/api/voice/verify', {
  extension: '296',
  audio: ownerTake(51),
  heard: 'my voice unlocks this line',
});
check(
  'the owner passes and is given one ticket',
  ownerCheck.status === 200 && ownerCheck.body.ok === true && !!ownerCheck.body.ticket,
  ownerCheck.body
);

const required = await asCustomer('POST', '/api/voice/require', { extension: '296', enabled: true });
check(
  'the line can require a check once it has a print',
  required.status === 200 && required.body.gate?.required === true && required.body.gate?.enforced === true,
  required.body
);

const blockedSession = await asCustomer('POST', '/api/softphone/session', { extension: '296' });
check(
  'a session without a passed check is refused, with a reason the app can act on',
  blockedSession.status === 403 && blockedSession.body.error?.code === 'voice_required',
  blockedSession.body
);

const ticketedSession = await asCustomer('POST', '/api/softphone/session', {
  extension: '296',
  voiceTicket: ownerCheck.body.ticket,
});
check('the ticket opens the line', ticketedSession.status === 201, ticketedSession.body.error);

const replaySession = await asCustomer('POST', '/api/softphone/session', {
  extension: '296',
  voiceTicket: ownerCheck.body.ticket,
});
check('the same ticket cannot be spent twice', replaySession.status === 403, replaySession.body);

const foreignVoice = await asCustomer('GET', '/api/voice/status?extension=101');
check('a customer cannot read another line\'s voice settings', foreignVoice.status === 403 || foreignVoice.status === 404, foreignVoice.status);

const opened = await asCustomer('POST', '/api/voice/require', { extension: '296', enabled: false });
check('the gate can be switched off again', opened.status === 200 && opened.body.gate?.required === false, opened.body);

/* ------------------------------------------------------------------- push -- */
// Ringing a locked iPhone. APNs is off in this environment, so what is proved
// here is the registration contract and that the platform says why it cannot
// ring instead of pretending it did.

console.log('\nPush: the native app registration');

const pushBefore = await asCustomer('GET', '/api/softphone/push?extension=296');
check(
  'push status is honest about being unconfigured',
  pushBefore.status === 200 &&
    pushBefore.body.status?.enabled === false &&
    pushBefore.body.devices?.length === 0,
  pushBefore.body.status
);

const voipToken = 'a'.repeat(32) + 'b'.repeat(32);
const registered = await asCustomer('POST', '/api/softphone/push/register', {
  extension: '296',
  token: voipToken,
  platform: 'ios',
  environment: 'development',
  deviceName: 'Smoke iPhone',
});
check(
  'a phone can register a push token against its line',
  registered.status === 200 &&
    registered.body.device?.extension === '296' &&
    registered.body.device?.token?.includes('…') &&
    !JSON.stringify(registered.body).includes(voipToken),
  registered.body.device
);

const registeredAgain = await asCustomer('POST', '/api/softphone/push/register', {
  extension: '296',
  token: voipToken,
  platform: 'ios',
});
const pushAfter = await asCustomer('GET', '/api/softphone/push?extension=296');
check(
  'registering the same phone twice leaves one device',
  registeredAgain.status === 200 && pushAfter.body.devices?.length === 1,
  pushAfter.body.devices
);

check(
  'the platform says where an unanswered call would park',
  pushAfter.body.status?.parking?.enabled === true &&
    pushAfter.body.status?.parking?.lot === 'telno' &&
    pushAfter.body.status?.parking?.start === 7001 &&
    pushAfter.body.status?.parking?.end === 7099 &&
    pushAfter.body.status?.parking?.timeoutSeconds > 0,
  pushAfter.body.status?.parking
);

const statusForParking = await asCustomer('GET', '/api/softphone/status');
check(
  'the softphone status carries the lot, so a console can say where a call waits',
  statusForParking.status === 200 &&
    statusForParking.body.push?.parking?.lot === 'telno' &&
    statusForParking.body.push?.parking?.ringSeconds > 0,
  statusForParking.body.push
);

const ringUnconfigured = await asCustomer('POST', '/api/softphone/push/ring', { extension: '296' });
check(
  'a ring without APNs is a clear refusal, not a fake success',
  ringUnconfigured.status === 400 && /APNS_ENABLED|push/i.test(ringUnconfigured.body.error?.message || ''),
  ringUnconfigured.body
);

const foreignToken = await asCustomer('POST', '/api/softphone/push/register', {
  extension: '101',
  token: 'c'.repeat(64),
  platform: 'ios',
});
check(
  'a customer cannot register a phone on somebody else\'s line',
  foreignToken.status === 403 || foreignToken.status === 404,
  foreignToken.status
);

const removed = await asCustomer('POST', '/api/softphone/push/remove', { token: voipToken });
check('a phone can be unregistered', removed.status === 200 && removed.body.removed === true, removed.body);

/* -------------------------------------------------------------- first run -- */
// The setup contract. This instance already has lines, so what is proved here is
// the shape and the refusals; the empty-install path is exercised by the unit
// script that starts from a fresh database.

console.log('\nFirst run: the setup contract');

const setupNow = await call('GET', '/api/setup');
check(
  'setup answers with the three steps and stops asking once a line exists',
  setupNow.status === 200 &&
    setupNow.body.needed === false &&
    Array.isArray(setupNow.body.steps) &&
    ['line', 'number', 'register'].every((id) => setupNow.body.steps.some((step) => step.id === id)) &&
    setupNow.body.steps.find((step) => step.id === 'line')?.done === true,
  setupNow.body
);

const freeExtension = setupNow.body.suggested?.extension || '';
const allExtensions = (await call('GET', '/api/extensions')).body.items || [];
check(
  'it offers an extension that is actually free',
  /^\d{2,6}$/.test(freeExtension) && !allExtensions.some((row) => row.extension === freeExtension),
  { freeExtension }
);
check(
  'and it says whether the softphone can register and whether a carrier exists',
  typeof setupNow.body.softphone?.enabled === 'boolean' &&
    typeof setupNow.body.softphone?.tls === 'boolean' &&
    typeof setupNow.body.carrier?.voipms === 'boolean',
  setupNow.body.softphone
);

const setupLine = await call('POST', '/api/setup/line', {
  displayName: 'Setup smoke',
  extension: freeExtension,
});
check(
  'setup creates a line and shows its secret once',
  setupLine.status === 201 &&
    setupLine.body.extension?.extension === freeExtension &&
    typeof setupLine.body.extension?.secret === 'string' &&
    setupLine.body.extension.secret.length >= 8,
  setupLine.body
);
check(
  'the new line is on the switch the moment it is created',
  ((await call('GET', '/api/extensions')).body.items || []).some((row) => row.extension === freeExtension),
  freeExtension
);

const setupTwice = await call('POST', '/api/setup/line', { displayName: 'Again', extension: freeExtension });
check('the same extension cannot be created twice', setupTwice.status === 409, setupTwice.status);

const setupNumber = await call('POST', '/api/setup/number', { extension: freeExtension, number: '+14155550188' });
check(
  'a number can be attached to that line from setup',
  setupNumber.status === 200 && setupNumber.body.extension?.number?.e164 === '+14155550188',
  setupNumber.body
);

const setupFromCustomer = await asCustomer('POST', '/api/setup/line', { displayName: 'Nope', extension: '555' });
check(
  'a customer cannot set up the platform',
  setupFromCustomer.status === 403 || setupFromCustomer.status === 404,
  setupFromCustomer.status
);

const setupDrop = await call('DELETE', `/api/extensions/${setupLine.body.extension.id}`);
check('the setup line can be removed again', setupDrop.status === 200, setupDrop.body);

/* ------------------------------------------------------------------- brand -- */
// White-label configuration: the name, vendor and accent every public page and
// the console render. It is a settings row, so an edit is live immediately.

console.log('\nWhite-label branding');

const brandDefaults = await call('GET', '/api/public/brand', undefined, { noCookie: true, bearer: '' });
check(
  'the public brand is served without a session',
  brandDefaults.status === 200 && brandDefaults.body.brand?.name && brandDefaults.body.brand?.vendor,
  brandDefaults.body.brand
);
const originalBrand = brandDefaults.body.brand;

const renamed = await call('PUT', '/api/system/brand', {
  name: 'Smoke Telco',
  vendor: 'Smoke Holdings',
  accent: '#12a594',
});
check(
  'an owner can rebrand the deployment',
  renamed.status === 200 && renamed.body.brand?.name === 'Smoke Telco' && renamed.body.brand?.accent === '#12a594',
  renamed.body.brand
);
const publicAfterRename = await call('GET', '/api/public/brand', undefined, { noCookie: true, bearer: '' });
check(
  'the new brand is what the public page reads',
  publicAfterRename.body.brand?.name === 'Smoke Telco' && publicAfterRename.body.brand?.vendor === 'Smoke Holdings',
  publicAfterRename.body.brand
);
const pricingAfterRename = await call('GET', '/api/public/plans', undefined, { noCookie: true, bearer: '' });
check(
  'the pricing page and the site carry the same brand',
  pricingAfterRename.body.brand?.name === 'Smoke Telco' && pricingAfterRename.body.product === 'Smoke Telco',
  { product: pricingAfterRename.body.product, brand: pricingAfterRename.body.brand?.name }
);
check(
  'an accent that is not a hex color is refused, because it becomes CSS',
  (await call('PUT', '/api/system/brand', { accent: 'red' })).status === 400
);
check(
  'a logo that is not an http(s) URL is refused',
  (await call('PUT', '/api/system/brand', { logoUrl: 'javascript:alert(1)' })).status === 400
);

const brandRestored = await call('PUT', '/api/system/brand', {
  name: originalBrand.name,
  vendor: originalBrand.vendor,
  tagline: originalBrand.tagline,
  description: originalBrand.description,
  accent: originalBrand.accent,
  logoUrl: originalBrand.logoUrl,
  supportEmail: originalBrand.supportEmail,
  salesEmail: originalBrand.salesEmail,
  domain: originalBrand.domain,
  footerNote: originalBrand.footerNote,
});
check(
  'the original brand can be restored',
  brandRestored.status === 200 && brandRestored.body.brand?.name === originalBrand.name,
  brandRestored.body.brand?.name
);

/* ---------------------------------------------------------------------------
 * Fax on the switch, desk-phone provisioning, recipes, connected systems and
 * the internal secure channel. These are the surfaces that were rebuilt: a fax
 * that used to be a table, a handset that used to get a config for a port that
 * was closed, a workflow editor that used to demand its own syntax.
 * ------------------------------------------------------------------------- */

console.log('\nFax on the switch');
const faxEngine = await call('GET', '/api/fax/engine');
check('the fax engine reports what it can do', faxEngine.status === 200 && !!faxEngine.body.engine?.transport, faxEngine.body);
check(
  'and says plainly whether the switch has the fax modules',
  typeof faxEngine.body.engine?.modules?.resFax === 'boolean' && typeof faxEngine.body.engine?.ready === 'boolean',
  faxEngine.body.engine
);

const faxQueued = await call('POST', '/api/faxes', { to: '+442079460123', subject: 'Smoke fax', body: 'smoke page' });
check('an outbound fax can be queued', faxQueued.status === 201 && faxQueued.body.fax.status === 'queued', faxQueued.body);
const faxAttempt = await call('POST', `/api/faxes/${faxQueued.body.fax?.id}/send`, {});
// Without a live switch or a rasteriser this must refuse with a reason, not
// pretend the page was sent.
check(
  'sending without a switch or encoder fails with a reason, not a fake success',
  [422, 503].includes(faxAttempt.status) && /switch|ghostscript|trunk|fax/i.test(faxAttempt.body.error?.message || ''),
  faxAttempt.body
);
const faxAfterAttempt = await call('GET', '/api/faxes?direction=outbound');
const attempted = (faxAfterAttempt.body.items || []).find((item) => item.id === faxQueued.body.fax?.id);
check('and the attempt is recorded rather than lost', !!attempted && !!attempted.error, attempted);

const faxNumber = await call('POST', '/api/numbers', { number: '+14155550777', faxMode: 'fax' });
const faxModeSet = await call('PATCH', `/api/numbers/${faxNumber.body.number?.id}`, { faxMode: 'fax' });
check(
  'a number can answer as a fax machine',
  faxModeSet.status === 200 && faxModeSet.body.number.faxMode === 'fax',
  faxModeSet.body
);
const faxModeBack = await call('PATCH', `/api/numbers/${faxNumber.body.number?.id}`, { faxMode: 'voice' });
check('and go back to voice', faxModeBack.body.number?.faxMode === 'voice', faxModeBack.body);

console.log('\nDesk-phone provisioning at telno.tel');
const provisionIndex = await call('GET', '/provision', undefined, { noCookie: true, bearer: '' });
check(
  'the provisioning index is public and names the server',
  provisionIndex.status === 200 && String(provisionIndex.body.raw || '').includes('telno.tel'),
  provisionIndex.body
);
const sparePhone = await call('POST', '/api/estate/devices', { name: 'Smoke desk phone', kind: 'handset', mac: 'AABBCCDDEE11' });
check('a handset is in the inventory', sparePhone.status === 201, sparePhone.body);
// A handset with no line is a doorstop: give it the first extension on the
// switch so the config it fetches actually carries a SIP account.
const handsetLine = (await call('GET', '/api/extensions')).body.items?.[0]?.extension;
if (handsetLine) {
  await call('PATCH', `/api/estate/devices/${sparePhone.body.device?.id}`, { extension: String(handsetLine) });
}
const cfgResponse = await fetch(`${base}/provision/yealink/aabbccddee11.cfg`);
const cfgText = await cfgResponse.text();
check(
  'a handset fetches its own config by MAC, with no session',
  cfgResponse.status === 200 && cfgText.includes('Telno provisioning') && cfgText.includes('device.checkin.token'),
  { status: cfgResponse.status, head: cfgText.slice(0, 120) }
);
if (handsetLine) {
  check(
    'and it registers as sip:<extension>@telno.tel on the port the switch listens on',
    cfgText.includes('account.1.user_name') &&
      cfgText.includes('telno.tel') &&
      cfgText.includes('sip_server.1.port = 5060'),
    cfgText.slice(0, 400)
  );
}
const unknownMac = await fetch(`${base}/provision/yealink/001122334455.cfg`);
check('a MAC that is not in the inventory gets 404, so extensions cannot be enumerated', unknownMac.status === 404, {
  status: unknownMac.status,
});

console.log('\nRecipes instead of syntax');
const catalog = await call('GET', '/api/presets');
check('the console can offer recipes', catalog.status === 200 && catalog.body.workflows?.length > 0, catalog.body.workflows?.length);
check('every recipe is a complete, runnable flow', (catalog.body.workflows || []).every((recipe) => recipe.steps.length > 0 && recipe.trigger), catalog.body.workflows);
check('each step type has a human label', (catalog.body.stepTypes || []).every((entry) => entry.label && entry.type));
check('voice agents have presets too', (catalog.body.agents || []).every((preset) => preset.greeting && preset.prompt));
const recipe = catalog.body.workflows[0];
const fromRecipe = await call('POST', '/api/workflows', { name: `Smoke ${Date.now()}`, trigger: recipe.trigger, steps: recipe.steps });
check('a recipe creates a real workflow', fromRecipe.status === 201 && fromRecipe.body.workflow.steps.length === recipe.steps.length, fromRecipe.body);

console.log('\nConnected systems');
const systemList = await call('GET', '/api/systems?probe=0');
const interview = (systemList.body.items || []).find((item) => /interview/i.test(item.name));
check('the interview dashboard is linked', !!interview && /interviews/i.test(interview.path), interview);
check('and every linked system is enabled by default', (systemList.body.items || []).every((item) => item.enabled), systemList.body.items?.map((i) => [i.name, i.enabled]));

console.log('\nInternal secure messaging');
const secureRecipients = await call('GET', '/api/secure-messages/recipients');
check('there is somebody to message', secureRecipients.status === 200 && Array.isArray(secureRecipients.body.items), secureRecipients.body);
const secureTo = secureRecipients.body.items?.[0]?.value;
const secureSent = await call('POST', '/api/secure-messages', { to: secureTo, body: 'sealed smoke message' });
check('a secure message is delivered in-app', secureSent.status === 201 && secureSent.body.delivered === true, secureSent.body);
const secureList = await call('GET', '/api/secure-messages');
const sealed = (secureList.body.items || []).filter((item) => item.body === 'sealed smoke message');
// The sender sees their own copy; the recipient's copy is a second row scoped
// to them, so it must not appear in the sender's list.
check('the sent copy is in the sender\'s thread', sealed.length === 1, sealed.length);
check('and reads back through the seal', sealed[0]?.body === 'sealed smoke message' && !!sealed[0]?.threadId, sealed[0]);
check('the channel costs nothing per message', /\$0\.00/.test(secureList.body.summary?.cost || ''), secureList.body.summary);

const faxSecret = await call('GET', '/api/faxes');
check('the fax list is still readable after all of it', faxSecret.status === 200, faxSecret.status);

globalThis.__smokeStopServer?.();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
console.log('All checks passed.\n');
