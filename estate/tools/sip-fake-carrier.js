#!/usr/bin/env node
/**
 * A carrier in one file, for the outbound half.
 *
 * The gateway registers with whatever SIP_HOST names and sends INVITEs there,
 * so the only honest way to test an outbound call before a real carrier account
 * exists is to be that carrier: challenge the REGISTER (digest, the way voip.ms
 * does), accept it, then answer every INVITE with PCMU and play a tone back.
 *
 *   docker run ... # or, on the box:  node sip-fake-carrier.js --port 5070
 *   # then point the gateway at it:
 *   VOIPMS_SIP_HOST=<box ip>  VOIPMS_SIP_PORT=5070  VOIPMS_SIP_USERNAME=101  VOIPMS_SIP_PASSWORD=secret
 *
 * It prints every request it receives, so a refused call is visible here too.
 */

import dgram from 'node:dgram';
import { createHash, randomUUID } from 'node:crypto';

const CRLF = '\r\n';
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const port = Number(flag('port', '5070'));
const realm = flag('realm', 'fake.carrier');
const username = flag('username', 'demo');
const password = flag('password', 'demo');
const log = (...parts) => console.log('[fake-carrier]', ...parts);

const socket = dgram.createSocket('udp4');

const md5 = (value) => createHash('md5').update(value).digest('hex');

