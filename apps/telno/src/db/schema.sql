-- Telno platform schema. One database, one identity space, one number table.
-- The `numbers` table is the dedupe point: every extension, trunk destination,
-- directory listing, submission and call references `numbers.id`.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- accounts --
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('owner', 'operator', 'viewer')),
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT,
  -- Set when billing suspends the customer. An owner is never suspended by the
  -- sweep: locking the last owner out of the platform is not a billing remedy.
  suspended_at  TEXT,
  -- What the customer confirmed about themselves on their first visit: the name
  -- a directory would publish, a reachable address, and where they are. Kept on
  -- the account rather than on a listing because it is the person, not a line.
  company        TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  city           TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  website        TEXT NOT NULL DEFAULT '',
  listing_kind   TEXT NOT NULL DEFAULT 'business',
  -- The public-directory choice, stated by the customer rather than assumed.
  -- profile_confirmed_at is what makes "first login" a fact instead of a guess.
  directory_opt_in     INTEGER NOT NULL DEFAULT 0,
  profile_confirmed_at TEXT,
  -- First login, in the order the platform asks for it: accept the terms, then
  -- prove the address and the phone are really the account holder's. Each is a
  -- timestamp so the console can say when it happened, not merely that it did.
  terms_accepted_at  TEXT,
  terms_version      TEXT NOT NULL DEFAULT '',
  email_verified_at  TEXT,
  phone              TEXT NOT NULL DEFAULT '',
  phone_verified_at  TEXT,
  -- When the welcome message went out, so a restart cannot send a second one.
  welcome_sent_at    TEXT
);

