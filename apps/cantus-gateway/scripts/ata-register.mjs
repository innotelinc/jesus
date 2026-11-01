#!/usr/bin/env node
/**
 * A SIP analog telephone adapter registering at the border.
 *
 *   node scripts/ata-register.mjs [host:port] [ext] [password]
 *
 * Defaults: 127.0.0.1:5060, ext 101, the password in SIP_ATA_USERS for that
 * extension. It speaks REGISTER over UDP exactly as a handset does — challenge,
 * digest, 200 — so a success here means a real ATA can register, not that a
 * function returns true.
 */

import dgram from 'node:dgram';
import { parseMessage, buildRequest, digestResponse } from '../src/sip.js';

const target = process.argv[2] || process.env.SIP_ATA_TARGET || '127.0.0.1:5060';
const ext = process.argv[3] || process.env.SIP_ATA_EXT || '101';
const fromEnv = (process.env.SIP_ATA_USERS || '')
  .split(',')
  .map((pair) => pair.split(':'))
  .find(([user]) => user === ext);
const password = process.argv[4] || (fromEnv ? fromEnv.slice(1).join(':') : '');
const [host, portText] = target.split(':');
const port = Number(portText || 5060);
const localPort = Number(process.env.SIP_ATA_LOCAL_PORT || 0);

if (!password) {
  console.error(`[ata] no password for ext ${ext}: set SIP_ATA_USERS=${ext}:<password>`);
  process.exit(2);
}

const socket = dgram.createSocket('udp4');
const callId = `ata-${Date.now()}@${ext}.local`;
const fromTag = `ata${Date.now().toString(16)}`;
let cseq = 1;
let nonceCount = 1;

function registerRequest(authorization) {
  const headers = [
    ['Via', `SIP/2.0/UDP 0.0.0.0:${socket.address().port};branch=z9hG4bK${cseq}${Date.now().toString(16)};rport`],
    ['Max-Forwards', '70'],
    ['From', `<sip:${ext}@estate.local>;tag=${fromTag}`],
    ['To', `<sip:${ext}@estate.local>`],
    ['Call-ID', callId],
    ['CSeq', `${cseq} REGISTER`],
    ['Contact', `<sip:${ext}@0.0.0.0:${socket.address().port}>;expires=300`],
    ['Expires', '300'],
    ['User-Agent', 'cantus-ata/1.0'],
  ];
  if (authorization) headers.push(['Authorization', authorization]);
  return buildRequest({ method: 'REGISTER', uri: `sip:estate.local`, headers });
}

function authParams(header) {
  const params = {};
  for (const match of String(header).matchAll(/([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return params;
}

function send() {
  const bytes = registerRequest(authorization);
  cseq += 1;
  socket.send(bytes, port, host);
  return bytes.length;
}

let authorization = '';

socket.bind(localPort, '0.0.0.0', () => {
  console.log(`[ata] registering ${ext} at ${host}:${port} from local port ${socket.address().port}`);
  send();
});

const timer = setTimeout(() => {
  console.error('[ata] FAIL no answer from the border within 5 s');
  process.exit(1);
}, 5000);

socket.on('message', (buf) => {
  const message = parseMessage(buf.toString('utf8'));
  if (message.type !== 'response') return;
  if (message.status === 401 || message.status === 407) {
    const challenge = authParams(message.get('www-authenticate') || message.get('proxy-authenticate'));
    authorization = digestResponse({
      username: ext,
      password,
      realm: challenge.realm || 'estate.local',
      nonce: challenge.nonce || '',
      uri: `sip:estate.local`,
      method: 'REGISTER',
      qop: challenge.qop ? 'auth' : undefined,
      nc: String(nonceCount).padStart(8, '0'),
      cnonce: `ata${nonceCount}`,
      opaque: challenge.opaque,
    });
    nonceCount += 1;
    console.log(`[ata] challenged (${message.status}), answering with digest`);
    send();
    return;
  }
  clearTimeout(timer);
  if (message.status >= 200 && message.status < 300) {
    const expires = message.get('expires') || '';
    console.log(`[ata] ok   REGISTER accepted: ${message.status} ${message.reason} expires=${expires || '300'}`);
    console.log(`[ata] RESULT: ${ext} registered at the border`);
    socket.close();
    process.exit(0);
  }
  console.error(`[ata] FAIL ${message.status} ${message.reason}`);
  socket.close();
  process.exit(1);
});

socket.on('error', (err) => {
  console.error(`[ata] FAIL ${err.message}`);
  process.exit(1);
});
