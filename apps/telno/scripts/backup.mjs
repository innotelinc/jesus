#!/usr/bin/env node
/**
 * Backups from the command line.
 *
 * The console has the same operations under Settings → Data backups; this
 * exists for the two cases a browser is the wrong tool for: a host-side cron,
 * and a shell inside the container when the platform is not answering.
 *
 *   node scripts/backup.mjs                      take one
 *   node scripts/backup.mjs --list               what is on the volume
 *   node scripts/backup.mjs --inspect <name>     what an archive holds
 *   node scripts/backup.mjs --restore <name>     put one back (asks first)
 *   node scripts/backup.mjs --prune [--keep 3]   drop the oldest
 *
 * A restore replaces the database file. Stop the platform first if it is
 * running (`docker compose stop telno`), restore, then start it again.
 */
import { createInterface } from 'node:readline/promises';
import {
  backupDir,
  dbPath,
  deleteBackup,
  inspectBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  runBackup,
} from '../src/lib/backup.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const human = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// Stamps are YYYYMMDD-HHMMSS: a sortable name, rendered readably.
const short = (value) =>
  `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(9, 11)}:${value.slice(11, 13)}`;

if (flag('list')) {
  const items = listBackups();
  console.log(`backups in ${backupDir()}`);
  if (!items.length) console.log('  none');
  for (const item of items) {
    const calls = item.counts?.calls ?? '?';
    console.log(`  ${item.name}  ${human(item.bytes)}  ${short(item.stamp)}  ${item.label}  ${calls} calls`);
  }
  process.exit(0);
}

if (flag('inspect')) {
  const name = value('inspect');
  const result = await inspectBackup(name);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (flag('prune')) {
  const keep = Number(value('keep', '')) || undefined;
  const removed = pruneBackups(keep);
  console.log(removed.length ? `removed:\n  ${removed.join('\n  ')}` : 'nothing to remove');
  process.exit(0);
}

if (flag('delete')) {
  const result = deleteBackup(value('delete'));
  console.log(result.ok ? `deleted ${value('delete')}` : `could not delete: ${result.error}`);
  process.exit(result.ok ? 0 : 1);
}

if (flag('restore')) {
  const name = value('restore');
  const preview = await inspectBackup(name);
  if (!preview.ok) {
    console.error(`No usable backup named ${name} (${preview.error})`);
    process.exit(1);
  }

  console.log(`Restoring ${name}`);
  console.log(`  database  ${dbPath()}`);
  console.log(`  media     ${preview.manifest?.recordings?.files ?? 0} files`);
  console.log(`  taken     ${preview.manifest?.created_at || 'unknown'}`);
  console.log(`  contents  ${JSON.stringify(preview.manifest?.counts || {})}`);
  if (preview.manifest?.secrets_not_included) {
    console.log(`  note      the archive does not carry ${preview.manifest.secrets_not_included.join(', ')}`);
  }

  if (!flag('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Replace the live database with this archive? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('nothing changed');
      process.exit(0);
    }
  }

  const result = await restoreBackup(name);
  if (!result.ok) {
    console.error(`Restore failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`restored ${name}: ${JSON.stringify(result.records)}`);
  console.log('Start the platform again to serve it.');
  process.exit(0);
}

const result = await runBackup({ label: value('label', 'cli') });
if (!result.ok) {
  console.error(`Backup failed: ${result.error}`);
  process.exit(1);
}
console.log(`${result.name}  ${human(result.bytes)}`);
console.log(`  path      ${result.path}`);
console.log(`  contents  ${JSON.stringify(result.manifest.counts)}`);
console.log(`  media     ${result.manifest.recordings.files} files, ${human(result.manifest.recordings.bytes)}`);
if (result.pruned.length) console.log(`  pruned    ${result.pruned.join(', ')}`);
