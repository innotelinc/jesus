#!/usr/bin/env node
/**
 * A real encrypted call through the border, and the proof that it was encrypted.
 *
 *   node scripts/e2e-srtp-call.mjs [border-host:port]
 *
 * This is not a unit test with a fake socket. It does what a handset does:
 *
 *   1. REGISTERs an extension at whatever border it is given (challenge, digest,
 *      200) — a call cannot be placed from an extension the registrar does not
 *      hold, by design.
 *   2. Registers a line endpoint on the Cantus switch, so there is something to
 *      answer on the other side of the bridge. It answers and speaks a tone
 *      rather than echoing, so what arrives at the caller can only have come
 *      from the switch.
 *   3. INVITEs that line with an SDES-SRTP offer (`RTP/SAVP` + `a=crypto`),
 *      exchanges encrypted RTP in both directions, and then hangs up.
 *   4. Offers a plaintext call and requires 488: "SRTP a must" means the
 *      unencrypted call must not exist, not that it is discouraged.
 *
 * What it asserts, in order of how much it proves:
 *
 *   - every packet the caller received authenticated (HMAC) and decrypted to
 *     speech-level audio, and the count is not zero;
 *   - the switch received frames from the caller, so media crossed the border
 *     in the other direction too;
 *   - the answer carried a crypto attribute at all;
 *   - the plaintext offer was refused with 488.
 *
 * Exits 0 only when all of that holds, and prints the observations as JSON so a
 * failure says which one broke.
 */

import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMessage, buildRequest, digestResponse } from '../src/sip.js';
import { cryptoAttribute, newKeyMaterial, SrtpContext, parseCryptoAttribute } from '../src/srtp.js';
import { ulawToPcm16, pcm16ToUlaw, PCM_RATE } from '../../cantus-switch/src/media.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read one key from the christ deployment so this script needs no arguments. */
function fromChristEnv(key, fallback = '') {
  if (process.env[key]) return process.env[key];
  try {
    const text = readFileSync(join(HERE, '../../../christ/.env'), 'utf8');
    const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : fallback;
  } catch {
    return fallback;
  }
}

const target = process.argv[2] || process.env.E2E_BORDER || '127.0.0.1:5060';
const [borderHost, borderPortText] = target.split(':');
const borderPort = Number(borderPortText || 5060);

const domain = fromChristEnv('CANTUS_DOMAIN', 'estate.local');
const secret = fromChristEnv('CANTUS_SECRET');
const line = process.env.E2E_LINE || '101';
const extension = process.env.E2E_EXT || line;
const switchHttp = process.env.CANTUS_HTTP || '127.0.0.1:8188';
const controlToken = fromChristEnv('CANTUS_CONTROL_TOKEN');
// The border runs in a container, so "127.0.0.1" in our SDP is the container's
// own loopback and the audio goes nowhere. This is the address the border can
// actually reach — the docker bridge gateway on a compose network.
const mediaAddress = process.env.E2E_MEDIA_ADDRESS || '127.0.0.1';
const ataUsers = fromChristEnv('SIP_ATA_USERS', `${line}:front-desk`);
const password =
  process.env.SIP_ATA_PASSWORD ||
  (ataUsers
    .split(',')
    .map((pair) => pair.split(':'))
    .find(([user]) => user === extension)
    ?.slice(1)
    .join(':') ??
    '');

const observation = {
  border: `${borderHost}:${borderPort}`,
  media: mediaAddress,
  line,
  extension,
  registered: false,
  answerStatus: 0,
  answerCrypto: '',
  plaintextStatus: 0,
  calls: 0,
  authenticated: 0,
  decryptedEnergy: 0,
  cantusInboundFrames: 0,
  switchEnergy: 0,
  hangupStatus: 0,
  failure: '',
};

/** A 20 ms µ-law frame of 440 Hz — speech-level audio, not silence. */
function toneFrame(state) {
  const samples = Math.round(PCM_RATE / 50);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(state.phase) * 9000), i * 2);
    state.phase += (2 * Math.PI * 440) / PCM_RATE;
  }
  return pcm16ToUlaw(pcm);
}

function rtpPacket({ seq, ts, ssrc, payload }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0; // PCMU
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

/** Mean absolute amplitude of a PCM16 buffer, in the same units µ-law decodes to. */
function energyOfPcm(pcm) {
  let total = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    total += Math.abs(pcm.readInt16LE(i));
    count += 1;
  }
  return count ? total / count : 0;
}

