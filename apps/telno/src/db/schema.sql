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
  suspended_at  TEXT
);

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
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_numbers_country ON numbers (country, status);
CREATE INDEX IF NOT EXISTS idx_numbers_updated ON numbers (updated_at DESC);

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
