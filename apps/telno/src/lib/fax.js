import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { ami } from '../telephony/ami.js';
import { logEvent } from './audit.js';
import { mediaName, saveMedia } from './media.js';

/**
 * Fax, on the switch rather than at a carrier.
 *
 * Asterisk's res_fax negotiates T.38 with the far end and falls back to G.711
 * passthrough through spandsp when T.38 is refused, so a fax uses the SIP trunk
 * the deployment already pays for. Nothing here calls a carrier fax API and no
 * page is billed individually — which is the whole reason this exists.
 *
 * The switch cannot call back into Node, so reception is handed over through a
 * file: the dialplan writes a one-line receipt next to the document it received,
 * and a sweep here turns that receipt into a row. Sends go the other way, over
 * AMI `Originate` with res_fax's `SendFax` application on the far channel, and
 * the result arrives as fax events on the same AMI session the platform already
 * keeps open for call state.
 */

const SAFE_TRUNK = (name) =>
  String(name || 'x')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 64) || 'x';

export const faxRoot = () => String(config.fax.dir || join(config.dataDir, 'faxes')).replace(/\/+$/, '');
const dirs = () => ({
  root: faxRoot(),
  in: join(faxRoot(), 'in'),
  out: join(faxRoot(), 'out'),
  status: join(faxRoot(), 'status'),
});

export function ensureFaxDirs() {
  const d = dirs();
  for (const dir of [d.in, d.out, d.status]) mkdirSync(dir, { recursive: true });
  return d;
}

/** Where a document is staged before the switch is told to send it. */
export const stagedPath = (id) => join(dirs().out, `${id}.tif`);

/* --------------------------------------------------------------- encoder -- */

/**
 * Ghostscript is what turns a PDF, a scan or a typed page into the TIFF the fax
 * engine can transmit. It is a build dependency of the image, so a failed
 * conversion is reported as a missing tool rather than as a silent empty fax.
 */
function ghostscript() {
  const probe = spawnSync('gs', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  return (probe.stdout || '').trim();
}

function runGhostscript(input, output) {
  const result = spawnSync(
    'gs',
    [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=tiffg3',
      '-r204x196',
      '-dFIXEDMEDIA',
      '-dPDFFitPage',
      '-dAlignToPixels=1',
      `-sOutputFile=${output}`,
      input,
    ],
    { encoding: 'utf8', timeout: 120_000 }
  );
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ') || `gs exited ${result.status}` };
  }
  return { ok: existsSync(output) ? true : false, error: existsSync(output) ? '' : 'ghostscript produced no file' };
}

/** A plain-text body becomes a printable page, so no document is required. */
function postscriptFor(text, stationId) {
  const escape = (line) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  // Courier at 10pt is 6pt per character, and the printable area is 468pt wide
  // (612pt page less 72pt margins on each side). 78 characters is what fits; a
  // wider setting runs the text off the page, which is what a 86-column wrap did.
  const width = 78;
  const lines = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.length) {
      lines.push('');
      continue;
    }
    let rest = raw;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width);
      const at = cut > 40 ? cut : width;
      lines.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^ /, '');
    }
    lines.push(rest);
  }
  const header = String(stationId || 'Telno').slice(0, 40);
  const perPage = 46;
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) pages.push(lines.slice(i, i + perPage));
  const ps = ['%!PS-Adobe-3.0'];
  pages.forEach((page, index) => {
    ps.push('/Helvetica findfont 10 scalefont setfont', '72 750 moveto');
    ps.push(`(${escape(`${header}   page ${index + 1} of ${pages.length}`)}) show`);
    ps.push('/Courier findfont 10 scalefont setfont');
    page.forEach((line, i) => {
      // An absolute `moveto` per line. A relative `rmoveto` leaves the pen where
      // the previous line ended, so every line after a full one starts further
      // right than the last until the page is a diagonal mess.
      ps.push(`72 ${726 - i * 14} moveto`);
      if (line) ps.push(`(${escape(line)}) show`);
    });
    ps.push('showpage');
  });
  return ps.join('\n');
}

/**
 * Produce the TIFF a fax machine can read, from whatever the row carries.
 *
 * Order matters: an uploaded TIFF is transmitted untouched (it is already in
 * the format the wire wants), a PDF or image is rasterised, and a typed page is
 * typeset first. Anything else fails loudly instead of sending blank paper.
 */
