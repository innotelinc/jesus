/**
 * cantus-gateway: the process.
 *
 * One Cantus endpoint (the switch talks to this), one SIP trunk (the carrier
 * talks to this), and an HTTP status surface so an operator can see which half
 * is up without reading logs.
 *
 * Configuration is environment only, the same as the switch: a gateway is a
 * deployment artifact, not a framework.
 */

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';

import { CantusEndpoint } from '../../cantus-switch/src/endpoint.js';
import { SipTrunk } from './sip.js';
import { Gateway } from './gateway.js';

const env = process.env;
const arg = (name, fallback = '') => (env[name] === undefined || env[name] === '' ? fallback : env[name]);
const num = (name, fallback) => {
  const value = Number(arg(name, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function firstPublicAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

const log = (entry) => {
  const stamp = new Date().toISOString();
  const { kind, ...rest } = entry;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
  console.log(`[gateway] ${stamp} ${kind}${detail ? ` ${detail}` : ''}`);
};

const domain = arg('CANTUS_DOMAIN', 'estate.local');
const statusPort = num('GATEWAY_HTTP_PORT', 7454);
const advertise = arg('SIP_ADVERTISE', '') || firstPublicAddress();

/**
 * Where the operator's choice of encryption is remembered.
 *
 * `SIP_SRTP` in the environment is the value a deployment starts with. Once
 * somebody flips the switch from the console, that choice is written here and
 * wins on the next boot — otherwise a restart would quietly restore encryption
 * the carrier has already been told to stop expecting, and every call would be
 * refused with 488 until somebody noticed why.
 */
const srtpStateFile = arg('SRTP_STATE_FILE', '');

function storedSrtp() {
  if (!srtpStateFile) return null;
  try {
    const parsed = JSON.parse(readFileSync(srtpStateFile, 'utf8'));
    return typeof parsed?.srtp === 'boolean' ? parsed.srtp : null;
  } catch {
    return null; // absent or unreadable is "no opinion", not an error
  }
}

function rememberSrtp(enabled) {
  if (!srtpStateFile) return;
  try {
    mkdirSync(dirname(srtpStateFile), { recursive: true });
    writeFileSync(srtpStateFile, `${JSON.stringify({ srtp: enabled, at: new Date().toISOString() })}\n`);
  } catch (err) {
    log({ kind: 'srtp-state-unwritable', file: srtpStateFile, detail: err.message });
  }
}

const endpoint = new CantusEndpoint({
  id: arg('CANTUS_ID', `voipms@gateway`),
  secret: arg('CANTUS_SECRET', 'cantus-loopback'),
  bind: arg('CANTUS_BIND', '0.0.0.0:7453'),
  advertise: arg('CANTUS_ADVERTISE', ''),
  relay: arg('CANTUS_RELAY', '') || undefined,
  onEvent: (event) => {
    if (['error', 'auth-fail', 'rejected', 'register-sent'].includes(event.kind) && event.kind !== 'register-sent') {
      log({ kind: `cantus-${event.kind}`, ...event });
    }
  },
});

const carrierHost = arg('SIP_HOST', '');
const TRUNK_STUB = {
  // The surface the gateway uses, for a deployment with no carrier yet. Every
  // call is refused with a reason, and nothing pretends to be registered.
  host: '',
  port: 0,
  bound: 0,
  registered: false,
  registerExpiresAt: 0,
  lastRegisterError: 'SIP_HOST is empty',
  onInvite: () => {},
  onBye: () => {},
  onCancel: () => {},
  invite: () => ({ state: 'ended', callId: '' }),
  answer: () => false,
  reject: () => {},
  bye: () => {},
  stop: () => {},
};

const trunk = carrierHost
  ? new SipTrunk({
      host: carrierHost,
      port: num('SIP_PORT', 5060),
      username: arg('SIP_USERNAME', ''),
      password: arg('SIP_PASSWORD', ''),
      // The number this trunk presents, which is the trunk's own DID: a carrier
      // that honours From shows the line the call was placed from.
      fromUser: arg('SIP_FROM_USER', ''),
      domain: arg('SIP_DOMAIN', ''),
      contactHost: advertise,
      localPort: num('SIP_LOCAL_PORT', 0),
      registerSeconds: num('SIP_REGISTER_SECONDS', 300),
      onLog: (entry) => log({ ...entry, source: 'sip' }),
    })
  : TRUNK_STUB;

/** A tiny body reader: the status port takes one small JSON object and nothing else. */
function readJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

let gateway;

async function main() {
  // No carrier configured is a state, not a crash: the estate keeps running,
  // the switch keeps routing, and every PSTN attempt fails with a cause the
  // console can show. A restart loop would hide that behind a healthcheck.
  if (!trunk.host) {
    log({ kind: 'no-carrier', detail: 'SIP_HOST is empty: PSTN calls are refused, nothing will register' });
  }
  await endpoint.start();
  endpoint.onEvent = (event) => {
    if (event.kind === 'error' || event.kind === 'auth-fail') log({ kind: `cantus-${event.kind}`, ...event });
    gateway?.onEndpointEvent(event);
  };

  gateway = new Gateway({
    endpoint,
    trunk,
    switchId: arg('CANTUS_SWITCH', `switch@${domain}`),
    domain,
    advertise,
    carrier: !!trunk.host,
    // SIP_SRTP=on offers and answers RTP/SAVP with an SDES key. Off is plain
    // RTP; a sub-account that requires encryption refuses that with 488. A
    // value set from the console wins over the environment, because the
    // carrier's own setting was changed to match it.
    srtp: storedSrtp() ?? /^(1|on|true|yes)$/i.test(arg('SIP_SRTP', '')),
    rtpStart: num('GATEWAY_RTP_START', 40000),
    rtpEnd: num('GATEWAY_RTP_END', 40063),
    log: (entry) => log(entry),
  });

  if (trunk.host) await trunk.start();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/srtp') {
      // The console's switch. GET is what the console polls for live state;
      // POST is the change, and it applies to the next call rather than to one
      // already in flight.
      if (request.method === 'GET') {
        send(200, { enabled: gateway.srtp, registered: !!trunk.registered });
        return;
      }
      if (request.method === 'POST') {
        const body = await readJson(request);
        const enabled = typeof body?.enabled === 'boolean' ? body.enabled : /^(1|on|true|yes)$/i.test(String(body?.enabled ?? ''));
        if (body?.enabled === undefined) {
          send(400, { error: 'enabled is required (true or false)' });
          return;
        }
        const applied = gateway.setSrtp(enabled);
        rememberSrtp(applied);
        send(200, { ok: true, enabled: applied, registered: !!trunk.registered });
        return;
      }
      send(405, { error: 'GET or POST' });
      return;
    }
    if (url.pathname === '/healthz') {
      // Healthy means both halves are usable, which is the only question an
      // operator has: Cantus reachable and the trunk registered.
      const configured = !!trunk.host;
      const ok = configured && !!trunk.registered && !!endpoint.localAddr;
      send(ok ? 200 : 503, {
        ok,
        configured,
        registered: !!trunk.registered,
        cantus: endpoint.localAddr || '',
        reason: ok
          ? ''
          : !configured
            ? 'SIP_HOST is empty: set the carrier SIP server and sub-account credentials'
            : !trunk.registered
              ? trunk.lastRegisterError || 'not registered yet'
              : 'cantus socket not bound',
      });
      return;
    }
    if (url.pathname === '/status') {
      send(200, gateway.status());
      return;
    }
    send(404, { error: 'not found' });
  });
  server.listen(statusPort, '0.0.0.0', () => log({ kind: 'status-listening', port: statusPort, advertise, trunk: trunk.host }));
}

const shutdown = () => {
  log({ kind: 'stopping' });
  try {
    trunk.stop();
  } catch {
    /* already stopped */
  }
  try {
    endpoint.stop();
  } catch {
    /* already stopped */
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error(`[gateway] fatal: ${err.message}`);
  process.exit(1);
});
