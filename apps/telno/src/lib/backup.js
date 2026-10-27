import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from './audit.js';
import { extractArchive, packDirectory, readFileFromArchive } from './tar.js';

/**
 * Backups of the data volume.
 *
 * What is in one: the database, dumped with `VACUUM INTO` so a running instance
 * produces a consistent snapshot rather than a torn file, plus the media tree
 * (call recordings, voicemail audio, fax attachments) and a manifest that says
 * what the archive holds.
 *
 * What is deliberately NOT in one: the persisted secrets in the data directory
 * (`session.secret`, `api-key.pepper`, `ami.secret`). An archive that carried
 * them would be simultaneous access to the database and to every decrypted
 * credential in the vault. A restore on new hardware therefore needs those three
 * files carried over by hand, and the manifest names them so that is a
 * checklist item rather than a discovery.
 */

const SECRET_FILES = ['session.secret', 'api-key.pepper', 'ami.secret'];

/** Tables worth counting in a manifest: a restore is only as good as its proof. */
const COUNTED_TABLES = [
  'accounts',
  'numbers',
  'listings',
  'extensions',
  'trunks',
  'calls',
  'voicemails',
  'faxes',
  'messages',
  'invoices',
  'devices',
  'sites',
];

// `stamp()` produces YYYYMMDD-HHMMSS, which sorts lexicographically as written.
const ARCHIVE = /^telno-\d{8}-\d{6}\.tar\.gz$/;
const STAMP = /^\d{8}-\d{6}$/;

export const backupDir = () => config.backup.dir || join(config.dataDir, 'backups');
export const dbPath = () => config.dbFile || join(config.dataDir, 'telno.db');

/** A timestamp that sorts lexicographically, so "newest" needs no parsing. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}


function counts() {
  const out = {};
  for (const table of COUNTED_TABLES) {
    try {
      out[table] = db_.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
    } catch {
      /* a table this version does not have */
    }
  }
  return out;
}

function dirSize(path) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  try {
    walk(path);
  } catch {
    /* nothing to measure */
  }
  return { files, bytes };
}

