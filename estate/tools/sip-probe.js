#!/usr/bin/env node
/**
 * A carrier in one file, for testing the inbound half of the PSTN gateway.
 *
 * The gateway is the only thing in the estate that speaks SIP, and the only
 * way to know it works is to put SIP datagrams on the wire. This sends a real
 * INVITE for a DID from a real UDP socket, answers the gateway's SDP, sends
 * PCMU audio and hangs up — everything a carrier does for an inbound call,
 * without needing a carrier account.
 *
 *   node sip-probe.js --gateway 45.63.1.70:5060 --did 14132642700 --from 14134210134
 *   node sip-probe.js --gateway 127.0.0.1:5060 --did 14132642700 --ring 20 --no-audio
 *   node sip-probe.js --gateway 45.63.1.70:5060 --did 14132642700 --srtp
 *
 * It can also hold a conversation's end of the line: `--speak` synthesises a
 * sentence through the local TTS shim, waits for the agent's greeting, sends it
 * as PCMU, and `--record` writes everything that came back to a WAV so the reply
 * can be measured instead of assumed.
 *
 *   node sip-probe.js --gateway 127.0.0.1:5060 --did 14132642700 --from 14134210134 \
 *     --speak 'Hi, I need to book an appointment for Friday.' --seconds 40 \
 *     --record /tmp/call.wav
 *
 * Exit status is 0 only when the call was answered (200 OK) and the ACK landed,
 * which is the answer to "does the DID actually ring a line?".
 */

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import { SrtpContext, cryptoAttribute, newKeyMaterial, parseCryptoAttribute } from '../../apps/cantus-gateway/src/srtp.js';

const CRLF = '\r\n';
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const gateway = flag('gateway', '127.0.0.1:5060');
const [gatewayHost, gatewayPort = '5060'] = gateway.split(':');
const did = flag('did', '').replace(/\D/g, '');
const from = flag('from', '1000').replace(/\D/g, '');
const ringSeconds = Number(flag('ring', '15'));
const sendAudio = !has('no-audio');
// A sub-account that only accepts `RTP/SAVP` refuses a plain offer with 488,
// so the probe has to be able to make the encrypted offer the carrier makes.
const secure = has('srtp');
// Where to send audio instead of the address in the answer's `c=`. A probe on
// the box has to use the gateway's container address: its SDP advertises the
// public IP, which does not route back in from the Docker network.
const mediaHost = flag('media-host', '');
// What the caller says, and when. The delay is the agent's greeting: speaking
// over it would be measured as a barge-in, not as a turn.
const speakText = flag('speak', '');
const ttsUrl = flag('tts', 'http://127.0.0.1:8881');
const speakDelayMs = Number(flag('speak-delay', '6000'));
const callSeconds = Number(flag('seconds', '0'));
const recordPath = flag('record', '');

if (!did) {
  console.error(
    'usage: node sip-probe.js --gateway <host:port> --did <number> [--from <number>] [--ring 15] [--no-audio] [--srtp] [--media-host <addr>]\n' +
      '                        [--speak "<sentence>"] [--tts <url>] [--speak-delay <ms>] [--seconds <n>] [--record <file.wav>]'
  );
  process.exit(2);
}

const log = (...parts) => console.log('[sip-probe]', ...parts);

