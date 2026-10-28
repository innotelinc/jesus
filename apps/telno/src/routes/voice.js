import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import * as v from '../lib/validate.js';
import {
  assertCanRequireVoice,
  deleteVoiceprint,
  enrollVoiceprint,
  issueVoiceTicket,
  recentAttempts,
  verifyVoiceprint,
  voiceGate,
  voiceprintFor,
} from '../lib/voiceprint.js';

/**
 * Voice on the line: enrollment, checks and the gate.
 *
 * The audio arrives as base64 inside JSON rather than as a raw body, because
 * enrollment is several samples of one phrase and a multipart form would be more
 * moving parts than the job needs. The browser decodes its own recording to
 * 16 kHz mono WAV first, so what lands here is always the same format.
 *
 * Nothing in this file trusts the client's opinion of a match: the score comes
 * from the embedding, and the ticket it may issue is single use and short-lived.
 */

const MAX_SAMPLE_BYTES = 512 * 1024;

function wavFrom(value, name = 'audio') {
  const text = String(value || '').replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '');
  if (!text) throw badRequest(`Missing ${name}`);
  let buffer;
  try {
    buffer = Buffer.from(text, 'base64');
  } catch {
    throw badRequest(`${name} is not base64 audio`);
  }
  if (!buffer.length) throw badRequest(`${name} is empty`);
  if (buffer.length > MAX_SAMPLE_BYTES) throw badRequest(`${name} is too large`);
  return buffer;
}

function extensionFor(value, account) {
  const text = v.str(value, { name: 'extension', max: 12, required: true });
  const row = db_.get('SELECT * FROM extensions WHERE extension = ?', [text]);
  if (!row) throw notFound(`Extension ${text} does not exist`);
  if ((account?.account_kind || 'staff') === 'customer' && row.account_id !== account.id) {
    throw forbidden(`Extension ${text} is not on your account`);
  }
  return row;
}

const history = (accountId, extension, limit = 12) =>
  db_
    .all(
      'SELECT outcome, score, detail, at FROM voice_auth_events WHERE account_id = ? AND extension = ? ORDER BY at DESC LIMIT ?',
      [accountId, String(extension), limit]
    )
    .map((row) => ({ outcome: row.outcome, score: row.score, detail: row.detail, at: row.at }));

export default async function voiceRoutes(app) {
  app.addHook('preHandler', async (request) => {
    if (request.method === 'OPTIONS') return;
    await app.authenticate(request);
  });

  /** What this line's voice settings are, and whether a session will be gated. */
  app.get('/voice/status', async (request) => {
    const extension = extensionFor(request.query?.extension, request.account);
    const print = voiceprintFor(extension.account_id, extension.extension);
    return {
      recognition: config.voice.recognition,
      available: config.voice.authEnabled,
      gate: voiceGate(extension),
      voiceprint: print
        ? {
            phrase: print.phrase,
            samples: print.samples,
            threshold: print.threshold,
            updatedAt: print.updatedAt,
            // Not the vector: a voiceprint that can be read back is a voiceprint
            // that can be copied.
            enrolled: true,
          }
        : { enrolled: false },
      // Minimum and maximum recording length, so the UI can stop recording on
      // its own rather than upload something the server will refuse.
      sample: {
        minSeconds: config.voice.minSeconds,
        maxSeconds: config.voice.maxSeconds,
        ticketTtlSec: config.voice.ticketTtlSec,
      },
      recent: history(extension.account_id, extension.extension),
      attemptsThisHour: recentAttempts(extension.account_id, extension.extension),
    };
  });

  /**
   * Enroll a line: two to five recordings of the same phrase.
   *
   * Re-enrolling replaces the print, which is also the way out of a bad print —
   * the account owner's own voice is the only thing needed.
   */
  app.post('/voice/enroll', async (request) => {
    if (!config.voice.authEnabled) throw forbidden('Voice authentication is switched off on this platform');
    const account = request.account;
    const extension = extensionFor(request.body?.extension, account);
    const phrase = v.str(request.body?.phrase, { name: 'phrase', max: 120, required: false });
    const samples = Array.isArray(request.body?.samples) ? request.body.samples : [];
    const wavs = samples.map((sample, index) => wavFrom(sample, `sample ${index + 1}`));

    const result = enrollVoiceprint({
      accountId: extension.account_id || account.id,
      extension: extension.extension,
      phrase,
      wavs,
    });

    logEvent({
      actor: account.email,
      action: 'voice.enrolled',
      subject: extension.extension,
      detail: `${result.samples} sample(s), consistency ${result.consistency.toFixed(2)}`,
      ip: request.ip,
    });
    return { voiceprint: result, gate: voiceGate(extension) };
  });

  /**
   * One check. A pass issues a ticket the softphone session can spend; it is not
   * a session itself, so a stolen response cannot be reused.
   */
  app.post('/voice/verify', async (request) => {
    if (!config.voice.authEnabled) throw forbidden('Voice authentication is switched off on this platform');
    const account = request.account;
    const extension = extensionFor(request.body?.extension, account);
    const wav = wavFrom(request.body?.audio, 'audio');
    const heard = v.str(request.body?.heard, { name: 'heard', max: 200, required: false });

    const result = verifyVoiceprint({
      accountId: extension.account_id || account.id,
      extension: extension.extension,
      wav,
      heard,
    });

    logEvent({
      actor: account.email,
      action: result.ok ? 'voice.passed' : 'voice.failed',
      subject: extension.extension,
      detail: `score ${result.score} (threshold ${result.threshold})`,
      ip: request.ip,
    });

    if (!result.ok) return { ...result, ticket: null, expiresIn: 0 };
    const ticket = issueVoiceTicket(extension.account_id || account.id, extension.extension);
    return { ...result, ...ticket };
  });

  /** Require (or stop requiring) the check before this line gets a session. */
  app.post('/voice/require', async (request) => {
    const account = request.account;
    const extension = extensionFor(request.body?.extension, account);
    const enabled = v.bool(request.body?.enabled);
    assertCanRequireVoice(extension, enabled);
    db_.run('UPDATE extensions SET voice_auth = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, now(), extension.id]);
    logEvent({
      actor: account.email,
      action: enabled ? 'voice.required' : 'voice.not_required',
      subject: extension.extension,
      ip: request.ip,
    });
    const fresh = db_.get('SELECT * FROM extensions WHERE id = ?', [extension.id]);
    return { gate: voiceGate(fresh) };
  });

  /** Forget a voiceprint. Also stops the line requiring one, or it would lock. */
  app.delete('/voice', async (request) => {
    const account = request.account;
    const extension = extensionFor(request.query?.extension, account);
    const removed = deleteVoiceprint(extension.account_id || account.id, extension.extension);
    if (!removed) throw notFound('This line has no voiceprint');
    db_.run('UPDATE extensions SET voice_auth = 0, updated_at = ? WHERE id = ?', [now(), extension.id]);
    logEvent({
      actor: account.email,
      action: 'voice.forgotten',
      subject: extension.extension,
      ip: request.ip,
    });
    return { removed: true, gate: voiceGate(db_.get('SELECT * FROM extensions WHERE id = ?', [extension.id])) };
  });
}