export function stageDocument(row) {
  const d = ensureFaxDirs();
  const output = stagedPath(row.id);
  const gsVersion = ghostscript();

  if (row.attachment) {
    const source = join(config.recordingsDir, row.attachment);
    if (!existsSync(source)) return { ok: false, error: 'the attached document is missing from the data volume' };
    const ext = extname(source).toLowerCase();
    if (ext === '.tif' || ext === '.tiff') {
      copyFileSync(source, output);
      return { ok: true, path: output, pages: 0 };
    }
    if (!gsVersion) {
      return { ok: false, error: 'ghostscript is not installed, so a PDF or image cannot be turned into a fax page' };
    }
    const converted = runGhostscript(source, output);
    return converted.ok ? { ok: true, path: output, pages: 0 } : converted;
  }

  const body = String(row.body || '').trim();
  if (!body) return { ok: false, error: 'a fax needs a document or a message body' };
  if (!gsVersion) {
    return { ok: false, error: 'ghostscript is not installed, so a typed page cannot be rendered for the fax engine' };
  }
  const psPath = join(d.out, `${row.id}.ps`);
  writeFileSync(psPath, postscriptFor(body, config.fax.stationId), 'utf8');
  const converted = runGhostscript(psPath, output);
  try {
    unlinkSync(psPath);
  } catch {
    /* staging file is disposable */
  }
  return converted.ok ? { ok: true, path: output, pages: 0 } : converted;
}

/** Count TIFF pages without a parser: each image is one IFD chain entry. */
function countPages(file) {
  try {
    const bytes = readFileSync(file);
    let pages = 0;
    // TIFF magic 42 (classic) or 43 (BigTIFF); walk IFD chain pointers.
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    const magic = little ? bytes.readUInt16LE(2) : bytes.readUInt16BE(2);
    if (magic !== 42) return 0;
    let offset = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
    let guard = 0;
    while (offset && offset + 2 <= bytes.length && guard < 1000) {
      pages += 1;
      const count = little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
      const nextAt = offset + 2 + count * 12;
      if (nextAt + 4 > bytes.length) break;
      offset = little ? bytes.readUInt32LE(nextAt) : bytes.readUInt32BE(nextAt);
      guard += 1;
    }
    return pages;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ send -- */

// Which fax a channel belongs to. AMI answers an Originate with the channel's
// unique id, and the fax events that follow carry that same id.
const byAction = new Map();
const byUniqueid = new Map();
const lastStatus = new Map();

function trunkForSend() {
  return db_.get('SELECT * FROM trunks WHERE enabled = 1 ORDER BY name LIMIT 1');
}

function setStatus(id, status, patch = {}) {
  const sets = ['status = ?'];
  const values = [status];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  db_.run(`UPDATE faxes SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
}

/**
 * Hand a queued fax to the switch.
 *
 * `Originate` dials the destination through the same trunk voice calls use and
 * starts res_fax's `SendFax` on the answered channel — the switch is the fax
 * machine, so there is no media server and no per-page provider.
 */
export async function sendFax(id, actor = 'api') {
  const row = db_.get('SELECT * FROM faxes WHERE id = ?', [id]);
  if (!row) return { ok: false, error: 'fax not found', statusCode: 404 };
  if (row.direction !== 'outbound') return { ok: false, error: 'only an outbound fax can be sent', statusCode: 400 };
  if (!['queued', 'failed'].includes(row.status)) {
    return { ok: false, error: `this fax is already ${row.status}`, statusCode: 409 };
  }
  // A refusal that leaves no trace is a fax that looks stuck. The status stays
  // queued — these are retryable — but the reason is written on the row so the
  // console can say what is missing instead of showing a spinner forever.
  const refuse = (message, statusCode) => {
    db_.run('UPDATE faxes SET error = ? WHERE id = ?', [String(message).slice(0, 240), row.id]);
    return { ok: false, error: message, statusCode };
  };
  if (!config.fax.enabled) return refuse('fax is disabled on this deployment (FAX_ENABLED)', 409);
  const trunk = trunkForSend();
  if (!trunk) return refuse('no enabled trunk to send the fax over', 409);
  if (!ami().connected) return refuse('the switch is not reachable over AMI', 503);

  const staged = stageDocument(row);
  if (!staged.ok) {
    setStatus(row.id, 'failed', { error: staged.error });
    logEvent({ actor, action: 'fax.stage_failed', subject: row.to_e164, detail: staged.error });
    return { ok: false, error: staged.error, statusCode: 422 };
  }

  const pages = countPages(staged.path);
  // The rendered page becomes the row's document, so what was transmitted is
  // what the console can show later — even when it started as typed text.
  if (!row.attachment) {
    const name = mediaName('fax', 'tif');
    saveMedia(name, readFileSync(staged.path));
    db_.run('UPDATE faxes SET attachment = ?, attachment_name = ? WHERE id = ?', [name, `${row.id}.tif`, row.id]);
  }
  db_.run('UPDATE faxes SET pages = ?, error = ? WHERE id = ?', [pages || row.pages || 1, '', row.id]);

  // Dial and present plain digits: a carrier matches its own number plan, and a
  // leading `+` in the request URI or the From user is enough for some to refuse
  // an otherwise authenticated call.
  const digits = String(row.to_e164 || '').replace(/\D/g, '');
  const callerId = String(row.from_e164 || digits).replace(/\D/g, '');
  const actionId = `fax-${row.id}`;
  byAction.set(actionId, row.id);
  setStatus(row.id, 'sending');
  logEvent({ actor, action: 'fax.sending', subject: row.to_e164, detail: `${trunk.name} · ${pages || '?'} page(s)` });

  const response = await ami().send('Originate', {
    Channel: `PJSIP/${digits}@trunk-${SAFE_TRUNK(trunk.name)}-endpoint`,
    Application: 'SendFax',
    // The path is generated here, never taken from a request, so it cannot be
    // pointed at another file on the volume.
    Data: staged.path,
    CallerID: `"${String(config.fax.stationId || 'Telno').replace(/"/g, '')}" <${callerId}>`,
    Variable: `TELNO_FAX_ID=${row.id}`,
    Async: 'true',
    ActionID: actionId,
  });

  if (!response) {
    byAction.delete(actionId);
    setStatus(row.id, 'failed', { error: 'the switch did not answer the originate request' });
    return { ok: false, error: 'the switch did not answer the originate request', statusCode: 504 };
  }
  if (response.Response === 'Error') {
    byAction.delete(actionId);
    const message = response.Message || 'the switch refused the originate';
    setStatus(row.id, 'failed', { error: message });
    logEvent({ actor, action: 'fax.send_refused', subject: row.to_e164, detail: message });
    return { ok: false, error: message, statusCode: 502 };
  }
  return { ok: true, fax: db_.get('SELECT * FROM faxes WHERE id = ?', [row.id]) };
}

