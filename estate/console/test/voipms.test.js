/**
 * The carrier half of the encryption switch.
 *
 * This is the part that cannot be exercised against the live API in a test, so
 * what is pinned down here is the two things that go wrong without a test: the
 * flag is read from whichever field the API answers with, and a change is sent
 * as the whole sub-account rather than as a one-field patch the carrier would
 * reject for missing required parameters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { matches, paramsFor, readEncryption, state } from '../voipms.js';

// The shape the live API answers with: `username` is the bare name, `account`
// the prefixed one, and `id` is what a write has to carry.
const subAccount = {
  id: '10236',
  username: 'telno',
  account: '235662_telno',
  description: 'Telno demo line',
  auth_type: '1',
  device_type: '1',
  allowed_codecs: 'ulaw',
  dtmf_mode: '1',
  nat: '1',
  lock_international: '1',
  international_route: '1',
  music_on_hold: '1',
  sip_traffic: '1',
  status: 'active',
};

test('the encryption flag is read from the field the API actually uses', () => {
  assert.equal(readEncryption({ sip_traffic: '1' }), true);
  assert.equal(readEncryption({ sip_traffic: '0' }), false);
  // Other spellings the read side has answered with over the years.
  assert.equal(readEncryption({ encrypted_sip_traffic: 'yes' }), true);
  assert.equal(readEncryption({ encryption: 'no' }), false);
  // Unknown is not "off": reporting off for an encrypted account would send an
  // operator looking for a fault that is not there.
  assert.equal(readEncryption({ nothing: 'here' }), null);
  assert.equal(readEncryption({ sip_traffic: 'maybe' }), null);
});

test('a sub-account is found by either name the API and the credentials use', () => {
  // Configured as the SIP credentials spell it, and as the portal spells it.
  assert.equal(matches(subAccount, '235662_telno'), true);
  assert.equal(matches(subAccount, 'telno'), true);
  assert.equal(matches(subAccount, '235662_TELNO'), true);
  assert.equal(matches(subAccount, '10236'), true, 'the record id identifies it too');
  assert.equal(matches(subAccount, 'ia x'), false);
  assert.equal(matches(subAccount, ''), false);
});

test('a change sends the whole sub-account, with the flag overridden', () => {
  const params = paramsFor(subAccount, true);
  assert.equal(params.sip_traffic, '1');
  assert.equal(params.id, '10236', 'the record the change applies to');
  assert.equal(params.allowed_codecs, 'ulaw', 'required fields travel with the change');
  assert.equal(params.dtmf_mode, '1');
  assert.equal(params.username, undefined, 'read-only fields are not sent back');
  assert.equal(params.status, undefined);
  assert.equal(params.account, '235662_telno', 'the prefixed name is not read-only');

  assert.equal(paramsFor(subAccount, false).sip_traffic, '0');
});

test('a record without API credentials says which variable is missing', async () => {
  delete process.env.VOIPMS_API_USERNAME;
  delete process.env.VOIPMS_API_PASSWORD;
  delete process.env.VOIPMS_SUB_ACCOUNT;
  // A fresh module instance, because configuration is read once at load.
  const mod = await import('../voipms.js?unconfigured');
  const answer = await mod.state();
  assert.equal(answer.configured, false);
  assert.equal(answer.encryption, null);
  assert.match(answer.error, /VOIPMS_API_USERNAME/);
});

test('a change reads the sub-account, writes one flag, and reads it back', async (t) => {
  // A real HTTP server speaking the carrier's envelope, because the thing worth
  // testing is the two-call round trip: read the record, send it back whole
  // with the flag changed, then report what the carrier says — not what we sent.
  let encryption = '0';
  const seen = [];
  const fake = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const method = url.searchParams.get('method');
    seen.push({ method, params: Object.fromEntries(url.searchParams) });
    response.setHeader('content-type', 'application/json');
    if (method === 'getSubAccounts') {
      response.end(JSON.stringify({ status: 'success', sub_accounts: [{ ...subAccount, sip_traffic: encryption }] }));
      return;
    }
    if (method === 'setSubAccount') {
      encryption = url.searchParams.get('sip_traffic');
      response.end(JSON.stringify({ status: 'success' }));
      return;
    }
    response.end(JSON.stringify({ status: 'invalid_method' }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => fake.close());

  process.env.VOIPMS_API_USERNAME = 'demo@example.com';
  process.env.VOIPMS_API_PASSWORD = 'api-password';
  process.env.VOIPMS_SUB_ACCOUNT = '235662_telno';
  process.env.VOIPMS_API_URL = `http://127.0.0.1:${fake.address().port}/rest.php`;
  const mod = await import('../voipms.js?roundtrip');

  assert.equal((await mod.state()).encryption, false);
  const { record: after, ms } = await mod.setEncryption(true);
  assert.equal(readEncryption(after), true, 'the answer is the carrier\'s record, not our request');
  assert.equal(typeof ms, 'number', 'how long the carrier took is reported, not guessed');

  const set = seen.find((call) => call.method === 'setSubAccount');
  assert.equal(set.params.sip_traffic, '1');
  assert.equal(set.params.id, '10236');
  assert.equal(set.params.allowed_codecs, 'ulaw');
  assert.equal(set.params.username, undefined);
});

test('a write gets the write budget, not the read one', async (t) => {
  // The carrier takes seconds to apply a sub-account change. A read-sized
  // deadline reports a timeout for a change that actually landed, so the two
  // halves are left disagreeing and nothing says so.
  let encryption = '1';
  const fake = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const method = url.searchParams.get('method');
    const reply = () => {
      response.setHeader('content-type', 'application/json');
      if (method === 'getSubAccounts') {
        response.end(JSON.stringify({ status: 'success', accounts: [{ ...subAccount, sip_traffic: encryption }] }));
        return;
      }
      encryption = url.searchParams.get('sip_traffic');
      response.end(JSON.stringify({ status: 'success' }));
    };
    // Reads answer at once; the write sits there for longer than a read may.
    if (method === 'setSubAccount') setTimeout(reply, 400);
    else reply();
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => fake.close());

  process.env.VOIPMS_API_USERNAME = 'demo@example.com';
  process.env.VOIPMS_API_PASSWORD = 'api-password';
  process.env.VOIPMS_SUB_ACCOUNT = '235662_telno';
  process.env.VOIPMS_API_URL = `http://127.0.0.1:${fake.address().port}/rest.php`;
  process.env.VOIPMS_READ_TIMEOUT_MS = '150';
  process.env.VOIPMS_WRITE_TIMEOUT_MS = '5000';
  const mod = await import('../voipms.js?slowwrite');

  const { record: after } = await mod.setEncryption(false);
  assert.equal(readEncryption(after), false, 'the slow write landed and was read back');
});

test('state() reports a failure instead of throwing at the console', async () => {
  // Configured but pointing at a URL that cannot answer: the console must still
  // render a card, with the carrier's reason in it.
  process.env.VOIPMS_API_USERNAME = 'demo@example.com';
  process.env.VOIPMS_API_PASSWORD = 'api-password';
  process.env.VOIPMS_SUB_ACCOUNT = '235662_telno';
  process.env.VOIPMS_API_URL = 'http://127.0.0.1:1/rest.php';
  const mod = await import('../voipms.js?unreachable');
  assert.equal(mod.configured(), true);
  const answer = await mod.state();
  assert.equal(answer.configured, true);
  assert.equal(answer.encryption, null);
  assert.ok(answer.error.length > 0, 'the reason is carried, not swallowed');
});
