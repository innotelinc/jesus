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
  const width = 86;
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
    ps.push('72 726 moveto', '/Courier findfont 10 scalefont setfont');
    page.forEach((line, i) => {
      if (i) ps.push('0 -14 rmoveto');
      ps.push(`(${escape(line)}) show`);
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

  const digits = String(row.to_e164 || '').replace(/[^\d+]/g, '');
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
    CallerID: `"${String(config.fax.stationId || 'Telno').replace(/"/g, '')}" <${row.from_e164 || digits}>`,
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

const TERMINAL = /COMPLETE|SUCCESS|FAILED|ERROR/i;

/**
 * Fax events arrive on the AMI session the platform already runs for calls.
 * A send is finished when res_fax reports a result, or — if the trunk drops the
 * call before it says anything — at hangup, which is then a failure with the
 * switch's own cause rather than a row stuck at `sending` forever.
 */
export function onFaxEvent(msg) {
  try {
    if (msg.Event === 'OriginateResponse') {
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

    if (msg.Event === 'FaxStatus') {
      const faxId = byUniqueid.get(msg.Uniqueid) || String(msg['TELNO_FAX_ID'] || '') || '';
      if (!faxId) return;
      const detail = msg.FaxStatusString || msg['FAXOPT(statusstr)'] || '';
      const status = msg.FaxStatus || msg['FAXOPT(status)'] || '';
      if (!TERMINAL.test(status) && !/complete|success|fail/i.test(detail)) return;
      const pages = Number(msg.PagesTransferred || msg['FAXOPT(pages)'] || 0) || 0;
      const failed = /fail|error/i.test(status) || /fail|error/i.test(detail);
      lastStatus.set(msg.Uniqueid, failed ? 'failed' : 'sent');
      setStatus(faxId, failed ? 'failed' : 'sent', {
        pages: pages || undefined,
        error: failed ? detail.slice(0, 240) || status.slice(0, 240) : '',
      });
      logEvent({
        actor: 'switch',
        action: failed ? 'fax.send_failed' : 'fax.sent',
        subject: faxId,
        detail: `${pages || '?'} page(s) ${detail}`.trim(),
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
 * Read what the switch received.
 *
 * The receipt file is written by the dialplan after ReceiveFax returns, so its
 * presence means the document is complete — reading the TIFF before that would
 * pick up a partial page. Successful documents are moved into the media store
 * and the receipt is deleted; a failed reception is recorded with the switch's
 * status so "the fax never arrived" has a reason attached.
 */
export function sweepReceived() {
  if (!config.fax.enabled) return { ingested: 0 };
  const d = ensureFaxDirs();
  let ingested = 0;
  let entries = [];
  try {
    entries = readdirSync(d.status).filter((name) => name.endsWith('.done'));
  } catch {
    return { ingested: 0 };
  }

  for (const entry of entries) {
    const file = join(d.status, entry);
    let line = '';
    try {
      line = readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    const [kind, uniqueid, status, pages, caller, did] = line.split('|');
    if (kind !== 'in' || !uniqueid) {
      // An unreadable receipt is removed rather than retried forever.
      try {
        unlinkSync(file);
      } catch {
        /* nothing else to do */
      }
      continue;
    }

    const document = join(d.in, `${uniqueid}.tif`);
    const succeeded = /SUCCESS|COMPLETE/i.test(String(status || ''));
    const pageCount = Number(pages) || 0;
    const from = String(caller || '').trim();
    const to = String(did || '').trim();
    const number = to ? db_.get('SELECT * FROM numbers WHERE e164 = ?', [to]) : null;

    if (succeeded && existsSync(document) && statSync(document).size > 0) {
      const name = mediaName('fax', 'tif');
      saveMedia(name, readFileSync(document));
      const id = newId('fax_');
      db_.run(
        `INSERT INTO faxes (id, direction, number_id, from_e164, to_e164, pages, status, subject, body, document, attachment, attachment_name, at, error)
         VALUES (?, 'inbound', ?, ?, ?, ?, 'received', ?, '', '', ?, ?, ?, '')`,
        [
          id,
          number?.id || null,
          from,
          to,
          pageCount || 1,
          'Inbound fax',
          name,
          `${uniqueid}.tif`,
          now(),
        ]
      );
      ingested += 1;
      logEvent({ actor: 'switch', action: 'fax.received', subject: to || from, detail: `${pageCount || '?'} page(s)` });
    } else if (!succeeded) {
      const id = newId('fax_');
      db_.run(
        `INSERT INTO faxes (id, direction, number_id, from_e164, to_e164, pages, status, subject, body, document, attachment, attachment_name, at, error)
         VALUES (?, 'inbound', ?, ?, ?, ?, 'failed', ?, '', '', '', '', ?, ?)`,
        [id, number?.id || null, from, to, pageCount || 0, 'Inbound fax failed', now(), String(status || 'no result').slice(0, 240)]
      );
      logEvent({ actor: 'switch', action: 'fax.receive_failed', subject: to || from, detail: String(status || '') });
    }

    // The receipt and the raw TIFF are both disposable once the document is in
    // the media store: the row is now the record, and the copy is the one the
    // console serves.
    for (const path of [file, document]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* the next sweep will not see the receipt again */
      }
    }
  }
  return { ingested };
}

let sweeper = null;

export function startFax() {
  if (sweeper || !config.fax.enabled) return;
  ensureFaxDirs();
  const every = Math.max(5, config.fax.sweepSeconds) * 1000;
  sweeper = setInterval(() => {
    try {
      sweepReceived();
    } catch (err) {
      console.error('[fax] sweep failed', err.message);
    }
  }, every);
  if (sweeper.unref) sweeper.unref();
  // A restart is not a reason to lose a document that arrived while the API was
  // down: the receipt is still on the volume, so one sweep at boot catches up.
  try {
    sweepReceived();
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