const socket = dgram.createSocket('udp4');
const local = () => socket.address();
const branch = () => `z9hG4bK${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const tag = () => randomUUID().replace(/-/g, '').slice(0, 8);

const callId = `${randomUUID()}@sip-probe`;
const fromTag = tag();
const contact = (port) => `sip:probe@${local().address}:${port}`;

/**
 * The address to put in `c=`, which is where the gateway sends audio back.
 *
 * `socket.address()` on a socket bound to `0.0.0.0` reports `0.0.0.0`, and a
 * gateway that is told to send RTP to `0.0.0.0` sends it nowhere: the call was
 * answered and the probe still reported "0 RTP packets received", which reads
 * like a broken media path in the gateway.
 */
function advertisedAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

// The audio the probe sends. A 1 kHz tone is easy to recognise on the far side:
// if the softphone hears a tone, the whole path — carrier RTP, gateway, Cantus
// media, browser — is carrying audio and not just signalling.
//
// One byte per sample, because the payload type is PCMU. The first version
// wrote 16-bit samples into a 160-byte buffer: it threw on the 160th sample and
// never sent a packet, so a call that was fully answered reported "0 RTP
// packets" and looked like a media failure in the gateway.
function ulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32_635;
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const tone = () => {
  const frames = Buffer.alloc(160);
  for (let i = 0; i < 160; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 1000 * (probe.frame * 160 + i)) / 8000) * 8000);
    frames[i] = ulaw(sample);
  }
  probe.frame += 1;
  return frames;
};

const SILENCE = Buffer.alloc(160, 0xff); // µ-law zero, which is not silence
const speech = { ulaw: null, offset: 0, started: false, at: 0 };

function ulawToLinear(byte) {
  const value = ~byte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** 24 kHz speech from the TTS shim, decimated to the 8 kHz the carrier speaks. */
function toCallerAudio(pcm24) {
  const frames = Math.floor(pcm24.length / 6);
  const out = Buffer.alloc(frames);
  for (let i = 0; i < frames; i += 1) {
    const a = pcm24.readInt16LE(i * 6);
    const b = pcm24.readInt16LE(i * 6 + 2);
    const c = pcm24.readInt16LE(i * 6 + 4);
    out[i] = ulaw(Math.round((a + b + c) / 3));
  }
  return out;
}

async function synthesize(text) {
  const response = await fetch(`${ttsUrl.replace(/\/$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'piper', voice: 'en_US-amy-medium', response_format: 'pcm' }),
  });
  if (!response.ok) throw new Error(`tts answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * One 20 ms frame of what the caller is doing: silent until the greeting is
 * over, then the sentence, then silence again. A probe that only ever sends a
 * tone cannot tell "the agent did not answer me" from "the agent did not hear
 * me", which are different bugs in different containers.
 */
function frameFor() {
  if (!speech.ulaw) return tone();
  if (!speech.started) {
    if (Date.now() < speech.at) return SILENCE;
    speech.started = true;
  }
  if (speech.offset >= speech.ulaw.length) return SILENCE;
  const chunk = speech.ulaw.subarray(speech.offset, speech.offset + 160);
  speech.offset += chunk.length;
  probe.spoken += chunk.length;
  if (chunk.length === 160) return chunk;
  const padded = Buffer.alloc(160, 0xff);
  chunk.copy(padded);
  return padded;
}

/** Everything the agent said, as a WAV: a measurement, not a claim. */
function writeWav(path, ulawBytes) {
  const pcm = Buffer.alloc(ulawBytes.length * 2);
  for (let i = 0; i < ulawBytes.length; i += 1) pcm.writeInt16LE(ulawToLinear(ulawBytes[i]), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  try {
    writeFileSync(path, Buffer.concat([header, pcm]));
    return `${path} (${(pcm.length / 16000).toFixed(1)}s)`;
  } catch (err) {
    log(`could not write ${path}: ${err.message}`);
    return '';
  }
}

const probe = {
  frame: 0,
  rtpPort: 0,
  remoteAudio: null,
  rtpPackets: 0,
  authFailures: 0,
  answered: false,
  rtpSocket: undefined,
  out: null,
  in: null,
  received: [],
  peak: 0,
  spoken: 0,
};

// Our key goes in the offer; theirs comes back in the answer. One context per
// direction, exactly as the gateway keys its own leg.
const ourKeys = secure ? newKeyMaterial() : null;

function headers() {
  return [
    ['Via', `SIP/2.0/UDP ${local().address}:${local().port};branch=${branch()};rport`],
    ['Max-Forwards', '70'],
    ['From', `<sip:${from}@${gatewayHost}>;tag=${fromTag}`],
    ['To', `<sip:${did}@${gatewayHost}>`],
    ['Call-ID', callId],
    ['CSeq', '1 INVITE'],
    ['Contact', `<${contact(local().port)}>`],
    ['User-Agent', 'cantus-sip-probe/1.0'],
  ];
}

function sendInvite() {
  const advertised = advertisedAddress();
  const sdp = [
    'v=0',
    `o=probe ${Date.now()} ${Date.now()} IN IP4 ${advertised}`,
    's=cantus-probe',
    `c=IN IP4 ${advertised}`,
    't=0 0',
    `m=audio ${probe.rtpPort} RTP/${secure ? 'SAVP' : 'AVP'} 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=sendrecv',
    ...(secure ? [`a=crypto:${cryptoAttribute(ourKeys)}`] : []),
    '',
  ].join(CRLF);
  const message = [`INVITE sip:${did}@${gatewayHost}:${gatewayPort} SIP/2.0`, ...headers().map(([k, v]) => `${k}: ${v}`)];
  message.push('Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`);
  const bytes = Buffer.from(message.join(CRLF) + CRLF + CRLF + sdp, 'utf8');
  socket.send(bytes, Number(gatewayPort), gatewayHost);
  log(`INVITE sip:${did}@${gatewayHost}:${gatewayPort} (audio ${advertised}:${probe.rtpPort}${secure ? ', SRTP' : ''})`);
}