/* ------------------------------------------------------------- AMI events -- */

/**
 * The switch's event names, which are not the ones you would guess.
 *
 * res_fax emits `FAXStatus` in capitals, and the completion events are
 * `SendFAX` and `ReceiveFAX` — a listener waiting for `FaxStatus` hears nothing
 * at all, which is how every transmission used to end up stuck at `sending`.
 * Names are matched case-insensitively so an Asterisk that changes its casing
 * does not silently break sending again.
 */
const FAX_STATUS = /^faxstatus$/i;
const SEND_DONE = /^sendfax$/i;
const RECEIVE_DONE = /^receivefax$/i;
const ORIGINATE = /^originates?response$/i;
const TERMINAL = /COMPLETE|SUCCESS|FAILED|ERROR/i;

/** `fax_abc…` from a staged path like `/data/faxes/out/fax_abc….tif`. */
export function faxIdFromStaged(file) {
  const match = String(file || '').match(/[\\/]out[\\/](fax_[A-Za-z0-9]+)\.tiff?$/);
  return match ? match[1] : '';
}

/**
 * Fax events arrive on the AMI session the platform already runs for calls.
 * A send is finished when res_fax says so — `SendFAX` on a page that went
 * through, a status event naming a failure otherwise — or, if the trunk drops
 * the call before it says anything, at hangup, which is then a failure with the
 * switch's own cause rather than a row stuck at `sending` forever.
 */