/** Mean absolute amplitude of a decoded µ-law payload, in PCM16 units. */
function energyOf(payload) {
  const pcm = ulawToPcm16(payload);
  let total = 0;
  let count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    total += Math.abs(pcm.readInt16LE(i));
    count += 1;
  }
  return count ? total / count : 0;
}

function authParams(header) {
  const params = {};
  for (const match of String(header || '').matchAll(/([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return params;
}

/**
 * The line that answers.
 *
 * It is a browser softphone: the switch's own `/ws/line` surface, the same one
 * the console uses. It registers as the line, answers the call when the routing
 * document rings it, and then does the two things that make the media path
 * provable instead of assumed — it counts every audio frame the caller's leg
 * produced, and it speaks a tone of its own, so the only source of the audio
 * the caller receives is this line.
 */
async function startAnsweringLine() {
  const url = `ws://${switchHttp}/ws/line?token=${encodeURIComponent(controlToken)}&ext=${line}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const state = { ws, tone: null };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the switch did not accept the line socket')), 6000);
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message = {};
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'registered') {
        clearTimeout(timer);
        resolve();
      }
      if (message.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`the switch refused the line: ${message.error}`));
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the line socket failed'));
    });
  });

  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      let message = {};
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'incoming') {
        observation.calls += 1;
        ws.send(JSON.stringify({ type: 'answer', callId: message.callId }));
        const phase = { value: 0 };
        state.tone = setInterval(() => {
          const samples = Math.round(PCM_RATE / 50);
          const pcm = Buffer.alloc(samples * 2);
          for (let i = 0; i < samples; i += 1) {
            pcm.writeInt16LE(Math.round(Math.sin(phase.value) * 9000), i * 2);
            phase.value += (2 * Math.PI * 440) / PCM_RATE;
          }
          ws.send(pcm);
        }, 20);
      }
      return;
    }
    // Audio the switch handed this leg: the caller's own voice, after the
    // border decrypted it. Counted, because this is the direction a one-way
    // call would hide in.
    const bytes = Buffer.from(event.data);
    observation.cantusInboundFrames += 1;
    observation.switchEnergy = Math.max(observation.switchEnergy, energyOfPcm(bytes));
  });

  return state;
}

/** A handset: registers at the border, then places calls through it. */
function handset() {
  const socket = dgram.createSocket('udp4');
  const inbox = [];
  socket.on('message', (buf) => {
    try {
      inbox.push(parseMessage(buf.toString('utf8')));
    } catch {
      /* a malformed datagram is not a response */
    }
  });

  const waitFor = async (predicate, timeoutMs = 6000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const index = inbox.findIndex(predicate);
      if (index !== -1) return inbox.splice(index, 1)[0];
      await sleep(20);
    }
    return null;
  };

  const registerCallId = `e2e-reg-${Date.now()}@${extension}.local`;
  const registerTag = `e2e${Date.now().toString(16)}`;
  let cseq = 1;

  async function register() {
    const send = (authorization) => {
      const headers = [
        ['Via', `SIP/2.0/UDP 127.0.0.1:${socket.address().port};branch=z9hG4bK${cseq};rport`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${extension}@${domain}>;tag=${registerTag}`],
        ['To', `<sip:${extension}@${domain}>`],
        ['Call-ID', registerCallId],
        ['CSeq', `${cseq} REGISTER`],
        ['Contact', `<sip:${extension}@127.0.0.1:${socket.address().port}>;expires=300`],
        ['Expires', '300'],
        ['User-Agent', 'cantus-e2e/1.0'],
      ];
      if (authorization) headers.push(['Authorization', authorization]);
      cseq += 1;
      socket.send(buildRequest({ method: 'REGISTER', uri: `sip:${domain}`, headers }), borderPort, borderHost);
    };
    send('');
    let response = await waitFor((message) => message.type === 'response' && message.status === 401);
    if (!response) return false;
    const challenge = authParams(response.get('www-authenticate'));
    send(
      digestResponse({
        username: extension,
        password,
        realm: challenge.realm || domain,
        nonce: challenge.nonce || '',
        uri: `sip:${domain}`,
        method: 'REGISTER',
        qop: challenge.qop ? 'auth' : undefined,
        opaque: challenge.opaque,
      })
    );
    response = await waitFor((message) => message.type === 'response' && message.status >= 200);
    return !!response && response.status < 300;
  }

  return { socket, inbox, waitFor, register, nextCseq: () => (cseq += 1) };
}