function answerSdp(body) {
  const text = String(body || '');
  const media = /m=audio\s+(\d+)\s+RTP\/(AVP|SAVP)\s+([\d ]+)/.exec(text);
  const connection = /c=IN\s+IP4\s+([\d.]+)/.exec(text);
  if (!media) return null;
  return {
    port: Number(media[1]),
    host: mediaHost || (connection ? connection[1] : gatewayHost),
    pcmu: media[3].split(/\s+/).includes('0'),
    secure: media[2] === 'SAVP',
    crypto: /^a=crypto:(.+)$/im.exec(text)?.[1]?.trim() || '',
  };
}

function onResponse(message, rinfo) {
  const status = message.status;
  if (status === 100) return;
  log(`${status} ${message.reason}`);
  if (status === 180) log('the far side is ringing a line');
  if (status >= 300) {
    log('refused — see the gateway log for the reason');
    process.exit(1);
  }
  if (status !== 200 || probe.answered) return;
  probe.answered = true;
  probe.remoteAudio = answerSdp(message.body);
  if (!probe.remoteAudio) {
    log('answered without an audio address; signalling only');
  } else {
    log(`answered; sending to ${probe.remoteAudio.host}:${probe.remoteAudio.port}`);
  }
  if (secure) {
    const theirs = parseCryptoAttribute(probe.remoteAudio?.crypto);
    if (!theirs) {
      log(`answered without a usable a=crypto line (${probe.remoteAudio?.crypto || 'none'}) — media cannot be encrypted`);
    } else {
      probe.out = new SrtpContext(ourKeys);
      probe.in = new SrtpContext(theirs);
      log(`SRTP agreed: AES_CM_128_HMAC_SHA1_80, their tag ${theirs.tag}`);
    }
  }
  sendAck(rinfo);
  startAudio();
  speech.at = Date.now() + (Number.isFinite(speakDelayMs) ? speakDelayMs : 6000);
}

function sendAck(rinfo) {
  const message = [
    `ACK sip:${did}@${gatewayHost}:${gatewayPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${local().address}:${local().port};branch=${branch()};rport`,
    'Max-Forwards: 70',
    `From: <sip:${from}@${gatewayHost}>;tag=${fromTag}`,
    `To: <sip:${did}@${gatewayHost}>`,
    `Call-ID: ${callId}`,
    'CSeq: 1 ACK',
    'Content-Length: 0',
  ].join(CRLF);
  socket.send(Buffer.from(message + CRLF + CRLF, 'utf8'), rinfo.port, rinfo.address);
}

function startAudio() {
  if (!sendAudio || !probe.remoteAudio) return;
  probe.rtpSocket = dgram.createSocket('udp4');
  probe.rtpSocket.on('message', (buf) => {
    let packet = buf;
    if (probe.in) {
      // An encrypted packet that fails its tag is not audio: counting it would
      // report a working call when nothing decryptable arrived.
      if (!probe.in.unprotect(buf)) {
        probe.authFailures += 1;
        return;
      }
      packet = buf;
    }
    probe.rtpPackets += 1;
    // 12-byte header, no CSRCs, no extension: what the gateway sends for PCMU.
    const payload = packet.subarray(12);
    probe.received.push(Buffer.from(payload));
    for (const byte of payload) {
      const level = Math.abs(ulawToLinear(byte));
      if (level > probe.peak) probe.peak = level;
    }
  });
  // The port in the SDP is `probe.rtpPort`, so that is the port the gateway
  // sends to. Binding 0 instead gave the probe a socket on some other port and
  // every packet the gateway sent was dropped, which looked like the gateway
  // was not sending audio at all.
  probe.rtpSocket.bind(probe.rtpPort, () => {
    const seq = { value: 1 };
    const timer = setInterval(() => {
      const packet = Buffer.alloc(12 + 160);
      packet[0] = 0x80;
      packet[1] = 0; // PCMU
      packet.writeUInt16BE(seq.value & 0xffff, 2);
      packet.writeUInt32BE((probe.frame * 160) & 0xffffffff, 4);
      packet.writeUInt32BE(0xdeadbeef, 8); // SSRC
      frameFor().copy(packet, 12);
      seq.value += 1;
      const outbound = probe.out ? probe.out.protect(packet) : packet;
      probe.rtpSocket.send(outbound, probe.remoteAudio.port, probe.remoteAudio.host);
    }, 20);
    timer.unref?.();
    probe.audioTimer = timer;
  });
}

