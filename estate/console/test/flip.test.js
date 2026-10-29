/**
 * The half-applied switch: what happens when the carrier says yes and the
 * gateway says no.
 *
 * This is the failure that would be silent otherwise — the sub-account demands
 * encryption, the gateway stops offering it, and every call is refused with 488
 * until somebody reads the card. The tests here pin the ordering, the retry, and
 * the rollback that keeps the two halves agreeing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { flip } from '../flip.js';

/** A carrier that remembers what it was told, and how often. */
function fakeCarrier({ before = false, configured = true, failSet = false, failRollback = false, ms = 1200 } = {}) {
  const calls = [];
  let value = before;
  return {
    configured,
    calls,
    get value() {
      return value;
    },
    async set(enabled) {
      calls.push(enabled);
      const isRollback = calls.length > 1 && enabled === before;
      if (failSet && !isRollback) throw new Error('voip.ms setSubAccount: invalid_ip');
      if (failRollback && isRollback) throw new Error('voip.ms setSubAccount: internal_error');
      const previous = value;
      value = enabled;
      return { before: previous, ms };
    },
  };
}

function fakeGateway({ failures = 0 } = {}) {
  const attempts = [];
  return {
    attempts,
    async set(enabled) {
      attempts.push(enabled);
      if (attempts.length <= failures) throw new Error('The operation was aborted due to timeout');
    },
  };
}

test('a healthy flip moves the carrier first, then the gateway', async () => {
  const order = [];
  const carrier = fakeCarrier({ before: false });
  const gateway = fakeGateway();
  const carrierSet = carrier.set;
  carrier.set = async (enabled) => {
    order.push('carrier');
    return carrierSet(enabled);
  };
  const gatewaySet = gateway.set;
  gateway.set = async (enabled) => {
    order.push('gateway');
    return gatewaySet(enabled);
  };

  const result = await flip({ enabled: true, carrier, gateway });

  assert.deepEqual(order, ['carrier', 'gateway']);
  assert.equal(result.carrier.ok, true);
  assert.equal(result.carrier.ms, 1200, 'how long the carrier took is reported');
  assert.equal(result.gateway.ok, true);
  assert.equal(result.rolledBack, false);
});

test('a carrier that refuses leaves the gateway alone', async () => {
  const carrier = fakeCarrier({ configured: true, failSet: true });
  const gateway = fakeGateway();
  const result = await flip({ enabled: true, carrier, gateway });

  assert.equal(result.carrier.ok, false);
  assert.equal(result.gateway.skipped, true);
  assert.deepEqual(gateway.attempts, [], 'the gateway was never asked to move');
});

test('a carrier with no API credentials is a local test, not a stop', async () => {
  const carrier = fakeCarrier({ configured: false, failSet: true });
  const gateway = fakeGateway();
  const result = await flip({ enabled: true, carrier, gateway });

  assert.equal(result.carrier.ok, false);
  assert.equal(result.gateway.ok, true);
  assert.deepEqual(gateway.attempts, [true]);
});

test('a gateway that fails once is retried rather than rolled back', async () => {
  const carrier = fakeCarrier({ before: false });
  const gateway = fakeGateway({ failures: 1 });
  const result = await flip({ enabled: true, carrier, gateway });

  assert.equal(result.gateway.ok, true);
  assert.equal(result.gateway.attempts, 2);
  assert.equal(result.rolledBack, false);
  assert.deepEqual(carrier.calls, [true], 'the carrier was written once, not undone');
  assert.equal(carrier.value, true);
});

test('a gateway that will not move puts the carrier back', async () => {
  const carrier = fakeCarrier({ before: false });
  const gateway = fakeGateway({ failures: 99 });

  const result = await flip({ enabled: true, carrier, gateway });

  assert.equal(result.gateway.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.carrier.rolledBack, true);
  assert.equal(result.carrier.restored, false, 'back to what it held before the flip');
  assert.deepEqual(carrier.calls, [true, false], 'written, then written back');
  assert.equal(carrier.value, false, 'the two halves agree again');
});

test('turning encryption off is rolled back the same way', async () => {
  // The asymmetric case: the estate was encrypted, the operator switched it off,
  // and the gateway kept offering SAVP. Rolling back means turning it on again.
  const carrier = fakeCarrier({ before: true });
  const gateway = fakeGateway({ failures: 99 });

  const result = await flip({ enabled: false, carrier, gateway });

  assert.equal(result.rolledBack, true);
  assert.equal(carrier.value, true);
  assert.equal(result.carrier.restored, true);
});

test('a rollback that also fails says so instead of claiming agreement', async () => {
  const carrier = fakeCarrier({ before: false, failRollback: true });
  const gateway = fakeGateway({ failures: 99 });

  const result = await flip({ enabled: true, carrier, gateway });

  assert.equal(result.rolledBack, false);
  assert.equal(result.carrier.rolledBack, false);
  assert.match(result.carrier.error, /rollback to off failed/);
  assert.equal(carrier.value, true, 'the carrier is left where the failed flip put it');
});

test('a gateway failure after an unconfigured carrier has nothing to undo', async () => {
  const carrier = fakeCarrier({ configured: false, failSet: true });
  const gateway = fakeGateway({ failures: 99 });

  const result = await flip({ enabled: true, carrier, gateway });

  assert.equal(result.gateway.ok, false);
  assert.equal(result.rolledBack, false, 'no carrier change to reverse');
  assert.deepEqual(carrier.calls, [true], 'no rollback was attempted');
});
