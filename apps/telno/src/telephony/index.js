import { ami } from './ami.js';
import { writeConfigs, generateConfigs } from './provision.js';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from '../lib/audit.js';

const channels = new Map();
// MixMonitor reports its file when recording starts and stops; the call row is
// stamped with it so the console can play the audio back after the hangup.
const recordings = new Map();
let started = false;

const AUDIO_EXT = /\.(wav|wav49|gsm|ulaw|alaw|sln|g722|ogg|mp3)$/i;

function recordingName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop()?.trim();
  if (!base) return '';
  return AUDIO_EXT.test(base) ? base : `${base}.wav`;
}

/** Live channel state, populated from AMI events (bounded, oldest dropped). */
function track(uniqueid, patch) {
  const existing = channels.get(uniqueid) || { started: Date.now() };
  channels.set(uniqueid, { ...existing, ...patch });
  if (channels.size > 500) {
    const oldest = channels.keys().next().value;
    channels.delete(oldest);
  }
  return channels.get(uniqueid);
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
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length) {
    db_.run(`UPDATE calls SET ${sets.join(', ')} WHERE call_id = ?`, [...values, callId]);
  }
  return existing.id;
}

const DISPOSITIONS = {
  ANSWERED: 'answered',
  BUSY: 'busy',
  'NO ANSWER': 'no-answer',
  FAILED: 'failed',
  CONGESTION: 'congestion',
  CANCEL: 'no-answer',
};

function directionFor(context) {
  if (!context) return 'internal';
  if (context.startsWith('from-trunk') || context.startsWith('from-pstn')) return 'inbound';
  if (context.startsWith('outbound')) return 'outbound';
  return 'internal';
}

function onEvent(msg) {
  try {
    switch (msg.Event) {
      case 'Newchannel': {
        track(msg.Uniqueid, {
          from: msg.CallerIDNum || 'unknown',
          to: msg.Exten || '',
          context: msg.Context || '',
          channel: msg.Channel || '',
          started: Date.now(),
        });
        break;
      }
      case 'Dial': {
        if (msg.SubEvent === 'Begin') {
          track(msg.Uniqueid, { dialed: msg.Destination || '' });
        } else if (msg.SubEvent === 'End' && msg.DialStatus === 'ANSWER') {
          track(msg.Uniqueid, { answered: Date.now() });
        }
        break;
      }
      case 'Bridge': {
        track(msg.Uniqueid, { answered: channels.get(msg.Uniqueid)?.answered || Date.now() });
        break;
      }
      case 'Hangup': {
        const info = channels.get(msg.Uniqueid);
        if (!info) break;
        const endedAt = Date.now();
        const answered = info.answered ? new Date(info.answered).toISOString() : null;
        const duration = Math.max(0, Math.round((endedAt - (info.started || endedAt)) / 1000));
        const billsec = info.answered ? Math.max(0, Math.round((endedAt - info.answered) / 1000)) : 0;
        const context = msg.Context || info.context;
        upsertCall(msg.Uniqueid, {
          direction: directionFor(context),
          from_number: info.from,
          to_number: info.dialed || info.to,
          extension: context === 'internal' ? info.to : '',
          trunk: (info.channel.match(/trunk-([A-Za-z0-9_.-]+)-/)?.[1] || ''),
          started_at: new Date(info.started || endedAt).toISOString(),
          answered_at: answered,
          ended_at: new Date(endedAt).toISOString(),
          duration,
          billsec,
          disposition: !info.answered ? (msg.Cause === '16' ? 'no-answer' : 'failed') : billsec > 0 ? 'answered' : 'no-answer',
          hangup_cause: msg['Cause-txt'] || '',
          recording: recordings.get(msg.Uniqueid) || '',
        });
        channels.delete(msg.Uniqueid);
        break;
      }
      case 'MixMonitorStart':
      case 'MixMonitorStop': {
        const name = recordingName(msg.Filename);
        if (!name) break;
        recordings.set(msg.Uniqueid, name);
        if (recordings.size > 500) recordings.delete(recordings.keys().next().value);
        break;
      }
      case 'Cdr': {
        // cdr_manager gives us authoritative values; it wins over estimates.
        const duration = Number(msg.Duration) || 0;
        const billsec = Number(msg.BillableSeconds) || 0;
        upsertCall(msg.Uniqueid || `${msg.Source}-${msg.StartTime}`, {
          direction: directionFor(msg.DestinationContext),
          from_number: msg.Source || '',
          to_number: msg.Destination || '',
          trunk: msg.LastApplication === 'Dial' ? msg.LastData || '' : '',
          started_at: msg.StartTime ? new Date(msg.StartTime).toISOString() : now(),
          answered_at: msg.AnswerTime ? new Date(msg.AnswerTime).toISOString() : null,
          ended_at: msg.EndTime ? new Date(msg.EndTime).toISOString() : null,
          duration,
          billsec,
          disposition: DISPOSITIONS[msg.Disposition] || 'unknown',
          hangup_cause: msg['Cause-txt'] || '',
          cost: Number(msg.Cost) || 0,
          // Undefined, not empty: a CDR arriving after the Hangup must not wipe
          // the recording the MixMonitor event already attached.
          recording: recordings.get(msg.Uniqueid) || undefined,
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // Never let a malformed event take the API down.
    console.error('[telephony] event handling failed', msg.Event, err.message);
  }
}

export function startTelephony() {
  if (started) return;
  started = true;
  const client = ami();
  client.on('event', onEvent);
  client.on('connected', () => console.log('[telephony] AMI connected'));
  client.on('disconnected', () => console.warn('[telephony] AMI disconnected, retrying'));
}

export async function telephonyStatus() {
  const client = ami();
  const base = await client.status();
  const active = [...channels.values()].slice(0, 25).map((c) => ({
    from: c.from,
    to: c.dialed || c.to,
    context: c.context,
    seconds: Math.round((Date.now() - (c.started || Date.now())) / 1000),
  }));
  return {
    ...base,
    activeChannels: base.connected ? active : [],
    transport: 'AMI',
    configDir: config.telephony.configDir || null,
  };
}

export async function applyConfiguration(actor = 'system') {
  const write = writeConfigs();
  let reload = null;
  if (write.written && config.telephony.reloadOnApply) {
    reload = await ami().reload('all');
  }
  db_.run('INSERT INTO events (actor, action, subject, detail) VALUES (?, ?, ?, ?)', [
    actor,
    'telephony.apply',
    'asterisk',
    JSON.stringify({ write, reloaded: !!reload }),
  ]);
  return { ...write, reloaded: !!reload };
}

/**
 * Write the switch configuration and reload it after a saved change.
 *
 * The database is the source of truth and every generated file is derived from
 * it, so a saved change is a live change: there is no Apply button to forget,
 * and the UI cannot disagree with the switch. A write that cannot reach the
 * switch is reported to the caller rather than rolling the row back — the row
 * is already committed and the next change, or the next boot, regenerates the
 * files from it anyway.
 */
export async function applyAfterChange(request) {
  if (!config.telephony.configDir) return null;
  const actor = request?.account?.email || request?.apiKey?.label || 'api';
  try {
    const result = await applyConfiguration(actor);
    return { written: result.written, dir: result.dir, reloaded: result.reloaded };
  } catch (err) {
    logEvent({
      actor,
      action: 'telephony.apply_failed',
      subject: 'asterisk',
      detail: err.message,
      ip: request?.ip,
    });
    return { error: err.message };
  }
}

export const previewConfiguration = () => generateConfigs();
export const liveChannels = () => [...channels.values()];
