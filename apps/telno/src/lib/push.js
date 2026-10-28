/**
 * Apple push for the SCIF app.
 *
 * A locked iPhone will not ring for a WebSocket that the OS has suspended. The
 * only supported way to make it ring as a phone call is a VoIP push: PushKit
 * wakes the app, and the app must report the call to CallKit immediately. This
 * module is the sending half of that, and it is deliberately small:
 *
 *   - key-based APNs auth (a .p8, ES256 JWT) — no certificate that expires in a
 *     year, no third-party push service, nothing to pay for;
 *   - one request per device over HTTP/2, with the reason recorded if Apple
 *     refuses, because "it did not ring" is not a bug report;
 *   - a token is owned by exactly one account. A phone that is sold, wiped or
 *     signed into another account must not keep receiving the first owner's
 *     calls, so registering a token moves it.
 *
 * What this cannot do is carry the media: a VoIP push wakes the app, it does not
 * connect audio. The app answers in CallKit, comes to the foreground and joins
 * the call through the same WebRTC path as the browser.
 */

import http2 from 'node:http2';
import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, forbidden } from './errors.js';

const base64url = (value) => Buffer.from(value).toString('base64url');

/** Load the .p8 once. A missing key is a configuration problem, not a crash. */
let cachedKey = null;
let keyError = '';

export function signingKey() {
  if (cachedKey) return { key: cachedKey, error: '' };
  if (keyError) return { key: null, error: keyError };
  const raw = config.apns.key || (config.apns.keyPath ? safeRead(config.apns.keyPath) : '');
  if (!raw) {
    keyError = 'No APNs key: set APNS_KEY_PATH to a .p8 on the data volume, or APNS_KEY to its contents';
    return { key: null, error: keyError };
  }
  try {
    cachedKey = createPrivateKey(raw);
    return { key: cachedKey, error: '' };
  } catch (err) {
    keyError = `The APNs key could not be read: ${err.message}`;
    return { key: null, error: keyError };
  }
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

let cachedToken = null;

/**
 * The provider token APNs wants: an ES256 JWT, valid for an hour, reused until
 * shortly before it expires. Apple rejects a token older than an hour and rate
 * limits a provider that mints one per request.
 */
export function apnsJwt({ at = Math.floor(Date.now() / 1000), force = false } = {}) {
  if (!force && cachedToken && cachedToken.expires > at + 120) return cachedToken;
  const { key, error } = signingKey();
  if (!key) throw forbidden(error);
  if (!config.apns.keyId || !config.apns.teamId) {
    throw forbidden('APNs needs APNS_KEY_ID and APNS_TEAM_ID as well as the key');
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.apns.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.apns.teamId, iat: at }));
  const unsigned = `${header}.${claims}`;
  const signature = createSign('sha256')
    .update(unsigned)
    // APNs wants the raw 64-byte R||S form, not DER.
    .sign({ key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  cachedToken = { value: `${unsigned}.${signature}`, expires: at + 3600 };
  return cachedToken;
}

const hostFor = () =>
  config.apns.host ||
  (config.apns.environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com');

/** One request to APNs, resolved with what happened rather than thrown at a caller. */
function send(token, payload) {
  let url;
  try {
    url = new URL(hostFor());
  } catch {
    return Promise.resolve({ ok: false, status: 0, reason: `APNS_HOST is not a URL: ${hostFor()}` });
  }
  const topic = `${config.apns.bundleId}${config.apns.topicSuffix}`;
  const body = Buffer.from(JSON.stringify(payload));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let client;
    try {
      client = http2.connect(url);
    } catch (err) {
      finish({ ok: false, status: 0, reason: err.message });
      return;
    }
    client.on('error', (err) => {
      finish({ ok: false, status: 0, reason: `connection: ${err.message}` });
      client.close();
    });
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsJwt().value}`,
      'apns-topic': topic,
      'apns-push-type': 'voip',
      // A ringing phone is the most time-sensitive thing there is.
      'apns-priority': '10',
      // Expire at once: a wake-up delivered minutes later would ring for a call
      // that is already over.
      'apns-expiration': '0',
      'content-type': 'application/json',
      'content-length': String(body.length),
    });
    let status = 0;
    let raw = '';
    request.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    request.on('data', (chunk) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      let reason = '';
      try {
        reason = JSON.parse(raw || '{}').reason || '';
      } catch {
        reason = raw.slice(0, 200);
      }
      finish({ ok: status === 200, status, reason });
      client.close();
    });
    request.on('error', (err) => {
      finish({ ok: false, status, reason: err.message });
      client.close();
    });
    request.setTimeout(8000, () => {
      finish({ ok: false, status: 0, reason: 'APNs did not answer within 8s' });
      request.destroy();
      client.close();
    });
    request.end(body);
  });
}

/* --------------------------------------------------------------- storage -- */

const deviceView = (row) => ({
  id: row.id,
  extension: row.extension,
  platform: row.platform,
  token: `${String(row.token).slice(0, 8)}…${String(row.token).slice(-6)}`,
  bundleId: row.bundle_id,
  environment: row.environment,
  deviceName: row.device_name || '',
  appVersion: row.app_version || '',
  lastSeenAt: row.last_seen_at,
  failure: row.failure || '',
  createdAt: row.created_at,
});

export const devicesFor = (accountId, extension = null) =>
  (extension
    ? db_.all('SELECT * FROM push_devices WHERE account_id = ? AND extension = ? ORDER BY created_at', [
        accountId,
        String(extension),
      ])
    : db_.all('SELECT * FROM push_devices WHERE account_id = ? ORDER BY created_at', [accountId])
  ).map(deviceView);

/**
 * Register a device token against a line.
 *
 * A token that already exists is moved rather than duplicated: Apple hands the
 * same token to one app on one phone, so a second registration is the same phone
 * with a new line or a new owner, and stacking rows would ring the wrong person.
 */
export function registerDevice({ accountId, extension, token, platform = 'ios', bundleId = '', environment = '', deviceName = '', appVersion = '' }) {
  const clean = String(token || '').replace(/[^A-Za-z0-9]/g, '');
  if (clean.length < 32 || clean.length > 200) throw badRequest('That is not a push token');
  const existing = db_.get('SELECT * FROM push_devices WHERE token = ?', [clean]);
  if (existing) {
    db_.run(
      `UPDATE push_devices
          SET account_id = ?, extension = ?, platform = ?, bundle_id = ?, environment = ?, device_name = ?, app_version = ?,
              last_seen_at = ?, failure = ''
        WHERE id = ?`,
      [accountId, String(extension), platform, bundleId || config.apns.bundleId, environment || config.apns.environment, String(deviceName).slice(0, 60), String(appVersion).slice(0, 20), now(), existing.id]
    );
  } else {
    db_.run(
      `INSERT INTO push_devices (id, account_id, extension, platform, token, bundle_id, environment, device_name, app_version, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('pd_'), accountId, String(extension), platform, clean, bundleId || config.apns.bundleId, environment || config.apns.environment, String(deviceName).slice(0, 60), String(appVersion).slice(0, 20), now()]
    );
  }
  return deviceView(db_.get('SELECT * FROM push_devices WHERE token = ?', [clean]));
}

