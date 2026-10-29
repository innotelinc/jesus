import { cantus } from './cantus.js';
import { writeConfigs, generateConfigs, generateRoutes, generateLines } from './provision.js';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from '../lib/audit.js';

/**
 * The telephony control plane.
 *
 * The switch owns calls; this platform owns records. Every switch event is
 * mapped onto the same `calls` table the console, the billing ladder and the
 * audit log already read, so nothing above this file had to learn a new shape
 * when the switch changed from Asterisk's AMI to Cantus.
 */

/** Live legs the switch has told us about, keyed by its call id. */
const legs = new Map();
let started = false;

const AUDIO_EXT = /\.(wav)$/i;

function recordingName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop()?.trim();
  if (!base) return '';
  return AUDIO_EXT.test(base) ? base : `${base}.wav`;
}

function track(callId, patch) {
  const existing = legs.get(callId) || { started: Date.now() };
  legs.set(callId, { ...existing, ...patch });
  if (legs.size > 500) legs.delete(legs.keys().next().value);
  return legs.get(callId);
}

function upsertCall(callId, patch) {
  const existing = db_.get('SELECT id FROM calls WHERE call_id = ?', [callId]);
  if (!existing) {
    const id = newId('cal_');
    db_.run(
      `INSERT INTO calls (id, call_id, direction, from_number, to_number, extension, trunk,
                          started_at, answered_at, ended_at, duration, billsec, disposition,
                          hangup_cause, recording, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        callId,
        patch.direction || 'inbound',
        patch.from_number || '',
        patch.to_number || '',
        patch.extension || '',
        patch.trunk || '',
        patch.started_at || now(),
        patch.answered_at || null,
        patch.ended_at || null,
        patch.duration || 0,
        patch.billsec || 0,
        patch.disposition || 'unknown',
        patch.hangup_cause || '',
        patch.recording || '',
        patch.cost || 0,
      ]
    );
    return id;
  }
  // An undefined value means "this source has no opinion"; an empty one is a
  // deliberate clear. Writing every undefined would let a CDR wipe the
  // recording a MixMonitor-equivalent event already attached.
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length) db_.run(`UPDATE calls SET ${sets.join(', ')} WHERE call_id = ?`, [...values, callId]);
  return existing.id;
}

/** Which way a call went, decided from the address the switch was asked for. */
function directionFor(call) {
  if (call.direction === 'outbound') return 'outbound';
  if (call.direction === 'inbound') return 'inbound';
  const to = String(call.to || '');
  if (to.startsWith('+') || /^1\d{10}@/.test(to)) return 'outbound';
  return 'internal';
}

function extensionOf(address) {
  const [user] = String(address || '').split('@');
  return /^\d{1,6}$/.test(user) ? user : '';
}

function onEvent(event) {
  try {
    const call = event.callId ? legs.get(event.callId) || { id: event.callId } : null;
    switch (event.type) {
      case 'call.incoming':
      case 'call.originated': {
        track(event.callId, {
          from: event.from,
          to: event.to,
          direction: event.direction || 'inbound',
          started: Date.now(),
        });
        upsertCall(event.callId, {
          direction: directionFor(event),
          from_number: String(event.from || ''),
          to_number: String(event.to || ''),
          extension: extensionOf(event.to),
          started_at: new Date(event.at || Date.now()).toISOString(),
          disposition: 'ringing',
        });
        break;
      }
      case 'call.answered': {
        const info = track(event.callId, { answered: Date.now() });
        upsertCall(event.callId, {
          answered_at: new Date(event.at || Date.now()).toISOString(),
          disposition: 'answered',
          extension: event.ext || extensionOf(info.to),
        });
        break;
      }
      case 'call.recording':
      case 'call.recorded': {
        const name = recordingName(event.file);
        if (name) track(event.callId, { recording: name });
        break;
      }
      case 'call.ended':
      case 'call.failed': {
        const info = legs.get(event.callId) || call || {};
        const endedAt = Date.now();
        const startedAt = info.started || endedAt;
        const answeredAt = info.answered || null;
        const duration = Math.max(0, Math.round((endedAt - startedAt) / 1000));
        const billsec = answeredAt ? Math.max(0, Math.round((endedAt - answeredAt) / 1000)) : 0;
        const cause = event.cause || event.reason || 'normal';
        upsertCall(event.callId, {
          started_at: new Date(startedAt).toISOString(),
          answered_at: answeredAt ? new Date(answeredAt).toISOString() : null,
          ended_at: new Date(endedAt).toISOString(),
          duration,
          billsec,
          disposition: answeredAt ? 'answered' : /busy/i.test(cause) ? 'busy' : /no-answer|no_answer|timeout/i.test(cause) ? 'no-answer' : 'failed',
          hangup_cause: String(cause),
          recording: info.recording || undefined,
        });
        legs.delete(event.callId);
        break;
      }
      case 'cdr': {
        // The switch's own record wins over these estimates: it has the media
        // timestamps, so its duration is the authoritative one.
        upsertCall(event.callId, {
          direction: event.direction || 'inbound',
          from_number: event.from || '',
          to_number: event.to || '',
          extension: event.extension || extensionOf(event.to),
          started_at: event.startedAt,
          answered_at: event.answeredAt,
          ended_at: event.endedAt,
          duration: Number(event.duration) || 0,
          billsec: Number(event.billsec) || 0,
          disposition: event.disposition || 'unknown',
          hangup_cause: event.hangupCause || '',
          recording: recordingName(event.recording) || undefined,
        });
        legs.delete(event.callId);
        break;
      }
      case 'call.path': {
        // Path decisions are the reason Cantus exists; they belong in the audit
        // trail so "the audio went through the relay" is answerable later.
        logEvent({
          actor: 'switch',
          action: 'call.path',
          subject: event.callId,
          detail: `${event.path}${event.from ? ` (from ${event.from})` : ''}`,
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // Never let a malformed event take the API down.
    console.error('[telephony] event handling failed', event?.type, err.message);
  }
}

export function startTelephony() {
  if (started) return;
  started = true;
  const client = cantus({
    baseUrl: config.telephony.url,
    token: config.telephony.token,
    domain: config.telephony.domain,
  });
  client.on('event', onEvent);
  client.on('connected', () => {
    console.log('[telephony] Cantus switch connected');
    // The switch keeps its inventory in memory, so a switch restart comes back
    // with no lines and no trunks. The platform is the source of truth, so it
    // re-sends both on every connect rather than waiting for the next edit —
    // otherwise a reboot silently turns every outbound call into `no-route`
    // until somebody happens to save a setting.
    applyConfiguration('switch-connected').catch((err) =>
      console.error('[telephony] configuration sync failed', err.message)
    );
  });
  client.on('disconnected', () => console.warn('[telephony] Cantus switch disconnected, retrying'));
  // A first sync even before the socket settles: a switch that is already up
  // when this container restarts gets its dial plan back immediately.
  applyConfiguration('boot').catch((err) => console.error('[telephony] boot sync failed', err.message));
}

export async function telephonyStatus() {
  const client = cantus({
    baseUrl: config.telephony.url,
    token: config.telephony.token,
    domain: config.telephony.domain,
  });
  let base;
  try {
    base = await client.status();
  } catch (err) {
    base = {
      connected: false,
      transport: 'CANTUS',
      host: config.telephony.url,
      error: err.message,
      activeChannels: [],
    };
  }
  return {
    ...base,
    enabled: config.telephony.enabled,
    domain: config.telephony.domain,
    routesFile: config.telephony.configDir || null,
    simulated: false,
  };
}

/**
 * Write the routing document and hand it to the switch.
 *
 * A saved change is a live change: the database is the source of truth, the
 * document is derived from it, and the switch is told to load it. If the switch
 * is unreachable the file is still written, so the next boot — or the switch's
 * own reload — carries the change; the caller is told which half happened.
 */
export async function applyConfiguration(actor = 'system') {
  const write = writeConfigs();
  const client = cantus({
    baseUrl: config.telephony.url,
    token: config.telephony.token,
    domain: config.telephony.domain,
  });
  let applied = null;
  let error = null;
  try {
    applied = await client.applyRoutes(generateRoutes());
    // Lines and trunks travel together: a route that dials `trunk` is only half
    // a configuration until the switch knows which endpoint to dial, and the
    // trunk inventory lives in the database rather than in this function.
    const inventory = generateLines();
    for (const line of inventory.lines) await client.setLine(line);
    for (const trunk of inventory.trunks) await client.setTrunk(trunk);
  } catch (err) {
    error = err.message;
  }
  db_.run('INSERT INTO events (actor, action, subject, detail) VALUES (?, ?, ?, ?)', [
    actor,
    'telephony.apply',
    'cantus',
    JSON.stringify({ write, applied: !!applied, error }),
  ]);
  return { ...write, reloaded: !!applied, error };
}

export async function applyAfterChange(request) {
  if (!config.telephony.enabled) return null;
  const actor = request?.account?.email || request?.apiKey?.label || 'api';
  try {
    const result = await applyConfiguration(actor);
    return { written: result.written, dir: result.dir, reloaded: result.reloaded, error: result.error };
  } catch (err) {
    logEvent({
      actor,
      action: 'telephony.apply_failed',
      subject: 'cantus',
      detail: err.message,
      ip: request?.ip,
    });
    return { error: err.message };
  }
}

export const previewConfiguration = () => generateConfigs();
export const liveChannels = () => [...legs.values()];
