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
    // v9: marketing runs. The dialer extension is the line that places the
    // calls, and the run timestamp lets the console show when a list was last
    // worked instead of guessing from the contacts.
    ['campaigns', 'dialer_extension', "TEXT NOT NULL DEFAULT ''"],
    ['campaigns', 'last_run_at', 'TEXT'],
    // v10: the subscriber portal. A customer account is not a staff account:
    // it exists to hold a subscription, and it is the only kind that is gated
    // on paying. Staff are never locked out by the commerce side.
    ['accounts', 'account_kind', "TEXT NOT NULL DEFAULT 'staff'"],
    // v11: flat-rate plans. Selling per seat gave way to one price with
    // unlimited calling, and the catalog gained a residential audience that
    // the public pages group separately from the business ladder. Defaulting
    // minutes_unlimited to 1 stamps the plans that already exist.
    ['plans', 'minutes_unlimited', 'INTEGER NOT NULL DEFAULT 1'],
    ['plans', 'audience', "TEXT NOT NULL DEFAULT 'business'"],
    // v12: a line belongs to somebody. Extensions and numbers carry the account
    // that holds them, so a customer's portal can show their own line — and so
    // the softphone can refuse to mint a session for a line that is not theirs.
    ['extensions', 'account_id', 'TEXT'],
    ['numbers', 'account_id', 'TEXT'],
    // v13: numbers can be bought from a carrier instead of typed in. The
    // provider link and its cost live on the row, so a release knows which DID
    // to cancel and the bill knows what the line costs.
    ['numbers', 'provider', "TEXT NOT NULL DEFAULT ''"],
    ['numbers', 'provider_ref', "TEXT NOT NULL DEFAULT ''"],
    ['numbers', 'monthly_cost_cents', 'INTEGER NOT NULL DEFAULT 0'],
    ['numbers', 'cost_currency', "TEXT NOT NULL DEFAULT 'USD'"],
    ['numbers', 'next_billing_at', 'TEXT'],
    ['numbers', 'rented_at', 'TEXT'],
    ['numbers', 'released_at', 'TEXT'],
    // v14: rent on the bill, not only in the ledger. An invoice now names the
    // account it bills and the month it bills rent for, and its amount is the
    // sum of the line items a customer can read.
    ['invoices', 'account_id', 'TEXT'],
    ['invoices', 'rent_period', "TEXT NOT NULL DEFAULT ''"],
    // v15: the first-login confirmation. What the customer says about themselves
    // and whether their numbers may appear in the public directory.
    ['accounts', 'company', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'address', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'city', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'country', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'website', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'listing_kind', "TEXT NOT NULL DEFAULT 'business'"],
    ['accounts', 'directory_opt_in', 'INTEGER NOT NULL DEFAULT 0'],
    ['accounts', 'profile_confirmed_at', 'TEXT'],
    // v16: SCIF. A line can withhold its caller ID, never record, ask for a
    // masked voice and have identifiers redacted in the app.
    ['extensions', 'scif', 'INTEGER NOT NULL DEFAULT 0'],
    ['extensions', 'caller_id_mode', "TEXT NOT NULL DEFAULT 'own'"],
    ['extensions', 'caller_id_number', "TEXT NOT NULL DEFAULT ''"],
    ['extensions', 'voice_mask', "TEXT NOT NULL DEFAULT 'off'"],
    ['extensions', 'mask_text', 'INTEGER NOT NULL DEFAULT 0'],
    // v17: one monthly invoice per account. A line says whether it is payable on
    // the bill or already collected by a card subscription.
    ['invoice_items', 'settled_by', "TEXT NOT NULL DEFAULT 'invoice'"],
    // v18: a line can require a recent voiceprint check before it hands out SIP
    // credentials, and the native app registers a push token per line.
    ['extensions', 'voice_auth', 'INTEGER NOT NULL DEFAULT 0'],
    // v19: the required first login. Accepting the terms is recorded with the
    // version that was accepted, so a later revision can ask again instead of
    // inheriting an old yes; the address and the phone are proven, not asserted;
    // and the welcome message is stamped so a restart cannot repeat it.
    ['accounts', 'terms_accepted_at', 'TEXT'],
    ['accounts', 'terms_version', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'email_verified_at', 'TEXT'],
    ['accounts', 'phone', "TEXT NOT NULL DEFAULT ''"],
    ['accounts', 'phone_verified_at', 'TEXT'],
    ['accounts', 'welcome_sent_at', 'TEXT'],
    // v21: fax on the switch. A number says whether it answers as voice or as a
    // fax machine, and a fax row records why a transmission failed instead of
    // only that it did.
    ['numbers', 'fax_mode', "TEXT NOT NULL DEFAULT 'voice'"],
    ['faxes', 'error', "TEXT NOT NULL DEFAULT ''"],
    // The switch's own file for a fax: the TIFF staged for a send, or the
    // document a receive produced, so the row points at the artefact.
    ['faxes', 'station_id', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, column, type] of additions) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // A plan sold before flat-rate plans existed has no audience and no unlimited
  // flag of its own: give it both once, so an upgrade keeps selling the same
  // three plans under the new pricing instead of leaving them metered.
  db.exec("UPDATE plans SET minutes_unlimited = 1 WHERE minutes_unlimited IS NULL");
  db.exec("UPDATE plans SET audience = 'business' WHERE audience IS NULL OR audience = ''");

  // v20: the first-login wizard asks which line is yours, so the switch's own
  // inventory has to have an owner. Lines and numbers made before accounts owned
  // them carry no account at all, and an install that upgraded into the wizard
  // would otherwise be told to add a line it already has — forever, because the
  // step counts lines that belong to the account.
  //
  // Ownership is granted once, to the owner account, and only to numbers that
  // are attached to one of those lines: a registry row that nobody holds is not
  // the owner's number and stays unowned.
  const inventoryOwner = db.prepare("SELECT id FROM accounts WHERE role = 'owner' ORDER BY created_at LIMIT 1").get();
  if (inventoryOwner) {
    db.prepare('UPDATE extensions SET account_id = ? WHERE account_id IS NULL').run(inventoryOwner.id);
    db.prepare(
      `UPDATE numbers SET account_id = ?
        WHERE account_id IS NULL AND id IN (SELECT number_id FROM extensions WHERE number_id IS NOT NULL)`
    ).run(inventoryOwner.id);
  }

  // Ownership lookups are per account and happen on every portal load. Created
  // here, after the columns above, so an upgrade never indexes a column that
  // does not exist yet.
  db.exec('CREATE INDEX IF NOT EXISTS idx_extensions_account ON extensions (account_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_numbers_account ON numbers (account_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices (account_id)');
  // One invoice per account per rent month. Created here rather than in the
  // schema so an existing database has the columns before it is indexed.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_rent_period ON invoices (account_id, rent_period) WHERE rent_period <> ''"
  );
  // One rent line per number per month on a given invoice. Scoped to the invoice
  // rather than globally, so a voided bill keeps the lines it printed while a
  // corrected invoice can carry the same month.
  db.exec('DROP INDEX IF EXISTS idx_invoice_items_rent');
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_rent ON invoice_items (invoice_id, number_id, period) WHERE kind = 'number_rent'"
  );
  // One plan line per monthly invoice, whatever a rerun or a retry does. A
  // database that already carries two plan lines on a bill was edited by hand;
  // that is left alone rather than failed on at boot, and the engine's own
  // check still stops it adding a third.
  const duplicatePlans = db
    .prepare("SELECT invoice_id FROM invoice_items WHERE kind = 'plan' GROUP BY invoice_id HAVING COUNT(*) > 1 LIMIT 1")
    .get();
  if (!duplicatePlans) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_plan ON invoice_items (invoice_id) WHERE kind = 'plan'"
    );
  } else {
    console.warn(`[db] leaving ${duplicatePlans.invoice_id} with more than one plan line; not indexing it`);
  }

  // Money that moved before the ledger existed. A bill marked paid with no
  // payment row is a gap the customer panel would show as "settled for free",
  // so each one gets its row once. The partial unique index is what makes the
  // backfill idempotent, and what stops two Stripe events ever paying one bill
  // twice on the ledger.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_invoice ON payments (invoice_id) WHERE method = 'stripe' AND invoice_id IS NOT NULL"
  );
  const settled = db
    .prepare(
      `SELECT i.id, i.account_id, i.email, i.amount_cents, i.currency, i.paid_at, i.payment_ref
         FROM invoices i
        WHERE i.status = 'paid'
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.method = 'stripe')`
    )
    .all();
  if (settled.length) {
    const ownerOf = db.prepare('SELECT id FROM accounts WHERE lower(email) = lower(?)');
    const insertPayment = db.prepare(
      `INSERT OR IGNORE INTO payments
         (id, account_id, invoice_id, amount_cents, currency, method, reference, note, received_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'stripe', ?, 'backfilled from a bill already marked paid', ?, 'system')`
    );
    for (const row of settled) {
      insertPayment.run(
        newId('pay_'),
        row.account_id || ownerOf.get(row.email || '')?.id || null,
        row.id,
        row.amount_cents,
        row.currency || 'USD',
        row.payment_ref || '',
        row.paid_at || now()
      );
    }
    console.log(`[db] recorded ${settled.length} payment(s) for bills already marked paid`);
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