/** The manifest beside an archive, or the one inside an extracted directory. */
function readManifest(dir) {
  const file = join(dir, 'manifest.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Take a backup. Returns the manifest plus where it landed. Failures are
 * returned, not thrown: a caller in a sweep needs to record one and carry on.
 *
 * Async because packing streams: a recordings directory is routinely larger
 * than the database, and it should not have to fit in memory to be backed up.
 */
export async function runBackup({ label = 'manual', date = new Date() } = {}) {
  const dir = backupDir();
  // Names are second-resolution, and two backups inside one second would be one
  // archive with the first one silently gone. Take the next free second instead:
  // names stay sortable and nothing is overwritten.
  let when = date;
  let name = stamp(when);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 120 && existsSync(join(dir, `telno-${name}.tar.gz`)); attempt += 1) {
    when = new Date(when.getTime() + 1000);
    name = stamp(when);
  }
  const work = join(dir, `telno-${name}`);
  const started = now();
  try {
    mkdirSync(work, { recursive: true });

    // VACUUM INTO writes a consistent copy of a live database, and refuses to
    // overwrite, which is why the target is a path inside this run's own tree.
    const dump = join(work, 'telno.db');
    db_.exec(`VACUUM INTO '${dump.replace(/'/g, "''")}'`);

    // Every piece of customer media lives under one directory.
    const media = config.recordingsDir;
    let mediaStats = { files: 0, bytes: 0, present: false };
    if (existsSync(media)) {
      cpSync(media, join(work, 'recordings'), { recursive: true, force: true });
      mediaStats = { ...dirSize(join(work, 'recordings')), present: true };
    }

    const manifest = {
      kind: 'telno-backup',
      version: 1,
      label,
      created_at: started,
      stamp: name,
      database: { file: 'telno.db', bytes: statSync(dump).size },
      recordings: mediaStats,
      counts: counts(),
      // Named so a restore on new hardware is a checklist, not a surprise.
      secrets_not_included: SECRET_FILES,
      note: 'Restoring on another host also needs those files from the data directory, or the vault cannot be decrypted.',
    };
    writeFileSync(join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const archive = join(dir, `telno-${name}.tar.gz`);
    await packDirectory({ sourceDir: work, archiveFile: archive, prefix: `telno-${name}` });
    rmSync(work, { recursive: true, force: true });

    // The sidecar lets the list endpoint report what an archive holds without
    // unpacking it.
    writeFileSync(join(dir, `telno-${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const bytes = statSync(archive).size;
    const pruned = pruneBackups();
    logEvent({
      actor: 'system',
      action: 'backup.created',
      subject: `telno-${name}.tar.gz`,
      detail: `${Math.round(bytes / 1024)} kB, ${manifest.counts.calls ?? 0} calls, ${mediaStats.files} media files`,
    });

    return {
      ok: true,
      name: `telno-${name}.tar.gz`,
      path: archive,
      bytes,
      pruned,
      manifest,
      startedAt: started,
      finishedAt: now(),
    };
  } catch (err) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* leave it for inspection */
    }
    logEvent({ actor: 'system', action: 'backup.failed', subject: `telno-${name}`, detail: err.message });
    return { ok: false, name: `telno-${name}`, error: err.message, startedAt: started, finishedAt: now() };
  }
}

/** Archives, newest first, with the sidecar summary attached. */
export function listBackups() {
  const dir = backupDir();
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !ARCHIVE.test(entry.name)) continue;
    const full = join(dir, entry.name);
    const stampPart = entry.name.replace(/^telno-/, '').replace(/\.tar\.gz$/, '');
    if (!STAMP.test(stampPart)) continue;
    const stats = statSync(full);
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(join(dir, `telno-${stampPart}.json`), 'utf8'));
    } catch {
      manifest = null;
    }
    items.push({
      name: entry.name,
      stamp: stampPart,
      kind: 'archive',
      bytes: stats.size,
      createdAt: manifest?.created_at || stats.mtime.toISOString(),
      label: manifest?.label || 'unknown',
      counts: manifest?.counts || null,
      recordings: manifest?.recordings || null,
      complete: !!manifest,
    });
  }
  return items.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/** Keep the newest `keep`; remove the rest. Returns what was removed. */
export function pruneBackups(keep = config.backup.keep) {
  const dir = backupDir();
  const removed = [];
  for (const item of listBackups().slice(Math.max(1, keep))) {
    try {
      rmSync(join(dir, item.name), { recursive: true, force: true });
      rmSync(join(dir, `telno-${item.stamp}.json`), { force: true });
      removed.push(item.name);
    } catch {
      /* a locked file keeps its place in the list */
    }
  }
  if (removed.length) {
    logEvent({ actor: 'system', action: 'backup.pruned', subject: removed.join(', '), detail: `kept ${keep}` });
  }
  return removed;
}

/** Remove one archive (and its sidecar) by name. */
export function deleteBackup(name) {
  const resolved = resolveBackup(name);
  if (!resolved.ok) return resolved;
  const stampPart = String(name).replace(/^telno-/, '').replace(/\.tar\.gz$/, '');
  try {
    rmSync(resolved.full, { recursive: true, force: true });
    rmSync(join(backupDir(), `telno-${stampPart}.json`), { force: true });
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function resolveBackup(name) {
  const wanted = String(name || '').trim();
  if (!wanted || wanted.includes('/') || wanted.includes('\\') || wanted.includes('..')) {
    return { ok: false, error: 'invalid-name' };
  }
  const full = join(backupDir(), wanted);
  if (!existsSync(full)) return { ok: false, error: 'not-found' };
  return { ok: true, full };
}

/**
 * What a restore would do, without doing it. The manifest is read straight out
 * of the compressed archive, so inspecting a multi-gigabyte backup costs a
 * few kilobytes of decompression rather than a full extraction.
 */
export async function inspectBackup(name) {
  const resolved = resolveBackup(name);
  if (!resolved.ok) return resolved;
  const item = listBackups().find((entry) => entry.name === name);
  if (item?.counts) return { ok: true, name, manifest: { ...item, counts: item.counts }, records: item.counts };

  try {
    const raw = await readFileFromArchive(resolved.full, 'manifest.json');
    if (!raw) return { ok: false, error: 'manifest-missing' };
    const manifest = JSON.parse(raw);
    return { ok: true, name, manifest, records: manifest.counts || null };
  } catch (err) {
    return { ok: false, error: 'unreadable', detail: err.message };
  }
}

/**
 * Put an archive back on disk.
 *
 * This is the low-level swap, and it must not be called while this process has
 * the database open: the file it replaces is the one under an open connection,
 * and the journal files beside it cannot be removed while they are held. The
 * two safe callers are the CLI (platform stopped) and boot (before `getDb()`),
 * which is what `stageRestore` arranges for the console.
 */
async function swapInArchive(name) {
  const resolved = resolveBackup(name);
  if (!resolved.ok) return resolved;
  if (!ARCHIVE.test(name)) return { ok: false, error: 'not-an-archive' };

  const scratch = join(backupDir(), `.restore-${process.pid}`);
  try {
    mkdirSync(scratch, { recursive: true });
    const extracted = await extractArchive({ archiveFile: resolved.full, destDir: scratch });
    if (!extracted.length) return { ok: false, error: 'extract-failed' };
    const inner = join(scratch, name.replace(/\.tar\.gz$/, ''));
    const source = existsSync(inner) ? inner : scratch;

    const manifest = readManifest(source);
    if (!manifest) return { ok: false, error: 'manifest-missing' };

    const incomingDb = join(source, 'telno.db');
    if (!existsSync(incomingDb)) return { ok: false, error: 'database-missing' };

    // The journal files go first, on purpose: if one of them is still held, the
    // restore stops here rather than after the database has been written into
    // place, and there is no half-restored database to reason about.
    for (const suffix of ['-wal', '-shm']) {
      try {
        rmSync(`${dbPath()}${suffix}`, { force: true });
      } catch (err) {
        return {
          ok: false,
          error: 'journal-held',
          detail: `${dbPath()}${suffix} is open (${err.code || err.message}). Stop the platform before restoring.`,
        };
      }
    }
    try {
      cpSync(incomingDb, `${dbPath()}.incoming`);
      renameSync(`${dbPath()}.incoming`, dbPath());
    } catch (err) {
      rmSync(`${dbPath()}.incoming`, { force: true });
      return { ok: false, error: err.message };
    }

    // Media second, keeping the previous tree beside the new one: if the
    // archive was taken with incomplete media, an operator still has the old
    // files to put back rather than a gap.
    let mediaRestored = false;
    let keptAside = '';
    const restoredMedia = join(source, 'recordings');
    if (existsSync(restoredMedia)) {
      keptAside = `${config.recordingsDir}.pre-restore-${stamp()}`;
      if (existsSync(config.recordingsDir)) renameSync(config.recordingsDir, keptAside);
      mkdirSync(config.recordingsDir, { recursive: true });
      cpSync(restoredMedia, config.recordingsDir, { recursive: true, force: true });
      mediaRestored = true;
    }

    logEvent({
      actor: 'system',
      action: 'backup.restored',
      subject: name,
      detail: `${manifest.counts?.calls ?? 0} calls in the archive; previous media at ${keptAside || 'n/a'}`,
    });

    return {
      ok: true,
      name,
      restoredAt: now(),
      manifest,
      records: manifest.counts || null,
      mediaRestored,
      previousMediaDir: keptAside,
      restartRequired: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const PENDING = () => join(config.dataDir, 'restore.pending.json');
const FAILED = () => join(config.dataDir, 'restore.failed.json');

/**
 * Point the next boot at an archive.
 *
 * The console cannot swap the database out from under itself, so it writes down
 * which archive to apply and asks to be restarted; boot does the swap before
 * anything opens the database. A restart is the honest requirement here — it is
 * also what a person would do by hand — and under the container's supervisor it
 * takes about a second.
 */
export function stageRestore(name, { by = 'system' } = {}) {
  const resolved = resolveBackup(name);
  if (!resolved.ok) return resolved;
  if (!ARCHIVE.test(name)) return { ok: false, error: 'not-an-archive' };
  try {
    writeFileSync(PENDING(), `${JSON.stringify({ name, stagedAt: now(), stagedBy: by }, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  logEvent({ actor: by, action: 'backup.restore_staged', subject: name });
  return { ok: true, staged: true, name, restartRequired: true, plan: { database: dbPath(), recordings: config.recordingsDir } };
}

/** The staged restore, if a boot crashed before it could be applied. */
export function pendingRestore() {
  try {
    return JSON.parse(readFileSync(PENDING(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Apply a staged restore. Called at boot, before the database is opened, and a
 * no-op on every ordinary boot.
 */
export async function applyStagedRestore() {
  const pending = pendingRestore();
  if (!pending?.name) return { applied: false };
  const result = await swapInArchive(pending.name);
  if (result.ok) {
    rmSync(PENDING(), { force: true });
    return { applied: true, ...result, stagedBy: pending.stagedBy || 'system' };
  }
  // Keep the evidence and take the marker out of the way: a boot loop that
  // retries a broken archive every few seconds helps nobody.
  try {
    writeFileSync(FAILED(), `${JSON.stringify({ ...pending, error: result.error, detail: result.detail || '' }, null, 2)}\n`, 'utf8');
    rmSync(PENDING(), { force: true });
  } catch {
    /* nothing further to do about it */
  }
  return { applied: false, failed: true, ...result };
}

/** What the last failed boot-time restore was. */
export function failedRestore() {
  try {
    return JSON.parse(readFileSync(FAILED(), 'utf8'));
  } catch {
    return null;
  }
}

/** The CLI's restore: the platform is expected to be stopped. */
export async function restoreBackup(name, { dryRun = false } = {}) {
  if (dryRun) {
    const preview = await inspectBackup(name);
    if (!preview.ok) return preview;
    return { ...preview, dryRun: true, plan: { database: dbPath(), recordings: config.recordingsDir } };
  }
  return swapInArchive(name);
}

let timer = null;
let running = false;
let lastError = '';

/**
 * Back up on a schedule. The first run waits for one interval: a container that
 * restarts in a loop must not fill its volume with archives taken at boot.
 */
export function startBackupSchedule({ onRestored } = {}) {
  stopBackupSchedule();
  if (!config.backup.enabled || config.backup.intervalHours <= 0) return () => {};
  if (onRestored) setRestoreHandler(onRestored);    timer = setInterval(
      () => {
        if (running) return;
        running = true;
        runBackup({ label: 'scheduled' })
          .then((result) => {
            lastError = result.ok ? '' : result.error || 'unknown';
          })
          .catch((err) => {
            lastError = err.message;
          })
          .finally(() => {
            running = false;
          });
      },
      config.backup.intervalHours * 3600_000
    );
  if (typeof timer.unref === 'function') timer.unref();
  return stopBackupSchedule;
}

export function stopBackupSchedule() {
  if (timer) clearInterval(timer);
  timer = null;
}

let restoreHandler = null;
export const setRestoreHandler = (fn) => {
  restoreHandler = fn;
};

/** Called by the API after a restore has been written to disk. */
export function requestRestartAfterRestore() {
  if (typeof restoreHandler === 'function') restoreHandler();
}

export function backupStatus() {
  const items = listBackups();
  return {
    enabled: config.backup.enabled,
    pendingRestore: pendingRestore()?.name || null,
    failedRestore: failedRestore(),
    intervalHours: config.backup.intervalHours,
    keep: config.backup.keep,
    dir: backupDir(),
    count: items.length,
    lastAt: items[0]?.createdAt || null,
    lastLabel: items[0]?.label || null,
    lastError: lastError || null,
    secretFilesNotIncluded: SECRET_FILES,
  };
}
