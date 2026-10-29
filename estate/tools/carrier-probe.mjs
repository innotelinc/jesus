/**
 * A diagnostic for the carrier's sub-account, run inside the console container.
 *
 *   node carrier-probe.mjs show                    # the record, secrets omitted
 *   node carrier-probe.mjs write k=v [k=v ...]     # minimal write, then the diff
 *
 * The point is the diff: `setSubAccount` is not a patch, and whether the fields
 * you leave out keep their values or fall back to defaults is the one thing that
 * decides whether echoing the whole record back is safe.
 */

const BASE = process.env.VOIPMS_API_URL || 'https://voip.ms/api/v1/rest.php';
const SECRET = new Set(['password']);

function url(method, params = {}) {
  const u = new URL(BASE);
  u.searchParams.set('api_username', process.env.VOIPMS_API_USERNAME);
  u.searchParams.set('api_password', process.env.VOIPMS_API_PASSWORD);
  u.searchParams.set('method', method);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    u.searchParams.set(key, String(value));
  }
  return u;
}

async function record() {
  const body = await (await fetch(url('getSubAccounts'), { signal: AbortSignal.timeout(20000) })).json();
  if (body.status !== 'success') throw new Error(`getSubAccounts: ${body.status}`);
  const wanted = (process.env.VOIPMS_SUB_ACCOUNT || '').replace(/^\d+_/, '');
  const found = (body.accounts || []).find((entry) => entry.username === wanted || entry.account === process.env.VOIPMS_SUB_ACCOUNT);
  if (!found) throw new Error(`no sub-account ${process.env.VOIPMS_SUB_ACCOUNT}`);
  return found;
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'show') {
  const entry = await record();
  for (const key of Object.keys(entry).sort()) {
    console.log(key.padEnd(24), SECRET.has(key) ? '<redacted>' : JSON.stringify(entry[key]));
  }
} else if (command === 'write') {
  const before = await record();
  const params = { id: before.id };
  for (const pair of rest) {
    const [key, ...value] = pair.split('=');
    params[key] = value.join('=');
  }
  const started = Date.now();
  const text = await (await fetch(url('setSubAccount', params), { signal: AbortSignal.timeout(90000) })).text();
  console.log('write', JSON.stringify(params), 'ms', Date.now() - started, '->', text.slice(0, 200));
  const after = await record();
  const changed = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SECRET.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = [before[key], after[key]];
  }
  console.log('changed', Object.keys(changed).length, JSON.stringify(changed));
} else {
  console.log('usage: carrier-probe.mjs show | write key=value ...');
  process.exit(2);
}