export const removeDevice = (accountId, token) => {
  const clean = String(token || '');
  const row = db_.get('SELECT * FROM push_devices WHERE account_id = ? AND (token = ? OR token LIKE ?)', [
    accountId,
    clean,
    `${clean.slice(0, 8)}%`,
  ]);
  if (!row) return false;
  db_.run('DELETE FROM push_devices WHERE id = ?', [row.id]);
  return true;
};

/* ------------------------------------------------------------------ ring -- */

const lastRing = new Map();

/**
 * Ring every device registered to a line.
 *
 * `call` is what CallKit shows: the number calling and whether this is a video
 * call. The app answers with `reportNewIncomingCall`, and the actual media is
 * joined in the app after the user accepts.
 */
export async function ringExtension(extension, call = {}) {
  const rows = db_.all('SELECT * FROM push_devices WHERE extension = ?', [String(extension)]);
  if (!rows.length) return { ok: false, reason: 'no_devices', devices: 0, sent: 0, failed: 0 };
  if (!config.apns.enabled) return { ok: false, reason: 'apns_disabled', devices: rows.length, sent: 0, failed: 0 };

  const results = [];
  for (const row of rows) {
    const payload = {
      // VoIP pushes carry no visible alert: CallKit draws the call screen.
      aps: { 'content-available': 1 },
      call: {
        id: call.id || newId('call_'),
        from: String(call.from || '').slice(0, 32),
        to: String(call.to || '').slice(0, 32),
        extension: row.extension,
        display: String(call.display || call.from || 'Unknown').slice(0, 60),
        video: !!call.video,
        // Where the call is waiting. The app dials this space to join it, which
        // is the only way a call can be taken on a phone that was not registered
        // when the call arrived.
        parkingSpace: call.parkingSpace ? String(call.parkingSpace).slice(0, 12) : '',
        parkingLot: call.parkingLot ? String(call.parkingLot).slice(0, 24) : '',
        at: new Date().toISOString(),
      },
    };
    let result;
    try {
      result = await send(row.token, payload);
    } catch (err) {
      result = { ok: false, status: 0, reason: err.message };
    }
    if (result.ok) {
      db_.run('UPDATE push_devices SET last_seen_at = ?, failure = ? WHERE id = ?', [now(), '', row.id]);
    } else {
      db_.run('UPDATE push_devices SET failure = ? WHERE id = ?', [String(result.reason || result.status).slice(0, 120), row.id]);
      // 410 Unregistered, or 400 BadDeviceToken: this phone is gone or the token
      // is from another environment. Keeping it would fail on every call.
      if (result.status === 410 || /BadDeviceToken|Unregistered/i.test(result.reason || '')) {
        db_.run('DELETE FROM push_devices WHERE id = ?', [row.id]);
      }
    }
    results.push({ device: deviceView(row).token, ok: result.ok, status: result.status, reason: result.reason });
  }
  return {
    ok: results.some((entry) => entry.ok),
    devices: rows.length,
    sent: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    results,
  };
}

