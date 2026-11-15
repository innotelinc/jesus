/**
 * Identity profile conformance (§10.2, §14).
 *
 * The shipped signer is the `sig-hmac-sha256` test profile. The standard permits
 * it on loopback only, and says so with a MUST. A node that binds a public
 * address with the repository's default key is not a test profile, it is a
 * published signing key — so these tests pin the refusal, the escape hatch an
 * operator must state explicitly, and the fact that one endpoint's key cannot
 * vouch for another's message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Identity, isLoopbackHost, isTestSecret, TEST_SECRET } from '../src/identity.js';
import { CantusEndpoint } from '../src/endpoint.js';
import { CantusRelay } from '../src/relay.js';
import { TYPES, F, s, v } from '../src/wire.js';

const REAL_KEY = '6ff3300c7bd564181761d4c7ef23a32a6afdbb1a6f2363decbe9f376cb7971eb';

test('a wildcard or public bind is not loopback', () => {
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('10.0.0.5'), false);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost(''), false);
});

test('the published default key counts as no key', () => {
  assert.equal(isTestSecret(undefined), true);
  assert.equal(isTestSecret(''), true);
  assert.equal(isTestSecret(TEST_SECRET), true);
  assert.equal(isTestSecret(REAL_KEY), false);
});

test('the published default key is refused off loopback, even if asked', () => {
  for (const allowTestProfile of [false, true]) {
    assert.throws(
      () => new Identity({ name: 'switch@voice.innotel.us', secret: TEST_SECRET, loopback: false, allowTestProfile }),
      /published default key/,
      `allowTestProfile=${allowTestProfile} must not license a public key`
    );
  }
});

test('a node with no key refuses to listen publicly unless it says so', () => {
  assert.throws(
    () => new Identity({ name: 'switch@voice.innotel.us', loopback: false }),
    /test-profile secret/
  );
  const stated = new Identity({ name: 'switch@voice.innotel.us', loopback: false, allowTestProfile: true });
  assert.equal(stated.profile, 'sig-hmac-sha256');
});

test('loopback may always use the test profile', () => {
  const identity = new Identity({ name: 'switch@selftest', secret: TEST_SECRET, loopback: true });
  assert.equal(identity.publicKey.length, 32);
});

test('a real key on a public bind starts and reports its profile', () => {
  const identity = new Identity({ name: 'switch@voice.innotel.us', secret: REAL_KEY, loopback: false });
  assert.equal(identity.profile, 'sig-hmac-sha256');
  assert.equal(identity.shortKey.length, 16);
});

test('an endpoint inherits the guard from its bind address', () => {
  assert.throws(
    () => new CantusEndpoint({ id: 'switch@voice.innotel.us', bind: '0.0.0.0:7443' }),
    /published default key|test-profile secret/
  );
  const secure = new CantusEndpoint({ id: 'switch@voice.innotel.us', secret: REAL_KEY, bind: '0.0.0.0:7443' });
  assert.equal(secure.loopback, false);
  const loopback = new CantusEndpoint({ id: 'switch@selftest', bind: '127.0.0.1:7443' });
  assert.equal(loopback.loopback, true);
});

test('a relay inherits the guard from its bind address', async () => {
  // The relay builds its identity when it binds, because its name carries the
  // address it actually got; the refusal therefore arrives from start().
  const unsafe = new CantusRelay({ bind: '0.0.0.0:7444' });
  await assert.rejects(unsafe.start(), /published default key|test-profile secret/);
  unsafe.stop();
  const relay = new CantusRelay({ bind: '0.0.0.0:7444', secret: REAL_KEY });
  assert.equal(relay.loopback, false);
});

test('one endpoint cannot sign a message that verifies as another', () => {
  const caller = new CantusEndpoint({ id: 'caller@voice.innotel.us', secret: 'caller-key-0123456789abcdef0123', bind: '127.0.0.1:0' });
  const victim = new CantusEndpoint({ id: 'switch@voice.inotnel.us', secret: 'victim-key-0123456789abcdef0123', bind: '127.0.0.1:0' });

  const fields = { [F.from]: s('caller@voice.innotel.us'), [F.to]: s('101@voice.innotel.us'), [F.nonce]: v(1) };
  const forged = { ...fields, [F.sig]: { wt: 2, v: caller.identity.sign(TYPES.INVITE, fields) } };

  // The shared test-profile fallback is the deployment key, so a stranger's
  // signature over the same fields does not verify against the switch's key.
  assert.equal(victim.verifyMessage(TYPES.INVITE, forged), false);

  // Pinned per-peer keys make the claim itself irrelevant: the message is
  // checked against the key of the `from`, not the listener's own.
  victim.peerSecrets = { 'caller@voice.innotel.us': 'caller-key-0123456789abcdef0123' };
  assert.equal(victim.verifyMessage(TYPES.INVITE, forged), true);

  const wrongKey = { ...fields, [F.sig]: { wt: 2, v: victim.identity.sign(TYPES.INVITE, fields) } };
  assert.equal(victim.verifyMessage(TYPES.INVITE, wrongKey), false, 'a message signed with the wrong key must not pass as the pinned peer');
});

test('an unsigned signed-type message is dropped', () => {
  const endpoint = new CantusEndpoint({ id: 'switch@selftest', bind: '127.0.0.1:0' });
  const fields = { [F.from]: s('caller@selftest'), [F.to]: s('100@selftest'), [F.nonce]: v(1) };
  assert.equal(endpoint.verifyMessage(TYPES.INVITE, fields), false);
});