export function onFaxEvent(msg, channel = null) {
  try {
    if (ORIGINATE.test(msg.Event || '')) {
      const faxId = byAction.get(msg.ActionID);
      if (faxId) {
        byAction.delete(msg.ActionID);
        if (msg.Uniqueid) byUniqueid.set(msg.Uniqueid, faxId);
        if (msg.Response !== 'Success') {
          setStatus(faxId, 'failed', { error: msg.Reason || 'the switch could not dial the destination' });
          logEvent({ actor: 'switch', action: 'fax.originate_failed', subject: faxId, detail: String(msg.Reason || '') });
        }
      }
      return;
    }

    // A page that went out. The event names the file the switch just sent, so
    // the row is identified from the switch's own record rather than from a
    // channel id that may never have been reported back to us.
    if (SEND_DONE.test(msg.Event || '')) {
      const faxId = byUniqueid.get(msg.Uniqueid) || faxIdFromStaged(msg.FileName);
      if (!faxId) return;
      const pages = Number(msg.PagesTransferred || 0) || 0;
      const failed = pages === 0;
      lastStatus.set(msg.Uniqueid, failed ? 'failed' : 'sent');
      setStatus(faxId, failed ? 'failed' : 'sent', {
        pages: pages || undefined,
        error: failed ? 'the far end accepted no pages' : '',
      });
      logEvent({
        actor: 'switch',
        action: failed ? 'fax.send_failed' : 'fax.sent',
        subject: faxId,
        detail: `${pages || '?'} page(s) at ${msg.TransferRate || '?'} bps`,
      });
      return;
    }

    // A document that arrived. `ReceiveFAX` fires once the last page is on
    // disk, which is the only reliable moment the file is complete.
    if (RECEIVE_DONE.test(msg.Event || '')) {
      ingestInbound(msg, channel);
      return;
    }

    if (FAX_STATUS.test(msg.Event || '')) {
      const isSend = String(msg.Operation || '').toLowerCase() === 'send';
      const faxId = byUniqueid.get(msg.Uniqueid) || (isSend ? faxIdFromStaged(msg.FileName) : '') || '';
      // A receive in progress is not a document yet: wait for `ReceiveFAX`.
      if (!faxId) return;
      byUniqueid.set(msg.Uniqueid, faxId);
      const detail = String(msg.Status || msg.FaxStatusString || msg['FAXOPT(statusstr)'] || '');
      const status = String(msg.FaxStatus || msg['FAXOPT(status)'] || '');
      if (!TERMINAL.test(status) && !/fail|error|cancel/i.test(detail)) return;
      const failed = /fail|error|cancel/i.test(detail) || /fail|error/i.test(status);
      lastStatus.set(msg.Uniqueid, failed ? 'failed' : 'sent');
      setStatus(faxId, failed ? 'failed' : 'sent', {
        pages: Number(msg.PagesTransferred || 0) || undefined,
        error: failed ? (detail || status).slice(0, 240) : '',
      });
      logEvent({
        actor: 'switch',
        action: failed ? 'fax.send_failed' : 'fax.sent',
        subject: faxId,
        detail: detail || status,
      });
      return;
    }

    if (msg.Event === 'Hangup') {
      const faxId = byUniqueid.get(msg.Uniqueid);
      if (!faxId) return;
      const settled = lastStatus.get(msg.Uniqueid);
      byUniqueid.delete(msg.Uniqueid);
      lastStatus.delete(msg.Uniqueid);
      if (settled) return;
      const cause = msg['Cause-txt'] || '';
      const current = db_.get('SELECT status FROM faxes WHERE id = ?', [faxId]);
      if (current && current.status === 'sending') {
        setStatus(faxId, 'failed', {
          error: `the call ended before the fax completed${cause ? ` (${cause})` : ''}`.slice(0, 240),
        });
        logEvent({ actor: 'switch', action: 'fax.send_failed', subject: faxId, detail: cause });
      }
    }
  } catch (err) {
    console.error('[fax] event handling failed', err.message);
  }
}

/* --------------------------------------------------------------- receive -- */

/**
 * Turn a document the switch received into a row.
 *
 * The trigger is the switch's own fax event, not a file the dialplan writes
 * afterwards. That distinction matters: a receipt written by a later dialplan
 * priority disappears whenever the far end hangs up first, which is exactly
 * what a fax machine does — the document was received and then reported as
 * nothing at all. res_fax's status event carries the file, the page count and
 * the outcome, and it fires once the reception is complete.
 *
 * The file is recorded under `document` so the same document cannot be ingested
 * twice by the event and by the sweep that catches up after a restart.
 */
