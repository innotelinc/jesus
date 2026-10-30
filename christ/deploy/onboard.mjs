#!/usr/bin/env node
/**
 * Finish telno's first-run gate from the terminal.
 *
 * The gate is deliberately not skippable — terms, a proved address and a proved
 * phone — so a box nobody is sitting at cannot make a call. This walks the same
 * endpoints the wizard does. The email and SMS codes come back in the response
 * because this install's notify channel is the console (`codes.email` on
 * GET /onboarding), which is what makes a headless demo possible at all.
 *
 *   node onboard.mjs <base-url> <email> <password> [phone]
 *
 * Prints the resulting onboarding state. Exit 1 on the first refusal, with the
 * platform's own message — a gate that half-passes is worse than one that stops.
 */

const [base, email, password, phone = '14134210134'] = process.argv.slice(2);
if (!base || !email || !password) {
  process.stderr.write('usage: onboard.mjs <base-url> <email> <password> [phone]\n');
  process.exit(2);
}

let token = '';
async function call(method, path, body) {
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw body for the error message */
  }
  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || String(parsed);
    throw new Error(`${method} ${path} → ${response.status}: ${message}`);
  }
  return parsed;
}

const session = await call('POST', '/api/auth/login', { email, password });
token = session.token;

const before = await call('GET', '/api/onboarding');
process.stdout.write(`gate: next=${before.next || 'done'} codes=${JSON.stringify(before.codes || {})}\n`);

let state = before;
if (state.next === 'terms') state = await call('POST', '/api/onboarding/terms', { accept: true });
if (state.next === 'profile') {
  state = await call('POST', '/api/onboarding/profile', {
    name: 'CHRIST front desk',
    company: 'CHRIST',
    address: '1 Demo Way',
    city: 'New York',
    country: 'US',
    directoryOptIn: false,
  });
}
if (state.next === 'email') {
  const sent = await call('POST', '/api/onboarding/email/code');
  // `devCode` is the console channel's own name for it — the same value the
  // wizard would read out of an inbox on a configured install.
  const code = sent.devCode || sent.code;
  if (!code) throw new Error('the email code was not exposed; this install cannot finish the gate headlessly');
  state = await call('POST', '/api/onboarding/email/verify', { code });
}
if (state.next === 'phone') {
  const sent = await call('POST', '/api/onboarding/phone/code', { phone });
  const code = sent.devCode || sent.code;
  if (!code) throw new Error('the SMS code was not exposed; this install cannot finish the gate headlessly');
  state = await call('POST', '/api/onboarding/phone/verify', { code });
}

const after = await call('GET', '/api/onboarding');
process.stdout.write(`gate: next=${after.next || 'done'} line=${after.line?.lines ?? '?'} numbers=${after.line?.numbers ?? '?'}\n`);

// The point of the exercise: a session the softphone will accept.
const status = await call('GET', '/api/softphone/status');
process.stdout.write(`softphone: ${JSON.stringify(status).slice(0, 300)}\n`);
const live = await call('POST', '/api/softphone/session', { extension: String(after.line?.extension || '101') });
process.stdout.write(
  `session: line ${live.extension || live.line?.extension || '101'} ticket=${live.ticket ? `yes(${String(live.ticket).length})` : 'no'} ws=${live.socketUrl || live.ws || '—'}\n`
);
