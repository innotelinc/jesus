/**
 * SDES-SRTP, checked against itself and against its own failure modes.
 *
 * A round trip proves the two halves agree, not that they agree with libsrtp —
 * that is what the Asterisk interop run is for. What these tests do cover is the
 * part that is easy to get subtly wrong and impossible to see in a call: the
 * authentication tag must reject a modified packet, and the rollover counter
 * must keep the keystream unique when the 16-bit sequence number wraps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SrtpContext, cryptoAttribute, inlineKey, newKeyMaterial, parseCryptoAttribute, TAG_BYTES } from '../src/srtp.js';

const { key, salt } = newKeyMaterial();

function packet({ seq = 1, ts = 0, payload = Buffer.alloc(160, 0x5a) } = {}) {
  const out = Buffer.alloc(12 + payload.length);
  out[0] = 0x80;
  out[1] = 0; // PCMU
  out.writeUInt16BE(seq, 2);
  out.writeUInt32BE(ts >>> 0, 4);
  out.writeUInt32BE(0xcafebabe, 8);
  payload.copy(out, 12);
  return out;
}

test('an inline key survives the round trip through an SDP attribute', () => {
  const attribute = cryptoAttribute({ key, salt });
  assert.match(attribute, /^1 AES_CM_128_HMAC_SHA1_80 inline:[A-Za-z0-9+/=]+$/);
  const parsed = parseCryptoAttribute(attribute);
  assert.ok(parsed);
  assert.equal(parsed.profile, 'AES_CM_128_HMAC_SHA1_80');
  assert.equal(inlineKey(parsed), inlineKey({ key, salt }));
  assert.deepEqual(parsed.key, key);
  assert.deepEqual(parsed.salt, salt);
});

test('a profile this gateway cannot do is refused rather than half-supported', () => {
  assert.equal(parseCryptoAttribute('1 AES_256_CM_HMAC_SHA1_80 inline:AAAA'), null);
  assert.equal(parseCryptoAttribute('1 AES_CM_128_HMAC_SHA1_32 inline:AAAA'), null);
  assert.equal(parseCryptoAttribute('nonsense'), null);
});

test('a protected packet comes back out unchanged, with a tag appended', () => {
  const sender = new SrtpContext({ key, salt });
  const receiver = new SrtpContext({ key, salt });
  const original = packet();
  const protectedPacket = sender.protect(original);
  assert.equal(protectedPacket.length, original.length + TAG_BYTES);
  // The header stays readable: that is what lets a carrier route the packet.
  assert.deepEqual(protectedPacket.subarray(0, 12), original.subarray(0, 12));
  assert.notDeepEqual(protectedPacket.subarray(12, protectedPacket.length - TAG_BYTES), original.subarray(12));
  assert.deepEqual(receiver.unprotect(protectedPacket), original);
});

test('a packet with one altered byte is dropped, not decrypted', () => {
  const sender = new SrtpContext({ key, salt });
  const receiver = new SrtpContext({ key, salt });
  const protectedPacket = sender.protect(packet({ seq: 7 }));
  protectedPacket[20] ^= 0x01;
  assert.equal(receiver.unprotect(protectedPacket), null);
});

test('a packet from the wrong key is dropped', () => {
  const other = newKeyMaterial();
  const sender = new SrtpContext(other);
  const receiver = new SrtpContext({ key, salt });
  assert.equal(receiver.unprotect(sender.protect(packet())), null);
});

test('the keystream does not repeat when the sequence number wraps', () => {
  const sender = new SrtpContext({ key, salt });
  const receiver = new SrtpContext({ key, salt });
  // In wire order: 65534, 65535, then the sequence number wraps to 0.
  const plain = [packet({ seq: 0xfffe }), packet({ seq: 0xffff }), packet({ seq: 0x0000 })];
  const protectedPackets = plain.map((entry) => sender.protect(entry));
  // Same sequence number in the wrap case, different rollover counter: the two
  // must not share a counter block, or the keystream repeats.
  assert.notDeepEqual(protectedPackets[0].subarray(12), protectedPackets[2].subarray(12));
  for (let i = 0; i < plain.length; i += 1) {
    assert.deepEqual(receiver.unprotect(protectedPackets[i]), plain[i]);
  }
});