function ingestInbound(msg, channel) {
  const d = ensureFaxDirs();
  const named = String(msg.FileName || '').trim();
  let file = named && existsSync(named) ? named : '';
  if (!file) {
    const candidate = join(d.in, `${msg.Uniqueid}.tif`);
    if (existsSync(candidate)) file = candidate;
  }
  // The event does not always name the file the same way the dialplan did: a
  // receive on the second half of a channel can be reported under one unique id
  // while the document is written under another. The newest unclaimed document
  // in the inbox is the one this event is about.
  if (!file) {
    try {
      const newest = readdirSync(d.in)
        .filter((entry) => /\.tiff?$/i.test(entry))
        .map((entry) => ({ entry, at: statSync(join(d.in, entry)).mtimeMs }))
        .filter((item) => !db_.get('SELECT id FROM faxes WHERE document = ?', [item.entry]))
        .sort((a, b) => b.at - a.at)[0];
      if (newest) file = join(d.in, newest.entry);
    } catch {
      /* no inbox yet */
    }
  }
  if (!file) return false;

  const document = file.split(/[\\/]/).pop();
  if (!document) return false;
  if (db_.get('SELECT id FROM faxes WHERE document = ?', [document])) return true;

  const statusText = String(msg.FaxStatusString || msg.FaxStatus || '').trim();
  const bytes = (() => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  })();
  const pages = Number(msg.PagesTransferred || 0) || countPages(file) || (bytes > 0 ? 1 : 0);
  const failed = /fail|error/i.test(statusText) || pages === 0;

  const from = String(channel?.from || msg.RemotePartyID || msg.CallerIDNum || '').trim();
  // The DID the dialplan wrote into the name, then the channel's own extension.
  const stem = document.replace(/\.tiff?$/i, '');
  const rawTo = String(stem.split('__')[1] || channel?.to || '').trim();
  const number = rawTo ? db_.get('SELECT * FROM numbers WHERE e164 = ?', [rawTo]) : null;
  const to = number?.e164 || rawTo;

  if (!failed) {
    const name = mediaName('fax', 'tif');
    saveMedia(name, readFileSync(file));
    db_.run(
      `INSERT INTO faxes (id, direction, number_id, from_e164, to_e164, pages, status, subject, body, document, attachment, attachment_name, at, error)
       VALUES (?, 'inbound', ?, ?, ?, ?, 'received', ?, '', ?, ?, ?, ?, '')`,
      [newId('fax_'), number?.id || null, from, to, pages, 'Inbound fax', document, name, document, now()]
    );
    logEvent({ actor: 'switch', action: 'fax.received', subject: to || from, detail: `${pages} page(s)` });
  } else {
    db_.run(
      `INSERT INTO faxes (id, direction, number_id, from_e164, to_e164, pages, status, subject, body, document, attachment, attachment_name, at, error)
       VALUES (?, 'inbound', ?, ?, ?, ?, 'failed', ?, '', '', ?, '', '', ?, ?)`,
      [newId('fax_'), number?.id || null, from, to, pages, 'Inbound fax failed', document, now(), statusText.slice(0, 240)]
    );
    logEvent({ actor: 'switch', action: 'fax.receive_failed', subject: to || from, detail: statusText });
  }

  // The row is the record now; the switch's copy is disposable.
  try {
    unlinkSync(file);
  } catch {
    /* the sweep will not see it a second time: document is stored */
  }
  return true;
}

/**
 * Catch documents the events could not report — a restart mid-reception, or an
 * AMI session that was down when the fax arrived. Anything left in the inbox
 * that no row claims becomes a row of its own, so a received fax is never a
 * file nobody can see.
 */