function hangup() {
  clearInterval(probe.audioTimer);
  const message = [
    `BYE sip:${did}@${gatewayHost}:${gatewayPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${local().address}:${local().port};branch=${branch()};rport`,
    'Max-Forwards: 70',
    `From: <sip:${from}@${gatewayHost}>;tag=${fromTag}`,
    `To: <sip:${did}@${gatewayHost}>`,
    `Call-ID: ${callId}`,
    'CSeq: 2 BYE',
    'Content-Length: 0',
  ].join(CRLF);
  socket.send(Buffer.from(message + CRLF + CRLF, 'utf8'), Number(gatewayPort), gatewayHost);
  log('BYE sent');
  setTimeout(() => {
    const record = recordPath ? writeWav(recordPath, Buffer.concat(probe.received)) : '';
    log(
      `result: ${probe.answered ? 'answered' : 'not answered'}, ${probe.rtpPackets} RTP packets received` +
        (probe.in ? `, ${probe.authFailures} failed authentication` : '') +
        `, peak ${probe.peak}/32767` +
        (probe.spoken ? `, spoke ${(probe.spoken / 8000).toFixed(1)}s` : '') +
        (record ? `, recorded ${record}` : '')
    );
    try {
      probe.rtpSocket?.close();
    } catch {
      /* already closed */
    }
    socket.close();
    process.exit(probe.answered ? 0 : 1);
  }, 500);
}

socket.on('message', (buf, rinfo) => {
  const text = buf.toString('utf8');
  if (!/^SIP\/2\.0\s+\d{3}/.test(text)) {
    // Anything that is not a response is a request from the gateway (BYE when
    // the far end hung up first). Answer it so the dialog closes cleanly.
    if (/^BYE\s/.test(text)) {
      const reply = ['SIP/2.0 200 OK'];
      for (const line of text.split(CRLF).slice(1)) {
        if (/^(Via|From|To|Call-ID|CSeq):/i.test(line)) reply.push(line);
      }
      reply.push('Content-Length: 0');
      socket.send(Buffer.from(reply.join(CRLF) + CRLF + CRLF, 'utf8'), rinfo.port, rinfo.address);
      log('200 OK to BYE (the far side ended the call)');
      clearInterval(probe.audioTimer);
      return;
    }
    log('request from gateway:', text.split(CRLF)[0]);
    return;
  }
  const startLine = text.split(CRLF)[0];
  const [, status, ...reason] = startLine.split(' ');
  const header = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim() || '';
  const bodyIndex = text.indexOf(CRLF + CRLF);
  onResponse(
    {
      status: Number(status),
      reason: reason.join(' '),
      body: bodyIndex === -1 ? '' : text.slice(bodyIndex + 4),
      header,
    },
    rinfo
  );
});

socket.bind(0, async () => {
  probe.rtpPort = 40000 + Math.floor(Math.random() * 3000);
  log(`local ${local().address}:${local().port}, calling ${did} from ${from}`);
  if (speakText) {
    // Synthesised before the INVITE so the carrier's ring does not eat into the
    // sentence. A failure here is fatal on purpose: a call made to test the
    // agent's speech that carries no speech tests nothing.
    try {
      const pcm = await synthesize(speakText);
      speech.ulaw = toCallerAudio(pcm);
      log(`will speak ${(speech.ulaw.length / 8000).toFixed(1)}s after ${speakDelayMs} ms: "${speakText}"`);
    } catch (err) {
      console.error(`[sip-probe] could not synthesise the caller's line: ${err.message}`);
      process.exit(3);
    }
  }
  sendInvite();
  setTimeout(hangup, Math.max(2, ringSeconds, callSeconds) * 1000);
});
