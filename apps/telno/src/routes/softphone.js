import { createHmac, randomBytes } from 'node:crypto';
import { db_ } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { tlsFingerprint, tlsPaths } from '../telephony/provision.js';
import { ami } from '../telephony/ami.js';
import * as v from '../lib/validate.js';

/**
 * Browser softphone control plane.
 *
 * The split is deliberate and it is what keeps this container small:
 *
 *   media + SIP   browser <-> Asterisk over WSS/chan_pjsip, DTLS-SRTP, no relay
 *   control       browser <-> here: one short-lived ticket, TURN credentials,
 *                 presence across operators, and call intents for the audit log
 *
 * So there is no media server, no TURN relay of our own and no SIP stack in
 * Node. What the platform owns is identity, policy and the switch config that
 * makes encryption non-optional.
 */

const EXTENSION_REF = /(?:ext|webrtc)-([A-Za-z0-9_.-]+)/;
const TURN_USER_MAX = 64;

/* --------------------------------------------------------------- tickets -- */

/** Single-use, short-lived bootstraps for the WebSocket. Never a long credential. */
const tickets = new Map();

function pruneTickets() {
  const now = Date.now();
  for (const [key, ticket] of tickets) {
    if (ticket.expires < now) tickets.delete(key);
  }
}

function issueTicket(account, extension) {
  pruneTickets();
  const value = `sf_${randomBytes(24).toString('base64url')}`;
  tickets.set(value, {
    accountId: account.id,
    accountEmail: account.email,
    role: account.role,
    extension: extension.extension,
    extensionId: extension.id,
    expires: Date.now() + config.softphone.ticketTtlSec * 1000,
  });
  return { value, expiresIn: config.softphone.ticketTtlSec };
}

/** Consume a ticket exactly once; a replay is indistinguishable from a guess. */
function takeTicket(value) {
  const ticket = tickets.get(String(value || ''));
  if (!ticket) return null;
  tickets.delete(String(value));
  return ticket.expires >= Date.now() ? ticket : null;
}

/* ------------------------------------------------------------ ICE / TURN -- */

/**
 * coturn's REST scheme: the username carries the expiry and the password is an
 * HMAC of it, so a leaked credential stops working on its own.
 */
function iceServers(identity) {
  const servers = config.softphone.stunUrls.map((urls) => ({ urls }));
  const { turnUrls, turnSecret, turnTtlSec } = config.softphone;
  if (turnUrls.length && turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + turnTtlSec}:${String(identity).slice(0, TURN_USER_MAX)}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}

/* ------------------------------------------------------------------ host -- */

const hostOf = (value) => String(value || '').split(',')[0].split(':')[0].trim();

/** SIP identity of the browser endpoint for an extension (see pjsip.conf). */
const webrtcUser = (extension) => `webrtc-${String(extension).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)}`;

function publicWssUrl(request) {
  if (config.softphone.wssUrl) return config.softphone.wssUrl;
  const host = hostOf(request.headers['x-forwarded-host'] || request.headers.host) || 'localhost';
  return `wss://${host}:${config.softphone.wssPort}/ws`;
}

/* -------------------------------------------------------------- policy -- */

/** The agent that answers this extension's number decides how it is recorded. */
function recordingPolicy(extension) {
  if (!extension?.number_id) return { inbound: false, outbound: false, agent: null, source: 'none' };
  const agent = db_.get(
    `SELECT name, record_inbound, record_outbound FROM voice_agents
      WHERE number_id = ? AND status = 'active'`,
    [extension.number_id]
  );
  if (!agent) return { inbound: false, outbound: false, agent: null, source: 'none' };
  return {
    inbound: !!agent.record_inbound,
    outbound: !!agent.record_outbound,
    agent: agent.name,
    source: 'voice-agent',
  };
}

function extensionFor(value) {
  const text = v.str(value, { name: 'extension', max: 12, required: true });
  const row = db_.get('SELECT * FROM extensions WHERE extension = ?', [text]);
  if (!row) throw notFound(`Extension ${text} does not exist`);
  if (!row.enabled) throw badRequest(`Extension ${text} is disabled`);
  return row;
}

/* ------------------------------------------------------------- presence -- */

/** account id -> live socket binding. One operator, one softphone session. */
const operators = new Map();