export function sweepReceived() {
  if (!config.fax.enabled) return { ingested: 0 };
  const d = ensureFaxDirs();
  let ingested = 0;
  let names = [];
  try {
    names = readdirSync(d.in).filter((name) => /\.tiff?$/i.test(name));
  } catch {
    return { ingested: 0 };
  }
  for (const name of names) {
    const file = join(d.in, name);
    try {
      // Young files may still be arriving from the switch. A fax that has just
      // finished is usually complete within a second; this is a guard against
      // reading a page while it is being written, not a wait for the fax.
      if (Date.now() - statSync(file).mtimeMs < 25_000) continue;
    } catch {
      continue;
    }
    if (db_.get('SELECT id FROM faxes WHERE document = ?', [name])) continue;
    const pages = countPages(file) || 1;
    const did = name.replace(/\.tiff?$/i, '').split('__')[1] || '';
    const number = did ? db_.get('SELECT * FROM numbers WHERE e164 = ?', [did]) : null;
    const media = mediaName('fax', 'tif');
    saveMedia(media, readFileSync(file));
    db_.run(
      `INSERT INTO faxes (id, direction, number_id, from_e164, to_e164, pages, status, subject, body, document, attachment, attachment_name, at, error)
       VALUES (?, 'inbound', ?, '', ?, ?, 'received', ?, '', ?, ?, ?, ?, '')`,
      [newId('fax_'), number?.id || null, number?.e164 || did, pages, 'Inbound fax', name, media, name, now()]
    );
    try {
      unlinkSync(file);
    } catch {
      /* nothing else to do */
    }
    ingested += 1;
    logEvent({ actor: 'switch', action: 'fax.received', subject: name, detail: `${pages} page(s), recovered by sweep` });
  }
  return { ingested };
}

/**
 * A transmission the switch gave up on must not read as "sending" for ever.
 *
 * res_fax reports a result on its own events, but a refused media
 * renegotiation or a call the carrier drops can end the channel without one —
 * and a row stuck at `sending` tells the console a page is still on the wire
 * when nothing is. The staged document's timestamp is when the transmission
 * actually started, so a fax that was queued in the morning and sent at noon is
 * judged from noon; the allowance is generous (a page of G.711 fax is slow, and
 * a long document legitimately takes minutes).
 */
export function settleStuckSends() {
  const rows = db_.all("SELECT id, at, pages FROM faxes WHERE direction = 'outbound' AND status = 'sending'");
  let settled = 0;
  for (const row of rows) {
    let started = Number.NaN;
    try {
      started = statSync(stagedPath(row.id)).mtimeMs;
    } catch {
      started = Date.parse(row.at || '');
    }
    if (!Number.isFinite(started)) continue;
    const allowance = (120 + Math.max(1, Number(row.pages) || 1) * 60) * 1000;
    if (Date.now() - started < allowance) continue;
    setStatus(row.id, 'failed', {
      error: 'the switch ended the call before the fax completed — no result was reported',
    });
    logEvent({ actor: 'switch', action: 'fax.send_failed', subject: row.id, detail: 'stale send settled by the sweep' });
    settled += 1;
  }
  return settled;
}

let sweeper = null;

export function startFax() {
  if (sweeper || !config.fax.enabled) return;
  ensureFaxDirs();
  const every = Math.max(5, config.fax.sweepSeconds) * 1000;
  sweeper = setInterval(() => {
    try {
      sweepReceived();
      settleStuckSends();
    } catch (err) {
      console.error('[fax] sweep failed', err.message);
    }
  }, every);
  if (sweeper.unref) sweeper.unref();
  // A restart is not a reason to lose a document that arrived while the API was
  // down: the receipt is still on the volume, so one sweep at boot catches up.
  try {
    sweepReceived();
    settleStuckSends();
  } catch (err) {
    console.error('[fax] startup sweep failed', err.message);
  }
}

export function stopFax() {
  clearInterval(sweeper);
  sweeper = null;
}

/** What the Fax screen shows about the engine itself. */
export async function faxStatus() {
  const d = ensureFaxDirs();
  let modules = '';
  if (ami().connected) {
    const answer = await ami().send('Command', { Command: 'module show like res_fax' });
    modules = String(answer?.Output || '');
  }
  const loaded = /res_fax\.so/.test(modules);
  const spandsp = /res_fax_spandsp\.so/.test(modules);
  return {
    enabled: config.fax.enabled,
    transport: config.fax.t38 ? 'T.38 preferred, G.711 passthrough fallback' : 'G.711 passthrough (spandsp)',
    stationId: config.fax.stationId,
    dir: d.root,
    ghostscript: ghostscript(),
    modules: { resFax: loaded, spandsp },
    ready: loaded && !!ghostscript(),
    note: loaded
      ? spandsp
        ? 'The switch can send and receive faxes on the SIP trunk.'
        : 'res_fax is loaded without spandsp: T.38 works, G.711 fallback does not.'
      : ami().connected
        ? 'The fax modules are not loaded in the switch image.'
        : 'The switch is not reachable, so the fax engine cannot be checked.',
  };
}

export { countPages };