/**
 * Whether unanswered calls are parked for a registered phone.
 *
 * This is the platform's answer to "can this call reach a locked iPhone?": when
 * it is on, a line with a device parks an unanswered call and the push carries
 * the parking space, so answering joins the call. When it is off, the push goes
 * out at dial time and the app can only come forward.
 */
export const parkedRingEnabled = () =>
  !!(config.parking.enabled && config.apns.enabled && config.apns.ringOnDial);

/**
 * Called from the switch's Dial event: a line is ringing and nobody is holding
 * a live softphone socket for it.
 *
 * Two guards, both learned the hard way in telephony: an app that is already
 * open does not need a push (it is ringing in its own window), and a retry storm
 * of Dial events must not become a push storm.
 */
export async function maybeRingForDial({ extension, caller = '', video = false, liveExtensions = new Set() }) {
  if (!config.apns.enabled || !config.apns.ringOnDial) return { skipped: 'disabled' };
  // Parking on, the push is sent when the call is parked instead: two pushes for
  // one call would ring the phone twice and the first could not be joined.
  if (parkedRingEnabled()) return { skipped: 'parked_ring' };
  if (!extension) return { skipped: 'no_extension' };
  if (liveExtensions.has(String(extension))) return { skipped: 'app_open' };
  const at = Date.now();
  if ((lastRing.get(String(extension)) || 0) > at - 3000) return { skipped: 'debounced' };
  lastRing.set(String(extension), at);
  return ringExtension(extension, { from: caller, to: extension, video });
}

/**
 * Ring a line for a call that is already waiting in a parking space.
 *
 * This is the useful half of parking: the space number goes in the push, so the
 * app joins a call that exists before the phone was even awake. The debounce is
 * keyed by space, because two calls parked in different spaces are two calls and
 * both of them are real.
 */
export async function maybeRingForParkedCall({ extension, space, lot = '', caller = '', video = false, liveExtensions = new Set() }) {
  if (!config.apns.enabled || !config.apns.ringOnDial) return { skipped: 'disabled' };
  if (!config.parking.enabled) return { skipped: 'parking_disabled' };
  if (!extension || !space) return { skipped: 'no_space' };
  // An app that is open is already showing the console's own line state; it does
  // not need CallKit over the top of it.
  if (liveExtensions.has(String(extension))) return { skipped: 'app_open' };
  const key = `${extension}:${space}`;
  const at = Date.now();
  if ((lastRing.get(key) || 0) > at - 3000) return { skipped: 'debounced' };
  lastRing.set(key, at);
  return ringExtension(extension, {
    // The space is the call's identity as far as the phone is concerned: two
    // pushes for the same space must not stack two CallKit calls.
    id: `park-${space}-${at}`,
    from: caller,
    to: extension,
    video,
    parkingSpace: space,
    parkingLot: lot || config.parking.lot,
  });
}

/** The console's answer to "why isn't my phone ringing?" */
export function pushStatus() {
  const { error } = signingKey();
  return {
    enabled: config.apns.enabled,
    configured: config.apns.enabled && !error,
    problem: error || '',
    bundleId: config.apns.bundleId,
    topic: `${config.apns.bundleId}${config.apns.topicSuffix}`,
    environment: config.apns.environment,
    ringOnDial: config.apns.ringOnDial,
    // Where an unanswered call waits, so the answer to "how does it join?" is
    // readable from the console instead of inferred.
    parking: {
      enabled: config.parking.enabled,
      lot: config.parking.lot,
      start: Math.min(config.parking.start, config.parking.end),
      end: Math.max(config.parking.start, config.parking.end),
      ringSeconds: config.parking.ringSeconds,
      timeoutSeconds: config.parking.timeoutSeconds,
    },
    // Deliberately no device count: it would be every device on the platform,
    // and a customer has no business reading that. Their own list is below.
  };
}