-- One pending proof per account and channel: a code that was emailed or texted
-- and is waiting to be typed back. The code itself is stored only as a hash, and
-- a row is consumed rather than remembered.
CREATE TABLE IF NOT EXISTS account_verifications (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  target     TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_account_verifications_account
  ON account_verifications (account_id, channel, used_at);

-- Directory surfaces. One codebase, six hostnames, per-host presentation.
CREATE TABLE IF NOT EXISTS domains (
  slug         TEXT PRIMARY KEY,
  host         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  tagline      TEXT NOT NULL DEFAULT '',
  scope        TEXT NOT NULL DEFAULT 'world',      -- 'world' or an ISO country
  accent       TEXT NOT NULL DEFAULT '#635bff',
  sort_order   INTEGER NOT NULL DEFAULT 100,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------- canonical numbers --
CREATE TABLE IF NOT EXISTS numbers (
  id           TEXT PRIMARY KEY,
  e164         TEXT NOT NULL UNIQUE,             -- canonical key, e.g. +14155550123
  country      TEXT NOT NULL DEFAULT '',          -- ISO 3166-1 alpha-2
  national     TEXT NOT NULL DEFAULT '',          -- national significant number
  ext          TEXT NOT NULL DEFAULT '',
  line_type    TEXT NOT NULL DEFAULT 'unknown'
               CHECK (line_type IN ('fixed', 'mobile', 'voip', 'tollfree', 'premium', 'unknown')),
  carrier      TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  timezone     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'registered'
               CHECK (status IN ('registered', 'active', 'reserved', 'ported', 'retired')),
  visibility   TEXT NOT NULL DEFAULT 'public'
               CHECK (visibility IN ('public', 'unlisted', 'private')),
  verified_at  TEXT,
  trust_score  INTEGER NOT NULL DEFAULT 40 CHECK (trust_score BETWEEN 0 AND 100),
  source       TEXT NOT NULL DEFAULT 'manual',
  -- The customer account that holds this number, when it is rented rather than
  -- merely listed. NULL means a registry entry with no owner on the platform.
  account_id   TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  -- The carrier a number was bought from. Empty means an operator typed the
  -- row in; 'voipms' means it was ordered, and this row is the receipt: which
  -- DID to release, what it costs a month, and when it renews.
  provider           TEXT NOT NULL DEFAULT '',
  provider_ref       TEXT NOT NULL DEFAULT '',
  monthly_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_cost_cents >= 0),
  cost_currency      TEXT NOT NULL DEFAULT 'USD',
  next_billing_at    TEXT,
  rented_at          TEXT,
  released_at        TEXT,
  -- How a call to this number is answered: as voice, or straight into the fax
  -- machine. 'auto' answers voice and hands the call to the fax receiver when
  -- the caller's terminal negotiates T.38, which is what a fax modem does.
  fax_mode     TEXT NOT NULL DEFAULT 'voice' CHECK (fax_mode IN ('voice', 'fax', 'auto')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_numbers_country ON numbers (country, status);
CREATE INDEX IF NOT EXISTS idx_numbers_updated ON numbers (updated_at DESC);

-- What a rented number costs, month by month, and which account carries it.
-- One row per number per month: the unique key is what stops a sweep from
-- charging the same month twice, and the account column is what makes the
-- cost answerable per customer rather than only in total.
CREATE TABLE IF NOT EXISTS number_charges (
  id           TEXT PRIMARY KEY,
  number_id    TEXT NOT NULL REFERENCES numbers (id) ON DELETE CASCADE,
  account_id   TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  e164         TEXT NOT NULL,
  period       TEXT NOT NULL,                    -- YYYY-MM, UTC
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency     TEXT NOT NULL DEFAULT 'USD',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'invoiced', 'void')),
  invoice_id   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_number_charges_month ON number_charges (number_id, period);
CREATE INDEX IF NOT EXISTS idx_number_charges_account ON number_charges (account_id, period);

-- Who/what a number belongs to. Several listings per number are legitimate
-- (a business line shared by two teams), but an identical name is not.
CREATE TABLE IF NOT EXISTS listings (
  id          TEXT PRIMARY KEY,
  number_id   TEXT NOT NULL REFERENCES numbers (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'business'
              CHECK (kind IN ('person', 'business', 'service', 'government', 'emergency')),
  category    TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  website     TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  languages   TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  domain_slug TEXT REFERENCES domains (slug) ON DELETE SET NULL,
  verified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (number_id, name_norm)
);
CREATE INDEX IF NOT EXISTS idx_listings_name ON listings (name_norm);
CREATE INDEX IF NOT EXISTS idx_listings_number ON listings (number_id);

-- Full-text search across names, cities and categories (FTS5, no extra process).
CREATE VIRTUAL TABLE IF NOT EXISTS listing_search USING fts5 (
  name, category, city, country, tags,
  content='listings', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS listings_ai AFTER INSERT ON listings BEGIN
  INSERT INTO listing_search (rowid, name, category, city, country, tags)
  VALUES (new.rowid, new.name, new.category, new.city, new.country, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS listings_ad AFTER DELETE ON listings BEGIN
  INSERT INTO listing_search (listing_search, rowid, name, category, city, country, tags)
  VALUES ('delete', old.rowid, old.name, old.category, old.city, old.country, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS listings_au AFTER UPDATE ON listings BEGIN
  INSERT INTO listing_search (listing_search, rowid, name, category, city, country, tags)
  VALUES ('delete', old.rowid, old.name, old.category, old.city, old.country, old.tags);
  INSERT INTO listing_search (rowid, name, category, city, country, tags)
  VALUES (new.rowid, new.name, new.category, new.city, new.country, new.tags);
END;

-- ------------------------------------------------- user-submitted listings --
CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,
  e164              TEXT NOT NULL,
  number_id         TEXT REFERENCES numbers (id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'business',
  category          TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  website           TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  languages         TEXT NOT NULL DEFAULT '',
  tags              TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  domain_slug       TEXT REFERENCES domains (slug) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'awaiting_verification'
                    CHECK (status IN ('awaiting_verification', 'verified', 'approved', 'rejected', 'duplicate', 'expired')),
  verify_channel    TEXT NOT NULL DEFAULT 'email' CHECK (verify_channel IN ('email', 'sms')),
  verify_target     TEXT NOT NULL DEFAULT '',
  code_hash         TEXT,
  code_expires_at   TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  ip_hash           TEXT NOT NULL DEFAULT '',
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  review_note       TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_e164 ON submissions (e164);

-- Refusals. A number listed here is never shown publicly, whatever else says.
CREATE TABLE IF NOT EXISTS optouts (
  e164       TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------- telephony ---
CREATE TABLE IF NOT EXISTS extensions (
  id           TEXT PRIMARY KEY,
  extension    TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  number_id    TEXT REFERENCES numbers (id) ON DELETE SET NULL,
  email        TEXT NOT NULL DEFAULT '',
  secret       TEXT NOT NULL DEFAULT '',
  voicemail    INTEGER NOT NULL DEFAULT 1,
  dnd          INTEGER NOT NULL DEFAULT 0,
  forward_to   TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- 1 means the platform switched this extension off for non-payment, so
  -- reinstatement re-enables it and never an extension an operator disabled.
  suspended_by_billing INTEGER NOT NULL DEFAULT 0,
  -- Whose line this is. NULL is a platform or staff extension, which is what
  -- every extension was before customers could hold one.
  account_id   TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  -- SCIF: the secure profile. Encryption is mandatory either way; these decide
  -- whether the line withholds its identity and never records.
  scif              INTEGER NOT NULL DEFAULT 0,
  caller_id_mode    TEXT NOT NULL DEFAULT 'own',
  caller_id_number  TEXT NOT NULL DEFAULT '',
  voice_mask        TEXT NOT NULL DEFAULT 'off',
  mask_text         INTEGER NOT NULL DEFAULT 0,
  -- The native app can ring this line while the phone is locked. CallKit needs
  -- a VoIP push, and the push needs a device token somebody registered.
  voice_auth        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS trunks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  provider    TEXT NOT NULL DEFAULT 'generic',
  host        TEXT NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  secret      TEXT NOT NULL DEFAULT '',
  from_user   TEXT NOT NULL DEFAULT '',
  codecs      TEXT NOT NULL DEFAULT 'ulaw,alaw',
  context     TEXT NOT NULL DEFAULT 'from-trunk',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS ivr_flows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  extension  TEXT NOT NULL,
  greeting   TEXT NOT NULL DEFAULT 'Welcome. Press 1 for sales, 2 for support.',
  options    TEXT NOT NULL DEFAULT '[]',  -- JSON: [{digit,target,label}]
  timeout_dest TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- CDR, ingested from AMI events. Idempotent on call_id so replays are safe.
CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  call_id     TEXT NOT NULL UNIQUE,
  direction   TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound', 'internal')),
  from_number TEXT NOT NULL DEFAULT '',   -- as presented by the switch
  to_number   TEXT NOT NULL DEFAULT '',
  extension   TEXT NOT NULL DEFAULT '',
  trunk       TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  answered_at TEXT,
  ended_at    TEXT,
  duration    INTEGER NOT NULL DEFAULT 0,
  billsec     INTEGER NOT NULL DEFAULT 0,
  disposition TEXT NOT NULL DEFAULT 'unknown'
              CHECK (disposition IN ('answered', 'busy', 'no-answer', 'failed', 'congestion', 'voicemail', 'unknown')),
  hangup_cause TEXT NOT NULL DEFAULT '',
  recording   TEXT NOT NULL DEFAULT '',
  cost        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_numbers ON calls (from_number, to_number);

-- -------------------------------------------------------- ops & access -----
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL DEFAULT 'registry:read',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor   TEXT NOT NULL DEFAULT 'system',
  action  TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  detail  TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at DESC);

CREATE TABLE IF NOT EXISTS merges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  into_id    TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Provider credentials (a mail key, an SMS token). The value is AES-256-GCM
-- ciphertext under a key derived from SESSION_SECRET; `hint` is the last four
-- characters so an operator can tell two keys apart without seeing either.
-- The API reads values server-side and never returns them.
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  cipher     TEXT NOT NULL,
  hint       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL DEFAULT ''
);

-- ========================================================== workspace =======
-- The console's operational surface: voice, automation, messaging, billing,
-- estate and run-time health. Every table that can point at a phone number
-- references the canonical `numbers` row, never a free-text copy, so the
-- registry stays the single source of truth (and dedupe keeps working).

-- Voice agents: personas that answer or place calls, either AI or IVR scripts.
CREATE TABLE IF NOT EXISTS voice_agents (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  voice            TEXT NOT NULL DEFAULT 'aria',
  language         TEXT NOT NULL DEFAULT 'en-US',
  model            TEXT NOT NULL DEFAULT 'telno-voice-1',
  greeting         TEXT NOT NULL DEFAULT '',
  prompt           TEXT NOT NULL DEFAULT '',
  number_id        TEXT REFERENCES numbers (id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'active', 'paused')),
  -- Recording is per direction: a compliance desk may need both legs kept,
  -- while a support line may only keep inbound.
  record_inbound   INTEGER NOT NULL DEFAULT 0,
  record_outbound  INTEGER NOT NULL DEFAULT 0,
  calls_handled    INTEGER NOT NULL DEFAULT 0,
  avg_handling_sec INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Automation flows. `steps` is an ordered JSON array of typed actions; the
-- runner is deliberately small so a flow stays inspectable.
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  trigger     TEXT NOT NULL DEFAULT 'inbound'
              CHECK (trigger IN ('inbound', 'outbound', 'schedule', 'webhook', 'manual')),
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'active', 'paused')),
  steps       TEXT NOT NULL DEFAULT '[]',
  runs        INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('success', 'failed') OR last_status IS NULL),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS voicemails (
  id          TEXT PRIMARY KEY,
  extension   TEXT NOT NULL DEFAULT '',
  number_id   TEXT REFERENCES numbers (id) ON DELETE SET NULL,
  from_e164   TEXT NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,
  transcript  TEXT NOT NULL DEFAULT '',
  -- File name inside the recordings volume, or '' when there is no audio.
  recording   TEXT NOT NULL DEFAULT '',
  urgent      INTEGER NOT NULL DEFAULT 0,
  listened    INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_voicemails_received ON voicemails (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_voicemails_unread ON voicemails (listened, received_at DESC);

CREATE TABLE IF NOT EXISTS faxes (
  id          TEXT PRIMARY KEY,
  direction   TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  number_id   TEXT REFERENCES numbers (id) ON DELETE SET NULL,
  from_e164   TEXT NOT NULL DEFAULT '',
  to_e164     TEXT NOT NULL DEFAULT '',
  pages       INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'received'
              CHECK (status IN ('queued', 'sending', 'sent', 'received', 'failed')),
  subject     TEXT NOT NULL DEFAULT '',
  document    TEXT NOT NULL DEFAULT '',
  -- A fax is either a plain-text message or an uploaded PDF/image.
  body        TEXT NOT NULL DEFAULT '',
  attachment  TEXT NOT NULL DEFAULT '',
  attachment_name TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_faxes_at ON faxes (at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel    TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'mms', 'whatsapp', 'web')),
  direction  TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
  number_id  TEXT REFERENCES numbers (id) ON DELETE SET NULL,
  from_e164  TEXT NOT NULL DEFAULT '',
  to_e164    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'received')),
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages (sent_at DESC);

-- Internal secure messaging: a message between two people on this platform,
-- carried by nothing but this database. There is no carrier, no per-message fee
-- and no third party in the path, which is the whole point of it. The body is
-- sealed (AES-256-GCM) before it is written, so a copy of the database file is
-- not a copy of the conversations in it.
CREATE TABLE IF NOT EXISTS secure_messages (
  id          TEXT PRIMARY KEY,
  -- One conversation, named by both participants in a stable order.
  thread_id   TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
  -- Who wrote it and who it is for, as platform identities (email or extension).
  from_label  TEXT NOT NULL DEFAULT '',
  to_label    TEXT NOT NULL DEFAULT '',
  account_id  TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  extension   TEXT NOT NULL DEFAULT '',
  body_cipher TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'delivered'
              CHECK (status IN ('queued', 'delivered', 'read', 'failed')),
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_secure_messages_thread ON secure_messages (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secure_messages_account ON secure_messages (account_id, created_at DESC);

-- Billing. Money is integer minor units, never floats, so invoice totals cannot
-- drift when they are summed.
CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  invoice_no    TEXT NOT NULL UNIQUE,
  account_name  TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'open', 'paid', 'overdue', 'void')),
  issued_at     TEXT,
  due_at        TEXT,
  paid_at       TEXT,
  last_sent_at  TEXT,
  -- Which provider carried the last invoice email, and why it failed if it did.
  -- A provider outage has to be answerable per message, not per deployment.
  last_provider    TEXT NOT NULL DEFAULT '',
  last_send_error  TEXT NOT NULL DEFAULT '',
  -- Automatic reminders: paused per invoice, and the last time one went out.
  reminders_paused     INTEGER NOT NULL DEFAULT 0,
  last_reminded_at     TEXT,
  -- Online payment: the Stripe session a customer was sent to, and the payment
  -- reference that settled it. Both are receipts, never credentials.
  stripe_session_id    TEXT NOT NULL DEFAULT '',
  payment_ref          TEXT NOT NULL DEFAULT '',
  -- The account the invoice bills, when it bills one. An invoice addressed only
  -- to an email cannot answer "whose line rent is this?".
  account_id           TEXT,
  -- The month this invoice bills rent for, empty for a one-off bill. The unique
  -- index below is what stops a rerun creating a second invoice for the month.
  rent_period          TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status, due_at);

-- Every reminder ever attempted, in order. A stage is a day past due, and the
-- unique key is what stops two sweeps sending the same stage twice; 'skipped'
-- records a stage the ladder passed over so a backlog cannot fire a burst.
CREATE TABLE IF NOT EXISTS invoice_reminders (
  id           TEXT PRIMARY KEY,
  invoice_id   TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  stage_days   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'sending'
               CHECK (status IN ('sending', 'sent', 'failed', 'skipped')),
  -- A reminder nudges; a final notice warns that service stops on a stated day.
  -- It is its own kind so the two can never be confused in the ledger.
  kind         TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'final')),
  to_email     TEXT NOT NULL DEFAULT '',
  provider     TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_reminders_stage
  ON invoice_reminders (invoice_id, stage_days);
CREATE INDEX IF NOT EXISTS idx_invoice_reminders_recent
  ON invoice_reminders (sent_at DESC);

-- What an invoice is made of. The amount on the invoice is the sum of these
-- rows, so a bill can say "number rent, October" instead of one unexplained
-- total — and a customer asking what they paid for can be answered line by line.
CREATE TABLE IF NOT EXISTS invoice_items (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'charge'
                    CHECK (kind IN ('plan', 'number_rent', 'usage', 'charge', 'discount', 'tax')),
  description       TEXT NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_cents INTEGER NOT NULL DEFAULT 0,
  -- Negative for a discount, so the sum is the total without special cases.
  amount_cents      INTEGER NOT NULL DEFAULT 0,
  -- A rent line points at the number it is for, which is what makes one month
  -- of one line billable exactly once.
  number_id         TEXT,
  period            TEXT NOT NULL DEFAULT '',
  -- How this line gets paid. 'invoice' is payable on this bill; 'subscription'
  -- means a card subscription already collected it, so the line is shown for the
  -- record and excluded from the amount due. This is what stops a combined bill
  -- from charging the plan twice.
  settled_by        TEXT NOT NULL DEFAULT 'invoice' CHECK (settled_by IN ('invoice', 'subscription')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);

-- Dunning state per billing account. The identity is the billing email on the
-- invoice, lower-cased: one customer, one state, however many invoices they owe.
-- `suspend_on` is the date the customer was actually told, not a recomputation —
-- a platform that says one date and acts on another has no case at all.
CREATE TABLE IF NOT EXISTS billing_accounts (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK (state IN ('current', 'final-notice', 'suspended')),
  final_notice_at TEXT,
  suspend_on      TEXT,
  suspended_at    TEXT,
  reinstated_at   TEXT,
  suspend_reason  TEXT NOT NULL DEFAULT '',
  suspend_notice_at TEXT,
  overdue_cents   INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_state ON billing_accounts (state, suspend_on);

-- Estate: physical sites and the equipment each one carries.
CREATE TABLE IF NOT EXISTS sites (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  address      TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  timezone     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'degraded', 'offline', 'planned')),
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Every device is a real row tied to a site, not a number counted by hand. A
-- MAC address is unique when present so the same handset cannot be provisioned
-- at two sites; a deleted site takes its equipment with it.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  site_id      TEXT REFERENCES sites (id) ON DELETE CASCADE,
  extension_id TEXT REFERENCES extensions (id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'handset'
               CHECK (kind IN ('handset', 'gateway', 'ata', 'conference', 'door')),
  model        TEXT NOT NULL DEFAULT '',
  mac          TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  firmware     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'online'
               CHECK (status IN ('online', 'offline', 'provisioning', 'faulty')),
  -- Check-in credential: the device holds the secret, only its hash is stored.
  token_hash   TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_site ON devices (site_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mac ON devices (mac) WHERE mac <> '';

-- Connected systems: the other consoles this platform sits beside. Each row is
-- one front door (host + landing path) with an optional catalog of modules.
CREATE TABLE IF NOT EXISTS systems (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  host        TEXT NOT NULL,
  path        TEXT NOT NULL DEFAULT '/',
  description TEXT NOT NULL DEFAULT '',
  group_name  TEXT NOT NULL DEFAULT 'Connected',
  links       TEXT NOT NULL DEFAULT '[]',
  sort_order  INTEGER NOT NULL DEFAULT 100,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Health probes are an append-only log; the newest row per target is current.
CREATE TABLE IF NOT EXISTS health_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'api'
             CHECK (kind IN ('api', 'database', 'switch', 'sip', 'dns', 'webhook', 'delivery')),
  status     TEXT NOT NULL DEFAULT 'up' CHECK (status IN ('up', 'degraded', 'down')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_health_checked ON health_checks (checked_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'maintenance'
              CHECK (kind IN ('maintenance', 'incident', 'change', 'provisioning', 'audit')),
  priority    TEXT NOT NULL DEFAULT 'normal'
              CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'in_progress', 'blocked', 'done')),
  assignee    TEXT NOT NULL DEFAULT '',
  site_id     TEXT REFERENCES sites (id) ON DELETE SET NULL,
  due_at      TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, priority);

-- ------------------------------------------------------------- marketing --
-- Outbound campaigns over the voice agents: a list, a script, a goal, and a
-- graded result per call. The platform owns the queue, the disposition and the
-- report; the agent engine owns the dialing, which is why a contacted row is
-- claimed with `calling` before anything is dialed and finished with an outcome.

CREATE TABLE IF NOT EXISTS campaigns (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- What this campaign is for, in words: the grader and the report both read it.
  goal           TEXT NOT NULL DEFAULT '',
  -- Which template it started from, so a result can be traced to a pitch.
  template       TEXT NOT NULL DEFAULT '',
  agent_id       TEXT REFERENCES voice_agents (id) ON DELETE SET NULL,
  script         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  daily_limit    INTEGER NOT NULL DEFAULT 50,
  -- A grade at or above this is a lead; below it, follow-up or discard.
  grade_threshold INTEGER NOT NULL DEFAULT 60,
  created_by     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns (status, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  e164        TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'calling', 'completed', 'failed', 'skipped', 'do_not_call')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  outcome     TEXT NOT NULL DEFAULT '',
  grade       INTEGER,
  -- Why the grade, as a JSON list: a score with no reasons cannot be defended.
  reasons     TEXT NOT NULL DEFAULT '[]',
  transcript  TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  called_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- One row per number per campaign: importing a list twice must not double-dial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_contacts_number ON campaign_contacts (campaign_id, e164);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status ON campaign_contacts (campaign_id, status);

CREATE TABLE IF NOT EXISTS campaign_reports (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by  TEXT NOT NULL DEFAULT '',
  totals      TEXT NOT NULL DEFAULT '{}',
  file        TEXT NOT NULL DEFAULT '',
  bytes       INTEGER NOT NULL DEFAULT 0,
  sent_to     TEXT NOT NULL DEFAULT '',
  delivered   INTEGER NOT NULL DEFAULT 0,
  provider    TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_campaign_reports ON campaign_reports (campaign_id, created_at DESC);

-- ---------------------------------------------------------------- commerce --
-- Plans and features are data, not code. The admin console edits them, the
-- public subscribe page reads them, and a subscription records which plan a
-- customer bought at which price — a snapshot, because editing a plan tomorrow
-- must not rewrite what somebody was charged today.

-- The feature catalog: every capability a plan can include or exclude.
CREATE TABLE IF NOT EXISTS features (
  key         TEXT PRIMARY KEY,             -- 'video-calling', 'ai-grading'
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'calling',
  -- Shown on the public page as an add-on rather than a plan line.
  addon       INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  tagline          TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',  price_cents   INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency         TEXT NOT NULL DEFAULT 'USD',
  interval         TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  -- Flat rate: a plan is one price, not a price multiplied by headcount. The
  -- column stays because a subscription froze its snapshot around it.
  seats            INTEGER NOT NULL DEFAULT 1,
  -- Kept for a metered plan should one come back; a consumer plan leaves it at
  -- zero and sets minutes_unlimited instead.
  included_minutes INTEGER NOT NULL DEFAULT 0,
  -- 1 means the plan sells unlimited calling and shows no minute meter.
  minutes_unlimited INTEGER NOT NULL DEFAULT 1,
  -- Who the plan is sold to. The public pages group by this, so a home plan
  -- never appears in the business ladder.
  audience         TEXT NOT NULL DEFAULT 'business' CHECK (audience IN ('business', 'residential')),
  -- A plan that is not in Stripe can still be sold: checkout creates the price
  -- from these numbers and stores the id back here.
  stripe_price_id  TEXT NOT NULL DEFAULT '',
  stripe_product_id TEXT NOT NULL DEFAULT '',
  -- The plan everybody lands on when they have no subscription.
  is_default       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 100,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_active ON plans (active, sort_order);

-- Which features a plan carries. Removing a row removes the feature from the
-- plan, the public page and the customer's entitlement in one place.
CREATE TABLE IF NOT EXISTS plan_features (
  plan_id     TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL REFERENCES features (key) ON DELETE CASCADE,
  -- 'included' | 'addon' | 'trial': how the plan exposes the feature.
  mode        TEXT NOT NULL DEFAULT 'included' CHECK (mode IN ('included', 'addon', 'trial')),
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  plan_id                TEXT REFERENCES plans (id) ON DELETE SET NULL,
  -- Frozen copy of what was sold, so a later price change is not a rewrite.
  plan_name              TEXT NOT NULL DEFAULT '',
  plan_slug              TEXT NOT NULL DEFAULT '',
  price_cents            INTEGER NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'USD',
  interval               TEXT NOT NULL DEFAULT 'month',
  seats                  INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'incomplete'
                         CHECK (status IN ('incomplete', 'active', 'trialing', 'past_due', 'canceled')),
  stripe_customer_id     TEXT NOT NULL DEFAULT '',
  stripe_subscription_id TEXT NOT NULL DEFAULT '',
  stripe_session_id      TEXT NOT NULL DEFAULT '',
  current_period_end     TEXT,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  canceled_at            TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions (stripe_subscription_id);

-- ------------------------------------------------------------------- SCIF --
-- A voiceprint is one enrolled line. The embedding is not audio: it is a vector
-- of spectral statistics, replaced when the line is re-enrolled, so a copy of
-- this table cannot be turned back into somebody's voice.
CREATE TABLE IF NOT EXISTS voiceprints (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  extension  TEXT NOT NULL,
  phrase     TEXT NOT NULL DEFAULT '',
  embedding  TEXT NOT NULL,
  samples    INTEGER NOT NULL DEFAULT 0,
  threshold  REAL NOT NULL DEFAULT 0.82,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voiceprints_line ON voiceprints (account_id, extension);

-- Every attempt, so a lockout is a fact about the log rather than a guess, and
-- so an operator can see why somebody could not get into their own line.
CREATE TABLE IF NOT EXISTS voice_auth_events (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  extension  TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'enroll', 'refused')),
  score      REAL NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_auth_events ON voice_auth_events (account_id, extension, at DESC);

-- One row per installed SCIF app. A token is the device, so it is unique and
-- re-registering the same phone updates the row instead of stacking up rings.
CREATE TABLE IF NOT EXISTS push_devices (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  extension   TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios', 'android')),
  token       TEXT NOT NULL UNIQUE,
  bundle_id   TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT 'development',
  device_name TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  failure     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_push_devices_line ON push_devices (account_id, extension);

-- ------------------------------------------------------------------- CRM --
-- A ticket is one conversation with a customer about one thing: a complaint, a
-- service request, a change they asked for. The state is what the queue sorts
-- on; the notes are the history, and every state change writes one, so a
-- ticket's story is in order rather than inferred from two columns.
CREATE TABLE IF NOT EXISTS tickets (
  id                TEXT PRIMARY KEY,
  -- Nullable on purpose: the snapshot below is what the queue reads, so a
  -- deleted account cannot take the history of what was asked with it.
  account_id        TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  email             TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  subject           TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'support'
                    CHECK (category IN ('support', 'billing', 'complaint', 'service_change', 'porting', 'outage')),
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  state             TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'pending', 'resolved', 'closed')),
  assignee          TEXT NOT NULL DEFAULT '',
  -- The line the ticket is about, when it is about one.
  number_id         TEXT,
  due_at            TEXT,
  -- What the service promise is measured on: the first reply, and when it was
  -- actually settled. Both are facts, not recomputations.
  first_response_at TEXT,
  resolved_at       TEXT,
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets (state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_account ON tickets (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_notes (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  actor      TEXT NOT NULL DEFAULT '',
  -- 'internal' is a note the customer never sees; 'system' is a state change
  -- written by the platform so the timeline explains itself.
  kind       TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'internal', 'system')),
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes (ticket_id, created_at);

-- What an operator wants to remember about a customer that is not a job:
-- who they spoke to, what was promised, why an exception was made.
CREATE TABLE IF NOT EXISTS customer_notes (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  actor      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_account ON customer_notes (account_id, created_at DESC);

-- Money that actually moved. An invoice says what is owed; this says what was
-- collected, how, and when — the question a customer asks ("what did I pay
-- you, and for what") and the row a refund or a manual payment has to point at.
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  account_id   TEXT,
  invoice_id   TEXT,
  -- Negative for a refund, so a ledger sums to what was net collected.
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  method       TEXT NOT NULL DEFAULT 'stripe'
               CHECK (method IN ('stripe', 'manual', 'credit', 'refund')),
  reference    TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_account ON payments (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
