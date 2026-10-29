/**
 * The softphone proxy's half of line liveness.
 *
 * The switch pings the upstream socket, and `ws` answers for this side, so a
 * proxy that outlives its browser keeps a line registered and a DID call rings
 * a phone nobody is holding. These tests pin the proxy's own judgement of the
 * browser: answer, or be taken down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BROWSER_DEAD_MS, BROWSER_PING_MS, watchBrowser } from '../src/telephony/wssRelay.js';

function browserSocket({ answers = true } = {}) {
  const handlers = new Map();
  const socket = {
    readyState: 1,
    pinged: 0,
    closed: false,
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    off: (event, handler) => {
      const list = handlers.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    emit: (event, ...args) => {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
    ping: () => {
      socket.pinged += 1;
      if (answers) socket.emit('pong');
    },
    close: () => {
      socket.closed = true;
    },
  };
  return socket;
}

test('the defaults give a browser two missed rounds before it is gone', () => {
  assert.equal(BROWSER_PING_MS, 10_000);
  assert.equal(BROWSER_DEAD_MS, 30_000);
  assert.ok(BROWSER_DEAD_MS >= BROWSER_PING_MS * 2, 'one lost ping must not drop a working phone');
});

test('a browser that answers pings is kept, however long the call runs', () => {
  const socket = browserSocket();
  let clock = 0;
  let died = 0;
  const watch = watchBrowser(socket, { now: () => clock, onDead: () => { died += 1; } });

  for (let round = 0; round < 30; round += 1) {
    clock += BROWSER_PING_MS;
    assert.equal(watch.check(), true, `alive at ${clock} ms`);
  }
  assert.equal(died, 0);
  assert.equal(socket.pinged, 30, 'one ping a round');
  watch.stop();
});

test('a browser that stops answering is dropped exactly once', () => {
  const socket = browserSocket({ answers: false });
  let clock = 0;
  let died = 0;
  const reasons = [];
  const watch = watchBrowser(socket, { now: () => clock, onDead: () => { died += 1; reasons.push('silent'); } });

  clock += BROWSER_PING_MS;
  assert.equal(watch.check(), true, 'one missed pong is not death');
  clock += BROWSER_PING_MS;
  assert.equal(watch.check(), true, 'two missed pongs is still within the deadline');
  clock += BROWSER_PING_MS + 1;
  assert.equal(watch.check(), false);
  assert.equal(died, 1, 'the caller closes both sockets once');

  // Nothing may fire again after the deadline: a second close would be a
  // second teardown of a call that is already gone.
  clock += BROWSER_PING_MS;
  watch.check();
  clock += BROWSER_PING_MS;
  watch.check();
  assert.equal(died, 1);
  assert.equal(socket.pinged, 2, 'the check that gives up does not ping, and nothing after it does');
});

test('any frame from the browser counts as proof of life', () => {
  const socket = browserSocket({ answers: false });
  let clock = 0;
  let died = 0;
  const watch = watchBrowser(socket, { now: () => clock, onDead: () => { died += 1; } });

  // A call carrying 20 ms frames: the pongs are irrelevant, the audio is proof.
  for (let frame = 0; frame < 10; frame += 1) {
    clock += 20;
    watch.touch();
  }
  clock += BROWSER_DEAD_MS - 1;
  assert.equal(watch.check(), true);
  assert.equal(died, 0);
  watch.stop();
});

test('a stopped watch never calls back', () => {
  const socket = browserSocket({ answers: false });
  let clock = 0;
  let died = 0;
  const watch = watchBrowser(socket, { now: () => clock, onDead: () => { died += 1; } });

  watch.stop();
  clock += BROWSER_DEAD_MS * 10;
  assert.equal(watch.check(), false);
  assert.equal(died, 0, 'closing the upstream already ends the line; nothing else may fire');
});

test('a throwing teardown does not escape the tick', () => {
  const socket = browserSocket({ answers: false });
  let clock = 0;
  const watch = watchBrowser(socket, {
    now: () => clock,
    onDead: () => {
      throw new Error('socket already gone');
    },
  });

  clock += BROWSER_DEAD_MS + 1;
  assert.doesNotThrow(() => watch.check());
});
