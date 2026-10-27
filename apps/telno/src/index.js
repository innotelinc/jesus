import { buildApp } from './app.js';
import { config, assertConfig } from './config.js';
import { getDb, db_, newId, now } from './db/index.js';
import { hashPassword } from './lib/security.js';
import { logEvent } from './lib/audit.js';
import { startTelephony } from './telephony/index.js';
import { startLineEvents } from './routes/softphone.js';
import { writeConfigs } from './telephony/provision.js';
import { startReminderSweep } from './lib/reminders.js';
import { startRentalSweep } from './lib/rentals.js';
import { startMonthlyInvoicing } from './lib/invoicing.js';
import { applyStagedRestore, startBackupSchedule, setRestoreHandler } from './lib/backup.js';
import { seedCommerce } from './lib/subscriptions.js';
import { seedBrand } from './lib/brand.js';
import { writeFirstRunPassword } from './lib/firstRun.js';
import { sendWelcome } from './lib/onboarding.js';
import { randomBytes } from 'node:crypto';

assertConfig();

// A restore staged from the console (Settings → Data backups) is applied here,
// before anything opens the database — the one moment the file can be swapped
// without a live connection pointing at the old one.
const stagedRestore = await applyStagedRestore();
getDb();
if (stagedRestore.applied) {
  console.log(`[backup] restored ${stagedRestore.name} (staged by ${stagedRestore.stagedBy}); ${stagedRestore.records?.calls ?? 0} calls in the archive`);
} else if (stagedRestore.failed) {
  console.error(`[backup] staged restore failed: ${stagedRestore.error} ${stagedRestore.detail || ''}`);
}

/** First boot must work without a manual step: create the owner account. */
function ensureOwner() {
  const { n } = db_.get('SELECT COUNT(*) AS n FROM accounts') || { n: 0 };
  if (n > 0) return;

  const password = config.adminPassword || randomBytes(9).toString('base64url');
  const id = newId('acc_');
  db_.run('INSERT INTO accounts (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [
    id,
    config.adminEmail,
    'Owner',
    hashPassword(password),
    'owner',
  ]);
  logEvent({ actor: 'system', action: 'account.bootstrap', subject: config.adminEmail });

  // The first message this platform ever sends: what the account is and what to
  // do first. Not awaited — a boot must not wait on a mail provider, and the row
  // it belongs to is already committed — and never sent twice, which the stamp
  // on the row is what makes true.
  sendWelcome(db_.get('SELECT * FROM accounts WHERE id = ?', [id]))
    .then((result) => {
      if (result.sent) console.log(`[welcome] sent to ${config.adminEmail} via ${result.channel}`);
      else if (!result.skipped) console.warn(`[welcome] not delivered: ${result.error}`);
    })
    .catch((err) => console.warn(`[welcome] could not send: ${err.message}`));

  if (!config.adminPassword) {
    // Written to the data volume rather than printed: a log is copied into
    // scrollbacks, log drivers and tickets, and the one person who needs this
    // password is the one who can read the volume. Setting your own password
    // deletes the file (see auth.js), because the generated one dies then.
    const file = writeFirstRunPassword(config.adminEmail, password);
    console.log('\n' + '='.repeat(64));
    console.log('  First run — owner account created');
    console.log(`  Email:    ${config.adminEmail}`);
    console.log(`  Password: written to ${file}`);
    console.log('  Change it under Account in the console — that deletes this file.');
    console.log('  Set ADMIN_PASSWORD in .env to choose one up front instead.');
    console.log('='.repeat(64) + '\n');
  } else {
    console.log(`[bootstrap] owner account ready: ${config.adminEmail}`);
  }
}

ensureOwner();
// A fresh install has something to sell: the starter plans and the feature
// catalog are inserted only when they are missing, so an operator's edits are
// never overwritten by a restart.
seedCommerce();
// The brand defaults are rows too: a white-label deployment edits them in
// Settings, and a restart must never overwrite that edit.
seedBrand();

// Generate Asterisk configuration up front so a fresh container can register
// endpoints before anyone opens the UI.
if (config.telephony.configDir) {
  const written = writeConfigs();
  console.log(`[telephony] generated Asterisk config in ${written.dir || config.telephony.configDir}`);
}

// `node src/index.js --provision-only` boots the switch from the database and
// exits — the container entrypoint uses it before Asterisk starts.
if (process.argv.includes('--provision-only')) {
  console.log('[provision] configuration written, exiting');
  process.exit(0);
}

startTelephony();
// Line events (a call ringing, a call parked) drive the push that wakes a
// phone. They are followed from boot because the phone that is not in the
// console is the one that most needs the call.
startLineEvents();

const app = await buildApp();

let stopReminders = () => {};
let stopBackups = () => {};
let stopRentals = () => {};
let stopInvoicing = () => {};

try {
  await app.listen({ port: config.port, host: config.host });
  // Billing automation starts with the process: a restart resumes reminding
  // without an operator remembering to switch it back on.
  stopReminders = startReminderSweep();
  // Rented numbers accrue rent whether or not anybody opens the console, so the
  // month is recorded on its own — and idempotently, so a restart is harmless.
  // Rent then becomes a line on the account's invoice, which is the difference
  // between the platform knowing what a number costs and the customer seeing it.
  const stopRentSweep = startRentalSweep();
  stopRentals = stopRentSweep;
  stopInvoicing = startMonthlyInvoicing();
  // Backups too, and for the same reason. The first one waits a full interval.
  stopBackups = startBackupSchedule();
  console.log(
    `[telno] ${config.isProd ? 'production' : 'development'} on http://${config.host}:${config.port} ` +
      `(${config.directory.domains.length} directory hosts, telephony ${config.telephony.simulate ? 'simulated' : 'AMI'})`
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  console.log(`[telno] ${signal} received, shutting down`);
  stopReminders();
  stopRentals();
  stopInvoicing();
  stopBackups();
  try {
    await app.close();
  } catch (err) {
    console.error('[telno] close failed', err.message);
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A restore replaces the database file on disk, which the running process still
// has open. The safe end to that is a restart, and under the container's
// supervisor that restart is immediate — so the platform does it rather than
// asking an operator to remember. The response is flushed first.
setRestoreHandler(() => {
  console.log('[telno] restore written; restarting to load it');
  setTimeout(() => shutdown('restore'), 1000);
});