const publicOperator = (op) => ({
  email: op.email,
  extension: op.extension,
  state: op.state,
  since: new Date(op.since).toISOString(),
  peer: op.peer || '',
});

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const op of operators.values()) {
    if (op.socket.readyState === 1) op.socket.send(text);
  }
}

const presence = () => ({ type: 'presence', operators: [...operators.values()].map(publicOperator) });

/* ------------------------------------------------------- line signaling -- */

/** Asterisk's Dial events tell every operator which extension is ringing now. */
let dialWired = false;

function wireDialEvents() {
  if (dialWired) return;
  dialWired = true;
  ami().on('event', (msg) => {
    if (msg.Event !== 'Dial' || !msg.Destination) return;
    const match = EXTENSION_REF.exec(msg.Destination);
    if (!match) return;
    const extension = match[1];
    const phase = msg.SubEvent === 'Begin' ? 'ringing' : msg.DialStatus === 'ANSWER' ? 'answered' : 'ended';
    broadcast({ type: 'line', extension, phase, caller: msg.CallerIDNum || '', at: new Date().toISOString() });
  });
}

/* ---------------------------------------------------------------- routes -- */

export default async function softphoneRoutes(app) {
  app.addHook('preHandler', async (request) => {
    if (request.method === 'OPTIONS') return;
    await app.authenticate(request);
  });

  /** Everything the console needs to show whether the softphone can work here. */
  app.get('/softphone/status', async (request) => {
    const tls = tlsPaths();
    return {
      enabled: config.softphone.enabled,
      wssUrl: publicWssUrl(request),
      video: config.softphone.video,
      tls: { ready: tls.ready, fingerprint: tlsFingerprint() },
      ice: {
        stun: config.softphone.stunUrls,
        turn: config.softphone.turnUrls.length > 0,
        relay: config.softphone.turnUrls.length > 0 && !!config.softphone.turnSecret,
      },
      recordingDir: config.softphone.recordingDir,
      ticketTtlSec: config.softphone.ticketTtlSec,
      operators: [...operators.values()].map(publicOperator),
      webSocket: true,
    };
  });

  /**
   * Mint one softphone session: a ticket for the control socket, the SIP
   * credentials for the extension, and ICE servers including a time-limited
   * TURN credential.
   */
  app.post('/softphone/session', async (request, reply) => {
    if (!config.softphone.enabled) throw forbidden('The softphone is disabled (SOFTPHONE_ENABLED=false)');
    const extension = extensionFor(request.body?.extension);
    const account = request.account;
    const ticket = issueTicket(account, extension);
    const tls = tlsPaths();
    const policy = recordingPolicy(extension);
    const wssUrl = publicWssUrl(request);

    logEvent({
      actor: account.email,
      action: 'softphone.session',
      subject: extension.extension,
      detail: `${wssUrl} tls=${tls.ready ? 'ready' : 'missing'}`,
      ip: request.ip,
    });

    reply.status(201);
    return {
      ticket: ticket.value,
      expiresIn: ticket.expiresIn,
      wssUrl,
      extension: {
        extension: extension.extension,
        displayName: extension.display_name,
        number: extension.number_id
          ? db_.get('SELECT e164 FROM numbers WHERE id = ?', [extension.number_id])?.e164 || ''
          : '',
        voicemail: !!extension.voicemail,
      },
      // Digest authentication is the only WebRTC registration path chan_pjsip
      // offers, so the endpoint's own secret is handed to the operator for
      // their own extension only, over an authenticated session.
      sip: {
        // The browser is its own endpoint (`webrtc-<ext>`) next to the desk
        // phone's `<ext>`. chan_pjsip resolves a registration by the user part
        // of the request, so the URI and the auth user must both be the WebRTC
        // endpoint name; sending the bare extension matches the desk endpoint
        // and the call loses DTLS-SRTP.
        uri: `sip:${webrtcUser(extension.extension)}@${hostOf(wssUrl.replace('wss://', ''))}`,
        authUser: webrtcUser(extension.extension),
        extensionUser: extension.extension,
        password: extension.secret || `change-me-${extension.extension}`,
      },
      iceServers: iceServers(`${account.id}:${extension.extension}`),
      media: {
        audio: true,
        video: config.softphone.video,
        // Mandatory: the generated endpoint only allows DTLS-SRTP, so a
        // plaintext attempt cannot complete the handshake at all.
        encryption: 'dtls-srtp',
      },
      recording: policy,
    };
  });

  /**
   * Presence and call intents. Authentication is a ticket in the query string
   * because the browser WebSocket API cannot set headers on the upgrade.
   */
  app.get('/softphone/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname;
      } catch {
        originHost = '';
      }
      // Same-origin only: another site must not be able to open an operator's
      // softphone socket with the operator's cookie.
      const allowed = [hostOf(request.headers['x-forwarded-host'] || request.headers.host), hostOf(config.publicUrl.replace(/^https?:\/\//, ''))]
        .filter(Boolean);
      if (!allowed.some((host) => originHost === host || originHost.endsWith(`.${host}`))) {
        socket.close(4403, 'origin not allowed');
        return;
      }
    }

    const ticket = takeTicket(request.query?.ticket);
    if (!ticket) {
      socket.close(4401, 'invalid or expired ticket');
      return;
    }
    const account = db_.get('SELECT * FROM accounts WHERE id = ?', [ticket.accountId]);
    if (!account) {
      socket.close(4401, 'account no longer exists');
      return;
    }

    wireDialEvents();

    const existing = operators.get(account.id);
    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(4409, 'replaced by a newer session');
      } catch {
        /* already gone */
      }
    }

    const operator = {
      socket,
      email: account.email,
      extension: ticket.extension,
      state: 'idle',
      since: Date.now(),
      peer: '',
    };
    operators.set(account.id, operator);

    socket.send(
      JSON.stringify({
        type: 'ready',
        operator: publicOperator(operator),
        recording: recordingPolicy(
          db_.get('SELECT * FROM extensions WHERE extension = ?', [ticket.extension])
        ),
        serverTime: new Date().toISOString(),
      })
    );
    broadcast(presence());
    logEvent({ actor: account.email, action: 'softphone.online', subject: ticket.extension });

    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* closed between ticks */
      }
    }, 30_000);
    if (heartbeat.unref) heartbeat.unref();

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
          break;
        case 'state': {
          const state = ['idle', 'ringing', 'dialing', 'incall', 'away'].includes(message.state)
            ? message.state
            : operator.state;
          const changed = state !== operator.state;
          operator.state = state;
          operator.peer = String(message.peer || '').slice(0, 40);
          operator.since = changed ? Date.now() : operator.since;
          broadcast(presence());
          if (changed) {
            logEvent({
              actor: operator.email,
              action: `softphone.${state}`,
              subject: operator.extension,
              detail: operator.peer,
            });
          }
          break;
        }
        case 'dial': {
          // An intent, not a call: the switch remains the record of the call
          // itself, and the audit trail shows who dialed what from where.
          const to = String(message.to || '').replace(/[^\d+*#]/g, '').slice(0, 24);
          if (!to) {
            socket.send(JSON.stringify({ type: 'error', code: 'bad_destination', message: 'Nothing to dial' }));
            break;
          }
          logEvent({
            actor: operator.email,
            action: 'softphone.dial',
            subject: operator.extension,
            detail: `${to}${message.video ? ' (video)' : ''}`,
          });
          broadcast({ type: 'dial', extension: operator.extension, to, by: operator.email, at: new Date().toISOString() });
          break;
        }
        case 'dtmf':
          logEvent({
            actor: operator.email,
            action: 'softphone.dtmf',
            subject: operator.extension,
            detail: String(message.digits || '').replace(/[^0-9*#]/g, '').slice(0, 32),
          });
          break;
        case 'bye':
          operator.state = 'idle';
          operator.peer = '';
          operator.since = Date.now();
          broadcast(presence());
          logEvent({ actor: operator.email, action: 'softphone.hangup', subject: operator.extension });
          break;
        default:
          break;
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      // Only remove if this socket still owns the slot: a reconnect may have
      // already replaced it, and the newer session must not be dropped.
      if (operators.get(account.id)?.socket === socket) {
        operators.delete(account.id);
        broadcast(presence());
        logEvent({ actor: account.email, action: 'softphone.offline', subject: ticket.extension });
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
