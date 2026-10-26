import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

export const newId = (prefix = '') => prefix + randomUUID().replace(/-/g, '').slice(0, 24);
export const now = () => new Date().toISOString();

let db;

/** Open (and migrate) the single SQLite database. Safe to call repeatedly. */
export function getDb() {
  if (db) return db;
  const file = config.dbFile || resolve(config.dataDir, 'telno.db');
  mkdirSync(dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const schema = readFileSync(resolve(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  // v2: a site's device count became a real inventory table. Drop the counter
  // column from older databases so nothing can read a number that no longer
  // describes what is actually installed at the site.
  if (db.prepare('PRAGMA table_info(sites)').all().some((column) => column.name === 'devices')) {
    db.exec('ALTER TABLE sites DROP COLUMN devices');
  }

  // v3: devices authenticate their own check-ins with a hashed token. The
  // column and its index are added here so an existing inventory keeps working.
  if (!db.prepare('PRAGMA table_info(devices)').all().some((column) => column.name === 'token_hash')) {
    db.exec("ALTER TABLE devices ADD COLUMN token_hash TEXT NOT NULL DEFAULT ''");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices (token_hash) WHERE token_hash <> ''");

  // v4: recording choices, media files and fax content are columns added after
  // these tables first shipped. Add them in place so an upgrade keeps its data.
  const additions = [
    ['voice_agents', 'record_inbound', 'INTEGER NOT NULL DEFAULT 0'],
    ['voice_agents', 'record_outbound', 'INTEGER NOT NULL DEFAULT 0'],
    ['voicemails', 'recording', "TEXT NOT NULL DEFAULT ''"],
    ['faxes', 'body', "TEXT NOT NULL DEFAULT ''"],
    ['faxes', 'attachment', "TEXT NOT NULL DEFAULT ''"],
    ['faxes', 'attachment_name', "TEXT NOT NULL DEFAULT ''"],
    ['invoices', 'email', "TEXT NOT NULL DEFAULT ''"],
    ['invoices', 'last_sent_at', 'TEXT'],
    // v5: automatic payment reminders. Pausing one invoice is a column, not a
    // separate table, so a sweep can decide without a join.
    ['invoices', 'reminders_paused', 'INTEGER NOT NULL DEFAULT 0'],
    ['invoices', 'last_reminded_at', 'TEXT'],
    // v6: escalation. A final notice is a kind of ledger row, and suspending a
    // customer is a flag on the login account and on the extension it switched
    // off — so reinstatement can tell its own work from an operator's.
    ['invoice_reminders', 'kind', "TEXT NOT NULL DEFAULT 'reminder'"],
    ['extensions', 'suspended_by_billing', 'INTEGER NOT NULL DEFAULT 0'],
    ['accounts', 'suspended_at', 'TEXT'],
    // v7: paying a notice online. The session and payment reference are kept on
    // the invoice as a receipt so a paid bill can be reconciled with Stripe.
    ['invoices', 'stripe_session_id', "TEXT NOT NULL DEFAULT ''"],
    ['invoices', 'payment_ref', "TEXT NOT NULL DEFAULT ''"],
    // v8: which provider carried the last invoice email, and the reason if it
    // did not. The reminder ledger already records this per rung; the invoice
    // row now says the same for the invoice itself, so "sent" can be traced to
    // a provider without reading the log.
    ['invoices', 'last_provider', "TEXT NOT NULL DEFAULT ''"],
    ['invoices', 'last_send_error', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, column, type] of additions) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  const current = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  if (!current) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '2')").run();
  }

  // Built-in directory hostnames. Insert-if-missing so an operator's edits stick.
  const domains = [
    ['telno.directory', 'Telno Directory', 'The worldwide phonebook, one number at a time.', '#635bff', 10],
    ['num.directory', 'Num Directory', 'Look up any number, anywhere.', '#22d3ee', 20],
    ['number.directory', 'Number Directory', 'Every listing, verified and de-duplicated.', '#34d399', 30],
    ['directory.telno.services', 'Telno Services', 'Business and service lines worldwide.', '#f59e0b', 40],
    ['directory.pbx.services', 'PBX Services', 'Numbers behind hosted and on-premise PBX.', '#a78bfa', 50],
    ['directory.pbx.technology', 'PBX Technology', 'Carrier, SIP and trunk registry.', '#f472b6', 60],
  ];
  const insert = db.prepare(
    `INSERT INTO domains (slug, host, label, tagline, accent, sort_order)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING`
  );
  for (const [host, label, tagline, accent, order] of domains) {
    insert.run(host, host, label, tagline, accent, order);
  }

  // Only hosts from DIRECTORY_DOMAINS are served by the public directory.
  for (const host of config.directory.domains) {
    if (!db.prepare('SELECT 1 FROM domains WHERE host = ?').get(host)) {
      const slug = host;
      insert.run(slug, host, host, '', '#635bff', 500);
    }
  }
}

export const db_ = {
  all(sql, params = []) {
    return getDb().prepare(sql).all(...params);
  },
  get(sql, params = []) {
    return getDb().prepare(sql).get(...params);
  },
  run(sql, params = []) {
    return getDb().prepare(sql).run(...params);
  },
  exec(sql) {
    return getDb().exec(sql);
  },
  /** Synchronous transaction. SQLite is single-writer, so keep these short. */
  tx(fn) {
    const d = getDb();
    d.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(d);
      d.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  },
};

export const sha256 = async (value) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(String(value)).digest('hex');
};

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
