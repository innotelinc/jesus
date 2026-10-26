import { buildApp } from './app.js';
import { config, assertConfig } from './config.js';
import { getDb, db_, newId, now } from './db/index.js';
import { hashPassword } from './lib/security.js';
import { logEvent } from './lib/audit.js';
import { startTelephony } from './telephony/index.js';
import { writeConfigs } from './telephony/provision.js';
import { startReminderSweep } from './lib/reminders.js';
import { randomBytes } from 'node:crypto';

assertConfig();
getDb();

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

  if (!config.adminPassword) {
    // Printed once, only when no password was supplied.
    console.log('\n' + '='.repeat(64));
    console.log('  First run — owner account created');
    console.log(`  Email:    ${config.adminEmail}`);
    console.log(`  Password: ${password}`);
    console.log('  Set ADMIN_PASSWORD in .env to choose your own.');
    console.log('='.repeat(64) + '\n');
  } else {
    console.log(`[bootstrap] owner account ready: ${config.adminEmail}`);
  }
}

ensureOwner();

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

const app = await buildApp();

let stopReminders = () => {};

try {
  await app.listen({ port: config.port, host: config.host });
  // Billing automation starts with the process: a restart resumes reminding
  // without an operator remembering to switch it back on.
  stopReminders = startReminderSweep();
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
  try {
    await app.close();
  } catch (err) {
    console.error('[telno] close failed', err.message);
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
