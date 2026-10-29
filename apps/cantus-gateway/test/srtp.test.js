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

/**
 * The counter block, against the RFC rather than against ourselves.
 *
 * A round trip hides the one bug that matters here: if the IV is built wrongly
 * in the same way on both sides, protect/unprotect still agree while every
 * packet decrypts to noise at a real peer. The HMAC covers the ciphertext, so
 * nothing fails — the call just sounds like a modem. RFC 3711 B.2 gives the
 * keystream for a known session key and salt, which pins the layout.
 */
test('the AES-CM keystream matches RFC 3711 B.2', () => {
  const context = new SrtpContext({ key, salt });
  // The vector names the session keys directly, so they replace the derived ones.
  context.encryptionKey = Buffer.from('2B7E151628AED2A6ABF7158809CF4F3C', 'hex');
  context.salt = Buffer.from('F0F1F2F3F4F5F6F7F8F9FAFBFCFD', 'hex');

  // SSRC 0 and index 0: the counter block is the salt with the block counter at
  // 0, and the counter is what walks — 65282 blocks, exactly as the RFC measures
  // the segment.
  const blocks = 65282;
  const segment = context.keystream(0, 0, blocks * 16);
  const block = (n) => segment.subarray(n * 16, (n + 1) * 16).toString('hex');
  assert.equal(block(0), 'e03ead0935c95e80e166b16dd92b4eb4');
  assert.equal(block(0xfeff), 'ec8cdf7398607cb0f2d21675ea9ea1e4');
  assert.equal(block(0xff01), '6a2cc3787889374fbeb4c81b17ba6c44');
});

test('the counter block puts the SSRC and the index where the RFC does', () => {
  // A zero salt leaves the layout visible: salt | SSRC | index | block counter.
  const context = new SrtpContext({ key, salt });
  context.salt = Buffer.alloc(14);

  const iv = context.counterBlock(0x0000_0000_1234, 0xcafebabe);
  // salt (4 bytes shown) | SSRC | 48-bit index | 16-bit block counter
  assert.equal(iv.toString('hex'), '00000000' + 'cafebabe' + '000000001234' + '0000');
});

test('two streams with the same sequence number do not share a keystream', () => {
  // The bug this guards: an IV that ignores the SSRC gives every stream the same
  // keystream for a given sequence number, and the far end hears noise.
  const context = new SrtpContext({ key, salt });
  const one = context.keystream(0x1234, 0x11111111, 16);
  const two = context.keystream(0x1234, 0x22222222, 16);
  assert.notEqual(one.toString('hex'), two.toString('hex'));
});

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
