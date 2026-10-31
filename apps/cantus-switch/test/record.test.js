/**
 * §9.7 sealed records: media a relay carries without being able to read it.
 *
 * The claim is not "the relay forwards a packet" — the relay already did that.
 * It is that the octets the relay forwards are an AEAD envelope it cannot open
 * or alter undetected, that a replay is dropped, and that a record which opens
 * for nobody costs nothing but a counter. All three are asserted here against
 * the real relay, the real key exchange and a real session.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CantusRelay } from '../src/relay.js';
import { CantusEndpoint } from '../src/endpoint.js';
import { seal, open, deriveKey, newKeyPair } from '../src/record.js';
import { encodeMedia, decodeRecord, datagramKind, KIND_RECORD } from '../src/wire.js';
import { PATH_RELAY } from '../src/reach.js';
import { waitUntil } from './wait.js';

const SECRET = 'record-test-secret-value';

test('two ends derive the same key, and only for their own call', () => {
  const alice = newKeyPair();
  const bob = newKeyPair();

  const fromAlice = deriveKey({ privateKey: alice.privateKey, peerRaw: bob.publicKey, call: 'call-a' });
  const fromBob = deriveKey({ privateKey: bob.privateKey, peerRaw: alice.publicKey, call: 'call-a' });
  assert.ok(fromAlice.equals(fromBob), 'X25519 is symmetric');

  const otherCall = deriveKey({ privateKey: bob.privateKey, peerRaw: alice.publicKey, call: 'call-b' });
  assert.equal(fromAlice.equals(otherCall), false, 'a key must not outlive its call');

  const { record } = seal({ key: fromAlice, tag: 0x1234, seq: 7, payload: Buffer.from('one frame') });
  const opened = open({ key: fromBob, tag: 0x1234, record });
  assert.equal(opened.seq, 7);
  assert.equal(opened.payload.toString('utf8'), 'one frame');

  // A record is bound to its tag and sequence number, so neither can be
  // rewritten in flight to move a frame into another call.
  assert.throws(() => open({ key: fromBob, tag: 0x9999, record }));
  const moved = Buffer.from(record);
  moved.writeBigUInt64BE(9n, 0);
  assert.throws(() => open({ key: fromBob, tag: 0x1234, record: moved }));

  const tampered = Buffer.from(record);
  tampered[tampered.length - 20] ^= 0xff;
  assert.throws(() => open({ key: fromBob, tag: 0x1234, record: tampered }));
  assert.throws(() => open({ key: otherKey(), tag: 0x1234, record }));
});

function otherKey() {
  return deriveKey({ privateKey: newKeyPair().privateKey, peerRaw: newKeyPair().publicKey, call: 'call-a' });
}

test('a call crosses the relay as records it cannot read, and drops a replay', async (t) => {
  const relay = new CantusRelay({ bind: '127.0.0.1:0', secret: SECRET, allowTestProfile: true });
  await relay.start();
  t.after(() => relay.stop());

  // Everything the relay puts on a socket, so blindness is a property of the
  // bytes rather than a claim in a comment.
  const forwarded = [];
  const send = relay.sendto.bind(relay);
  relay.sendto = (dest, bytes) => {
    forwarded.push({ dest, bytes: Buffer.from(bytes) });
    return send(dest, bytes);
  };

  const ata = new CantusEndpoint({
    id: 'ata@records.test',
    secret: SECRET,
    bind: '127.0.0.1:0',
    allowTestProfile: true,
    relay: relay.addr,
    sealRecords: true,
  });
  ata.onIncoming = (session) => ata.accept(session);
  let loudest = 0;
  ata.onInboundMedia = (session, media) => {
    for (let i = 0; i + 1 < media.payload.length; i += 2) {
      loudest = Math.max(loudest, Math.abs(media.payload.readInt16LE(i)));
    }
  };
  await ata.start();
  t.after(() => ata.stop());
  await waitUntil(() => ata.handle > 0, { label: 'the ATA to register with the relay' });

  const sw = new CantusEndpoint({
    id: 'switch@records.test',
    secret: SECRET,
    bind: '127.0.0.1:0',
    allowTestProfile: true,
    relay: relay.addr,
    sealRecords: true,
    // Silence from the switch's own clock, so the only non-silent frame on the
    // call is the sealed one this test sends.
    mediaSource: () => Buffer.alloc(320),
  });
  await sw.start();
  t.after(() => sw.stop());
  await waitUntil(() => sw.handle > 0, { label: 'the switch to register with the relay' });

  const call = sw.call('ata@records.test');
  assert.ok(call, 'the call should be placed');
  await waitUntil(() => sw.sessions.get(call)?.accepted, { label: 'the ATA to answer' });

  const session = sw.sessions.get(call);
  assert.ok(session.recordKey, 'the key exchange in INVITE/ACCEPT must have produced a record key');
  sw.commitPath(session, PATH_RELAY);

  // Media is a stream, not a packet: a relay path that loses one datagram must
  // not fail the call, so the test keeps sending until it is heard rather than
  // betting the whole assertion on a single UDP send.
  const payload = Buffer.alloc(320, 0x7f);
  let mediaSeq = 0;
  const heard = await waitUntil(
    () => {
      mediaSeq += 1;
      const inner = encodeMedia({ stream: 0, tag: session.tag, seq: mediaSeq, ts: 0, codec: 2, flags: 0, payload });
      assert.equal(sw.sendSealed(session, inner), true);
      return loudest === 0x7f7f;
    },
    { label: 'the sealed frame to reach the ATA', interval: 20 }
  );
  assert.equal(heard, true);
  assert.equal(loudest, 0x7f7f, 'the frame must arrive exactly as it was sealed');
  assert.ok(sw.stats.sealedFrames > 0);
  assert.ok(relay.sealed > 0, 'the relay must have carried a record');

  const records = forwarded.filter((entry) => datagramKind(entry.bytes) === KIND_RECORD);
  assert.ok(records.length > 0);
  for (const { bytes } of records) {
    assert.equal(bytes.includes(Buffer.alloc(8, 0x7f)), false, 'the relay must never see the media');
  }
  const carried = decodeRecord(records[0].bytes);
  assert.ok(carried.record.length >= 8 + 16 + 320, 'the body is the whole media datagram plus a tag');

  // Replaying a record the relay already forwarded must not reach the call a
  // second time. A blind forwarder makes packets cheap to repeat; the sequence
  // number inside the AEAD is what makes them useless.
  const replay = records[0].bytes;
  const replays = ata.stats.sealedReplay;
  ata.handleDatagram(replay, relay.addr, false);
  assert.equal(ata.stats.sealedReplay, replays + 1, 'the replayed record must be recognised and dropped');

  // A record sealed for nobody costs a counter, not a session.
  const strangerInner = encodeMedia({ stream: 0, tag: session.tag, seq: 1, ts: 0, codec: 2, flags: 0, payload });
  const stranger = seal({ key: otherKey(), tag: session.tag, seq: 1, payload: strangerInner }).record;
  ata.handleDatagram(Buffer.concat([Buffer.from([0xca, KIND_RECORD, 0]), stranger]), relay.addr, false);
  assert.ok(ata.stats.sealedRejected > 0, 'a record that opens for no call is dropped unread');
});