function sdpFor({ port, crypto, secure, ssrc }) {
  return [
    'v=0',
    `o=- ${ssrc} ${ssrc} IN IP4 ${mediaAddress}`,
    's=cantus e2e',
    `c=IN IP4 ${mediaAddress}`,
    't=0 0',
    `m=audio ${port} RTP/${secure ? 'SAVP' : 'AVP'} 0 101`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    ...(crypto ? [`a=crypto:${crypto}`] : []),
    'a=sendrecv',
  ].join('\r\n') + '\r\n';
}

async function main() {
  if (!secret) throw new Error('CANTUS_SECRET is empty: set it or run this beside christ/.env');
  if (!password) throw new Error(`no SIP password for ext ${extension} (set SIP_ATA_USERS or SIP_ATA_PASSWORD)`);

  const endpoint = await startAnsweringLine();
  const phone = handset();
  await new Promise((resolve) => phone.socket.bind(0, '0.0.0.0', resolve));

  try {
    observation.registered = await phone.register();
    if (!observation.registered) throw new Error('the border did not accept the registration');

    // The answering side needs a moment to be in the switch's line table.
    await sleep(400);

    const rtp = dgram.createSocket('udp4');
    await new Promise((resolve) => rtp.bind(0, '0.0.0.0', resolve));
    const remotePort = rtp.address().port;
    const ours = newKeyMaterial();
    const ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const callId = `e2e-call-${Date.now()}@${extension}.local`;
    const fromTag = `call${Date.now().toString(16)}`;
    const cseqNumber = phone.nextCseq();

    const invite = (cryptoHeader, secure) =>
      buildRequest({
        method: 'INVITE',
        uri: `sip:${line}@${domain}`,
        headers: [
          ['Via', `SIP/2.0/UDP 127.0.0.1:${phone.socket.address().port};branch=z9hG4bK-i${cseqNumber};rport`],
          ['Max-Forwards', '70'],
          ['From', `<sip:${extension}@${domain}>;tag=${fromTag}`],
          ['To', `<sip:${line}@${domain}>`],
          ['Call-ID', callId],
          ['CSeq', `${cseqNumber} INVITE`],
          ['Contact', `<sip:${extension}@127.0.0.1:${phone.socket.address().port}>`],
          ['Content-Type', 'application/sdp'],
          ['User-Agent', 'cantus-e2e/1.0'],
        ],
        body: sdpFor({ port: remotePort, crypto: cryptoHeader, secure, ssrc }),
      });

    phone.socket.send(invite(cryptoAttribute(ours), true), borderPort, borderHost);
    const ok = await phone.waitFor(
      (message) => message.type === 'response' && message.status === 200 && message.get('call-id') === callId,
      8000
    );
    if (!ok) throw new Error('the encrypted call was not answered with 200');
    observation.answerStatus = ok.status;
    observation.answerCrypto = /^a=crypto:(.+)$/im.exec(ok.body || '')?.[1]?.trim() || '';
    if (!observation.answerCrypto) throw new Error('the answer carried no crypto attribute');

    const theirs = parseCryptoAttribute(observation.answerCrypto);
    if (!theirs) throw new Error(`the answer offered a profile we cannot read: ${observation.answerCrypto}`);
    const receive = new SrtpContext(theirs);
    const send = new SrtpContext(ours);

    const toTag = /;tag=([^;]+)/.exec(ok.get('to') || '')?.[1] || '';
    const ack = (cseq) =>
      buildRequest({
        method: 'ACK',
        uri: `sip:${line}@${domain}`,
        headers: [
          ['Via', `SIP/2.0/UDP 127.0.0.1:${phone.socket.address().port};branch=z9hG4bK-a${cseq};rport`],
          ['Max-Forwards', '70'],
          ['From', `<sip:${extension}@${domain}>;tag=${fromTag}`],
          ['To', `<sip:${line}@${domain}>;tag=${toTag}`],
          ['Call-ID', callId],
          ['CSeq', `${cseq} ACK`],
        ],
      });
    phone.socket.send(ack(cseqNumber), borderPort, borderHost);

    // Media, in both directions. The remote port is the one in the answer's SDP.
    const remoteAudioPort = Number(/m=audio\s+(\d+)/.exec(ok.body || '')?.[1]);
    if (!remoteAudioPort) throw new Error('the answer named no audio port');

    let packets = 0;
    rtp.on('message', (buf) => {
      packets += 1;
      const opened = receive.unprotect(buf);
      if (!opened) return; // forged or replayed: not audio
      observation.authenticated += 1;
      observation.decryptedEnergy = Math.max(observation.decryptedEnergy, energyOf(opened.subarray(12)));
    });

    const tone = { phase: 0 };
    const startedAt = Date.now();
    let seq = 1;
    let ts = 0;
    while (Date.now() - startedAt < 1200) {
      const packet = rtpPacket({ seq, ts, ssrc, payload: toneFrame(tone) });
      rtp.send(send.protect(packet), remoteAudioPort, borderHost);
      seq += 1;
      ts += 160;
      await sleep(20);
    }
    await sleep(200);

    const bye = buildRequest({
      method: 'BYE',
      uri: `sip:${line}@${domain}`,
      headers: [
        ['Via', `SIP/2.0/UDP 127.0.0.1:${phone.socket.address().port};branch=z9hG4bK-b${cseqNumber + 1};rport`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${extension}@${domain}>;tag=${fromTag}`],
        ['To', `<sip:${line}@${domain}>;tag=${toTag}`],
        ['Call-ID', callId],
        ['CSeq', `${cseqNumber + 1} BYE`],
      ],
    });
    phone.socket.send(bye, borderPort, borderHost);
    const byeOk = await phone.waitFor(
      (message) => message.type === 'response' && message.status >= 200 && message.get('call-id') === callId,
      4000
    );
    observation.hangupStatus = byeOk?.status || 0;
    rtp.close();

    // The other half of "a must": unencrypted audio is refused, not bridged.
    const plainId = `e2e-plain-${Date.now()}@${extension}.local`;
    const plainInvite = buildRequest({
      method: 'INVITE',
      uri: `sip:${line}@${domain}`,
      headers: [
        ['Via', `SIP/2.0/UDP 127.0.0.1:${phone.socket.address().port};branch=z9hG4bK-p${cseqNumber + 2};rport`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${extension}@${domain}>;tag=plain${Date.now().toString(16)}`],
        ['To', `<sip:${line}@${domain}>`],
        ['Call-ID', plainId],
        ['CSeq', `${cseqNumber + 2} INVITE`],
        ['Contact', `<sip:${extension}@127.0.0.1:${phone.socket.address().port}>`],
        ['Content-Type', 'application/sdp'],
      ],
      body: sdpFor({ port: remotePort, crypto: '', secure: false, ssrc }),
    });
    phone.socket.send(plainInvite, borderPort, borderHost);
    const refused = await phone.waitFor(
      (message) => message.type === 'response' && message.get('call-id') === plainId && message.status >= 300,
      6000
    );
    observation.plaintextStatus = refused?.status || 0;

    if (observation.authenticated < 10) throw new Error(`only ${observation.authenticated} packets decrypted`);
    if (observation.decryptedEnergy < 200) {
      throw new Error(`decrypted audio was silent (mean amplitude ${Math.round(observation.decryptedEnergy)})`);
    }
    if (observation.cantusInboundFrames < 5) {
      throw new Error(`the switch received ${observation.cantusInboundFrames} frames from the caller`);
    }
    if (observation.plaintextStatus !== 488) {
      throw new Error(`a plaintext call was answered ${observation.plaintextStatus}, not 488`);
    }
  } catch (err) {
    observation.failure = err.message;
  } finally {
    try {
      phone.socket.close();
    } catch {
      /* already closed */
    }
    try {
      if (endpoint.tone) clearInterval(endpoint.tone);
      endpoint.ws.close();
    } catch {
      /* already closed */
    }
  }

  console.log(JSON.stringify(observation, null, 2));
  if (observation.failure) {
    console.error(`[e2e] FAIL ${observation.failure}`);
    process.exit(1);
  }
  console.log('[e2e] RESULT: an SRTP call completed end to end and a plaintext call was refused');
}

main().catch((err) => {
  observation.failure = err.message;
  console.log(JSON.stringify(observation, null, 2));
  console.error(`[e2e] FAIL ${err.message}`);
  process.exit(1);
});