/** Verify a digest Authorization header the way a carrier would. */
function authorized(header, method, uri) {
  if (!header) return false;
  const params = {};
  for (const match of String(header).matchAll(/([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  if (params.username !== username) return false;
  const ha1 = md5(`${username}:${params.realm}:${password}`);
  const ha2 = md5(`${method}:${params.uri || uri}`);
  const expected = params.qop
    ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
    : md5(`${ha1}:${params.nonce}:${ha2}`);
  return params.response === expected;
}

function reply(rinfo, request, status, reason, extra = [], body = '') {
  const lines = [`SIP/2.0 ${status} ${reason}`];
  for (const name of ['via', 'from', 'to', 'call-id', 'cseq']) {
    const value = request.get(name);
    if (value) lines.push(`${name.replace(/(^|-)([a-z])/g, (all) => all.toUpperCase())}: ${value}`);
  }
  for (const [name, value] of extra) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  socket.send(Buffer.from(lines.join(CRLF) + CRLF + CRLF + body, 'utf8'), rinfo.port, rinfo.address);
}

function parse(text) {
  const split = text.indexOf(CRLF + CRLF);
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 4);
  const [startLine, ...lines] = head.split(CRLF).filter(Boolean);
  const headers = lines.map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
  });
  const get = (name) => headers.find((header) => header.name === name)?.value;
  const [method, uri] = startLine.split(' ');
  return { method, uri, get, body, headers };
}

/** The audio this carrier sends: a tone the softphone can hear. */
let frame = 0;

/**
 * G.711 µ-law, which is what the gateway expects on the wire.
 *
 * The first version wrote 16-bit samples into a one-byte-per-sample packet: it
 * crashed on the 160th sample and, even if it had fitted, the gateway would
 * have decoded PCM16 as µ-law and played noise.
 */
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
function audioSocket() {
  // Bound before it is advertised: the port goes in the SDP, and a socket that
  // is still binding has no `address()` to put there. The old version guessed
  // `m=audio 40002` while the socket listened somewhere else, so every frame
  // the gateway sent landed on a closed port.
  return new Promise((resolve) => {
    const rtp = dgram.createSocket('udp4');
    rtp.bind(0, () => resolve(rtp));
  });
}

const registration = { registered: false, expires: 0 };

socket.on('message', async (buf, rinfo) => {
  const request = parse(buf.toString('utf8'));
  const callId = request.get('call-id');

  if (request.method === 'REGISTER') {
    const authorization = request.get('authorization');
    if (!authorized(authorization, 'REGISTER', `sip:${realm}`)) {
      registration.registered = false;
      reply(rinfo, request, 401, 'Unauthorized', [
        ['WWW-Authenticate', `Digest realm="${realm}", nonce="${randomUUID()}", qop="auth", algorithm=MD5`],
      ]);
      log('REGISTER challenged');
      return;
    }
    registration.registered = true;
    registration.expires = Date.now() + 300_000;
    reply(rinfo, request, 200, 'OK', [
      ['Expires', '300'],
      ['Contact', request.get('contact') || ''],
    ]);
    log('REGISTER accepted');
    return;
  }

  if (request.method === 'INVITE') {
    if (!registration.registered) {
      reply(rinfo, request, 403, 'Forbidden');
      log(`INVITE ${request.uri} refused: nothing registered`);
      return;
    }
    const media = /m=audio\s+(\d+)/.exec(request.body || '');
    const connection = /c=IN\s+IP4\s+([\d.]+)/.exec(request.body || '');
    // The port is the one the gateway offered. The address is where the INVITE
    // came *from* rather than the one in `c=`: a real carrier reaches the
    // advertised public address, while a test carrier in the same Docker
    // network that answers to the public IP gets its audio dropped at the
    // host's firewall and reports `frames in: 0` for a call that is otherwise
    // healthy. `--via-sdp` forces the SDP address for a carrier-like run.
    const audio = {
      port: Number(media?.[1] || 0),
      host: has('via-sdp') ? connection?.[1] || rinfo.address : rinfo.address,
    };
    log(`INVITE ${request.uri} answered with audio to ${audio.host}:${audio.port}`);
    reply(rinfo, request, 100, 'Trying');
    reply(rinfo, request, 180, 'Ringing');
    const rtp = await audioSocket();
    const rtpPort = rtp.address().port;
    const sdp = [
      'v=0',
      `o=fake-carrier ${Date.now()} ${Date.now()} IN IP4 ${rinfo.address}`,
      's=fake-carrier',
      `c=IN IP4 ${rinfo.address}`,
      't=0 0',
      `m=audio ${rtpPort} RTP/AVP 0`,
      'a=rtpmap:0 PCMU/8000',
      'a=ptime:20',
      'a=sendrecv',
      '',
    ].join(CRLF);
    reply(rinfo, request, 200, 'OK', [
      ['Contact', `<sip:${username}@${rinfo.address}:${port}>`],
      ['Content-Type', 'application/sdp'],
    ], sdp);
    const seq = { value: 1 };
    const timer = setInterval(() => {
      if (!audio.port) return;
      // 12-byte RTP header + 160 µ-law samples (20 ms at 8 kHz).
      const packet = Buffer.alloc(12 + 160);
      packet[0] = 0x80;
      packet[1] = 0;
      packet.writeUInt16BE(seq.value++ & 0xffff, 2);
      packet.writeUInt32BE((frame * 160) & 0xffffffff, 4);
      packet.writeUInt32BE(0xcafe0001, 8);
      for (let i = 0; i < 160; i += 1) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * (frame * 160 + i)) / 8000) * 6000);
        packet[12 + i] = ulaw(sample);
      }
      frame += 1;
      rtp.send(packet, audio.port, audio.host);
    }, 20);
    timer.unref?.();
    socket.on('close', () => clearInterval(timer));
    return;
  }

  if (request.method === 'BYE' || request.method === 'CANCEL') {
    reply(rinfo, request, 200, 'OK');
    log(`${request.method} for ${callId} acknowledged`);
    return;
  }

  if (request.method === 'ACK') return;

  if (request.method === 'OPTIONS') {
    reply(rinfo, request, 200, 'OK');
    return;
  }

  reply(rinfo, request, 405, 'Method Not Allowed');
});

socket.bind(port, '0.0.0.0', () => {
  log(`listening on udp/${port} as ${username}@${realm} (password: ${password})`);
});
