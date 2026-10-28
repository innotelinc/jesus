import { createHmac, randomBytes } from 'node:crypto';
import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { CALLER_ID_MODES, VOICE_MASKS, scifPolicy } from '../lib/scif.js';
import { takeVoiceTicket, voiceGate } from '../lib/voiceprint.js';
import { devicesFor, maybeRingForDial, maybeRingForParkedCall, pushStatus, registerDevice, removeDevice, ringExtension } from '../lib/push.js';
import { normalizeNumber } from '../lib/e164.js';
import { applyAfterChange } from '../telephony/index.js';
import { badRequest, forbidden, notFound, voiceRequired } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { tlsFingerprint, tlsPaths } from '../telephony/provision.js';
import { ami } from '../telephony/ami.js';
import { relayUrlFor } from '../telephony/wssRelay.js';
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

/**
 * The host in a WebSocket URL, without its port or path.
 *
 * A SIP domain is a name, nothing else: when this container relays the socket the
 * URL is same-origin and carries a path, and `host/ws` used as a domain is a
 * registration Asterisk refuses.
 */
const wsHostOf = (url) => hostOf(String(url || '').replace(/^wss?:\/\//, '').split('/')[0]);

/** SIP identity of the browser endpoint for an extension (see pjsip.conf). */
const webrtcUser = (extension) => `webrtc-${String(extension).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)}`;

function publicWssUrl(request) {
  if (config.softphone.wssUrl) return config.softphone.wssUrl;
  const host = hostOf(request.headers['x-forwarded-host'] || request.headers.host) || 'localhost';
  // Same origin while the app relays the socket: that name is served by the
  // certificate the browser is already on. The switch's own port presents the
  // certificate Asterisk was given, which is self-signed on a fresh install and
  // which a browser refuses for a WebSocket without offering a way past it.
  if (config.softphone.relay) return relayUrlFor(host);
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

function extensionFor(value, account) {
  const text = v.str(value, { name: 'extension', max: 12, required: true });
  const row = db_.get('SELECT * FROM extensions WHERE extension = ?', [text]);
  if (!row) throw notFound(`Extension ${text} does not exist`);
  if (!row.enabled) throw badRequest(`Extension ${text} is disabled`);
  // A session hands over the endpoint's own SIP secret, so a customer may only
  // mint one for a line that belongs to them. Staff hold the whole switch and
  // are not narrowed here.
  if ((account?.account_kind || 'staff') === 'customer' && row.account_id !== account.id) {
    throw forbidden(`Extension ${text} is not on your account`);
  }
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

/** The roster an account is allowed to see: everyone for staff, own lines only. */
function visibleOperators(account) {
  const all = [...operators.values()];
  if ((account?.account_kind || 'staff') !== 'customer') return all.map(publicOperator);
  const mine = new Set(
    db_.all('SELECT extension FROM extensions WHERE account_id = ?', [account.id]).map((row) => row.extension)
  );
  return all.filter((op) => mine.has(op.extension)).map(publicOperator);
}

const presence = () => ({ type: 'presence', operators: [...operators.values()].map(publicOperator) });

/* ------------------------------------------------------- line signaling -- */

/**
 * Asterisk's Dial and parking events tell every operator which extension is
 * ringing now, and which calls are waiting in a space.
 */
let dialWired = false;

function wireDialEvents() {
  if (dialWired) return;
  dialWired = true;
  ami().on('event', (msg) => {
    // A call arriving on a push-enabled line is parked once the desk phone and
    // any open browser have had their turn; the park is what the phone answers.
    if (msg.Event === 'ParkedCall' || msg.Event === 'ParkedCallTimeOut' || msg.Event === 'ParkedCallGiveUp' || msg.Event === 'UnParkedCall') {
      const extension = String(msg.ParkeeExten || '').trim();
      const space = String(msg.ParkingSpace || '').trim();
      if (!extension || !space) return;
      // Only a call parked out of `internal` is a call for a line; parking from
      // anywhere else has its own meaning and no phone to ring.
      if (msg.ParkeeContext && msg.ParkeeContext !== 'internal') return;
      const caller = msg.ParkeeCallerIDNum || msg.ParkeeCallerID || '';
      const phase =
        msg.Event === 'ParkedCall'
          ? 'parked'
          : msg.Event === 'UnParkedCall'
            ? 'answered'
            : 'ended';
      broadcast({
        type: 'line',
        extension,
        phase,
        space,
        caller,
        at: new Date().toISOString(),
      });
      if (phase === 'parked') {
        const live = new Set([...operators.values()].map((op) => op.extension));
        maybeRingForParkedCall({
          extension,
          space,
          // Asterisk spells this `Parkinglot`, one word; accepting both keeps a
          // future rename from silently dropping the lot name.
          lot: msg.Parkinglot || msg.ParkingLot || '',
          caller,
          liveExtensions: live,
        }).catch((err) => {
          console.error(`[push] ringing ${extension} for space ${space} failed: ${err.message}`);
        });
      }
      return;
    }

    if (msg.Event !== 'Dial' || !msg.Destination) return;
    const match = EXTENSION_REF.exec(msg.Destination);
    if (!match) return;
    const extension = match[1];
    const phase = msg.SubEvent === 'Begin' ? 'ringing' : msg.DialStatus === 'ANSWER' ? 'answered' : 'ended';
    broadcast({ type: 'line', extension, phase, caller: msg.CallerIDNum || '', at: new Date().toISOString() });

    // A ringing line with no live socket is a phone in somebody's pocket. A VoIP
    // push is the only thing that can make it ring through a locked screen, and
    // the app is what draws the call — so this is fire-and-forget: a failed push
    // must never slow down the switch.
    if (phase === 'ringing') {
      const live = new Set([...operators.values()].map((op) => op.extension));
      maybeRingForDial({ extension, caller: msg.CallerIDNum || '', liveExtensions: live }).catch((err) => {
        console.error(`[push] ringing ${extension} failed: ${err.message}`);
      });
    }
  });
}

/* ---------------------------------------------------------------- routes -- */

/**
 * Follow the switch's line events from boot, not from the first browser.
 *
 * The push that rings a parked call is driven by these events, so wiring them
 * inside the WebSocket handler meant a call parked before anybody opened a
 * softphone rang nobody at all — which is exactly the call a locked phone is
 * supposed to catch.
 */
export const startLineEvents = () => wireDialEvents();

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
      // How the browser is being told to reach the switch, so the screen can be
      // accurate about what to fix when nothing answers.
      relay: config.softphone.relay,
      wssPort: config.softphone.wssPort,
      video: config.softphone.video,
      tls: { ready: tls.ready, fingerprint: tlsFingerprint() },
      ice: {
        stun: config.softphone.stunUrls,
        turn: config.softphone.turnUrls.length > 0,
        relay: config.softphone.turnUrls.length > 0 && !!config.softphone.turnSecret,
      },
      recordingDir: config.softphone.recordingDir,
      ticketTtlSec: config.softphone.ticketTtlSec,
      // Voice on the line: recognition is the client's (free, on-device) and the
      // voiceprint is this server's. A line can require a check before a session.
      voice: { recognition: config.voice.recognition, auth: config.voice.authEnabled },
      // Enough to explain "why doesn't my phone ring", and no more: the device
      // list is per account, below.
      push: (({ enabled, configured, problem, environment, ringOnDial, parking }) => ({
        enabled,
        configured,
        problem,
        environment,
        ringOnDial,
        // An unanswered call waits in this lot so the phone can take it; the
        // console says where, because "parked in 7003" is the actionable part.
        parking,
      }))(pushStatus()),
      // Presence is a switch-wide roster: a customer sees their own lines, not
      // the staff directory they happen to be sharing a switch with.
      operators: visibleOperators(request.account),
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
    const account = request.account;
    const extension = extensionFor(request.body?.extension, account);

    // A line that requires a voiceprint hands out no SIP credentials until the
    // check has passed. The ticket is single use and tied to this account and
    // line, so a captured response cannot be replayed for a second session.
    const gate = voiceGate(extension);
    if (
      gate.enforced &&
      !takeVoiceTicket(request.body?.voiceTicket, {
        accountId: extension.account_id || account.id,
        extension: extension.extension,
      })
    ) {
      throw voiceRequired();
    }

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
        uri: `sip:${webrtcUser(extension.extension)}@${wsHostOf(wssUrl)}`,
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
      // What the browser needs to behave like a secure phone: withhold or
      // present a caller ID, refuse plaintext media, mask the voice.
      scif: scifPolicy(extension),
      // The line's voice gate, so the app knows whether this session was checked
      // and whether to ask again next time.
      voice: { ...gate, checked: gate.enforced },
    };
  });

  /**
   * Change the SCIF profile of a line.
   *
   * One route for staff and customers: the ownership check is the same one a
   * session uses, so a customer cannot arm somebody else's line. Caller ID is a
   * switch setting, so saving it regenerates and reloads the configuration
   * rather than waiting for the next unrelated change.
   */
  app.post('/softphone/scif', async (request) => {
    const account = request.account;
    const extension = extensionFor(request.body?.extension, account);
    const body = request.body || {};
    const patch = {};
    if (body.scif !== undefined) patch.scif = v.bool(body.scif) ? 1 : 0;
    if (body.callerIdMode !== undefined) {
      patch.caller_id_mode = v.oneOf(body.callerIdMode, CALLER_ID_MODES, 'callerIdMode');
    }
    if (body.callerIdNumber !== undefined) {
      const raw = v.str(body.callerIdNumber, { name: 'callerIdNumber', max: 24, required: false });
      if (!raw) patch.caller_id_number = '';
      else {
        const parsed = normalizeNumber(raw);
        if (!parsed.ok) throw badRequest('callerIdNumber must be a phone number');
        patch.caller_id_number = parsed.e164;
      }
    }
    if (body.voiceMask !== undefined) patch.voice_mask = v.oneOf(body.voiceMask, VOICE_MASKS, 'voiceMask');
    if (body.maskText !== undefined) patch.mask_text = v.bool(body.maskText) ? 1 : 0;

    const mode = patch.caller_id_mode ?? extension.caller_id_mode;
    const number = patch.caller_id_number ?? extension.caller_id_number;
    if (mode === 'custom' && !number) throw badRequest('A custom caller ID needs a number to present');
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const sets = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
    db_.run(`UPDATE extensions SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...Object.values(patch),
      now(),
      extension.id,
    ]);
    logEvent({
      actor: account.email,
      action: 'softphone.scif_updated',
      subject: extension.extension,
      detail: JSON.stringify(patch),
      ip: request.ip,
    });
    const fresh = db_.get('SELECT * FROM extensions WHERE id = ?', [extension.id]);
    const applied = await applyAfterChange(request);
    return { scif: scifPolicy(fresh), applied: applied || null };
  });

  /* ------------------------------------------------------------- push -- */

  /** The tokens registered to this account, and why a ring might not arrive. */
  app.get('/softphone/push', async (request) => {
    const extension = request.query?.extension
      ? extensionFor(request.query.extension, request.account)
      : null;
    return {
      status: pushStatus(),
      devices: devicesFor(request.account.id, extension ? extension.extension : null),
    };
  });

  /**
   * Register this phone for calls.
   *
   * The line is resolved and checked first: a customer cannot point their phone
   * at somebody else's extension, and a token already owned by another account
   * moves to this one — Apple hands the same token to one app on one phone, so a
   * handset that changes hands must stop ringing for the old owner.
   */
  app.post('/softphone/push/register', async (request) => {
    const extension = extensionFor(request.body?.extension, request.account);
    const device = registerDevice({
      accountId: extension.account_id || request.account.id,
      extension: extension.extension,
      token: request.body?.token,
      platform: v.oneOf(request.body?.platform || 'ios', ['ios', 'android'], 'platform'),
      bundleId: v.str(request.body?.bundleId, { name: 'bundleId', max: 120, required: false }),
      environment: request.body?.environment === 'production' ? 'production' : 'development',
      deviceName: v.str(request.body?.deviceName, { name: 'deviceName', max: 60, required: false }),
      appVersion: v.str(request.body?.appVersion, { name: 'appVersion', max: 20, required: false }),
    });
    logEvent({
      actor: request.account.email,
      action: 'softphone.push_registered',
      subject: extension.extension,
      detail: device.platform,
      ip: request.ip,
    });
    // Registering a phone changes how a call to this line is delivered: the line
    // becomes park-capable, so the dialplan is regenerated now rather than on the
    // next unrelated edit.
    const applied = await applyAfterChange(request);
    return { device, status: pushStatus(), applied: applied || null };
  });

  /** Forget a phone: signing out, or a lost handset. */
  app.post('/softphone/push/remove', async (request) => {
    const removed = removeDevice(request.account.id, request.body?.token);
    if (!removed) throw notFound('That device is not registered to this account');
    logEvent({ actor: request.account.email, action: 'softphone.push_removed', ip: request.ip });
    const applied = await applyAfterChange(request);
    return { removed: true, devices: devicesFor(request.account.id), applied: applied || null };
  });

  /**
   * Ring a line on purpose: the test button in the app, and the manual ring an
   * operator wants while a call is already in the switch. The ownership check is
   * the same one a session uses, so it cannot ring somebody else's phone.
   */
  app.post('/softphone/push/ring', async (request) => {
    const extension = extensionFor(request.body?.extension, request.account);
    if (!config.apns.enabled) {
      throw badRequest('Apple push is not configured on this platform (APNS_ENABLED=false)');
    }
    const result = await ringExtension(extension.extension, {
      display: 'SCIF test call',
      video: !!request.body?.video,
    });
    if (!result.devices) {
      return { ...result, hint: 'Install the SCIF app on a phone and sign in on this line first' };
    }
    return result;
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
