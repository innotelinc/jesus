/**
 * Demo data. Everything here is fictional; the US numbers use the 555-01xx
 * range reserved for fiction and the UK numbers use Ofcom's drama ranges.
 *
 *   node src/seed.js          # only seeds an empty platform
 *   node src/seed.js --force  # wipes and reseeds the demo tables
 */
import { getDb, db_, newId, now } from './db/index.js';
import { resolveNumber, addListing } from './lib/registry.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from './lib/security.js';
import { config } from './config.js';
import { writeConfigs } from './telephony/provision.js';

getDb();
const force = process.argv.includes('--force');

if (force) {
  for (const table of ['tasks', 'health_checks', 'invoices', 'messages', 'faxes', 'voicemails', 'workflows', 'voice_agents', 'devices', 'sites', 'calls', 'listings', 'submissions', 'extensions', 'ivr_flows', 'trunks', 'optouts', 'merges', 'systems']) {
    db_.run(`DELETE FROM ${table}`);
  }
  db_.run('DELETE FROM listing_search');
  db_.run('DELETE FROM numbers');
  console.log('[seed] cleared demo tables');
}

// The other consoles this platform sits beside. Each is a front door plus the
// modules an operator actually reaches for; all of them sit behind Authentik,
// which the probe reports as `auth` rather than pretending it is down.
const SYSTEMS = [
  {
    id: 'sys_control',
    name: 'Capstone Control Center',
    host: 'https://dashboard.pbx.it.com',
    path: '/interviews',
    description: 'Operations console: interviews, agents, softphone, SMS gateway, ports, secrets and config.',
    group: 'Capstone',
    order: 10,
    links: [
      ['Interviews', '/interviews'], ['Agents', '/agents'], ['Workflows', '/workflows'], ['Softphone', '/softphone'],
      ['Extensions', '/extensions'], ['SMS gateway', '/sms-gateway'], ['SMS transport', '/sms-transport'],
      ['Monitoring', '/monitoring'], ['Alerts', '/alerts'], ['Incidents', '/incidents'], ['Services', '/services'],
      ['Ports', '/ports'], ['Policies', '/policies'], ['Entitlements', '/entitlements'], ['Secrets', '/secrets'],
      ['Config', '/config'], ['Deploy mode', '/deploy-mode'], ['Audit', '/audit'], ['Logs', '/logs'],
      ['Users', '/users'], ['Stats', '/stats'], ['Health', '/health'], ['Links', '/links'],
      ['API', '/api'], ['Settings', '/settings'], ['Password', '/password'],
    ],
  },
  {
    id: 'sys_capstone',
    name: 'Capstone voice platform',
    host: 'https://pbx.it.com',
    path: '/workflow',
    description: 'AI voice agents and workflows, signed in with the Capstone account.',
    group: 'Capstone',
    order: 20,
    links: [['Workflow', '/workflow'], ['Login', '/auth/login']],
  },
  {
    id: 'sys_workflow',
    name: 'Capstone workflow (SSO)',
    host: 'https://workflow.pbx.it.com',
    path: '/',
    description: 'Same workflow product behind the Authentik gateway (innotel-app-gateway).',
    group: 'Capstone',
    order: 30,
    links: [],
  },
  {
    id: 'sys_freepbx',
    name: 'FreePBX administration',
    host: 'https://pbx.pbx.it.com',
    path: '/admin/config.php',
    description: 'The switch itself: extensions, trunks, routes and module config.',
    group: 'Telephony',
    order: 40,
    links: [['Admin', '/admin/config.php'], ['AvantFAX inbox', '/fax/inbox.php']],
  },
  {
    id: 'sys_avantfax',
    name: 'AvantFAX',
    host: 'https://pbx.pbx.it.com',
    path: '/fax/inbox.php',
    description: 'Fax inbox with its own session; use it for the raw archive.',
    group: 'Telephony',
    order: 50,
    links: [],
  },
  {
    id: 'sys_zeus',
    name: 'Zeus operations',
    host: 'https://app.pbx.services',
    path: '/dashboard/operations',
    description: 'The original Next.js operations dashboard.',
    group: 'Telephony',
    order: 60,
    links: [],
  },
];

for (const system of SYSTEMS) {
  db_.run(
    `INSERT OR IGNORE INTO systems (id, name, host, path, description, group_name, links, sort_order, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      system.id,
      system.name,
      system.host,
      system.path,
      system.description,
      system.group,
      JSON.stringify(system.links.map(([label, path]) => ({ label, path }))),
      system.order,
    ]
  );
}

const existing = db_.get('SELECT COUNT(*) AS n FROM numbers').n;
if (existing > 0 && !force) {
  console.log(`[seed] ${existing} numbers already present — nothing to do (use --force to reseed)`);
  process.exit(0);
}

let state = 20261025;
const rnd = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
/**
 * A short tone written as a real mono WAV, so seeded voicemail and call
 * recordings can actually be played back in the console.
 */
function writeTone(name, seconds, frequency = 420) {
  const rate = 8000;
  const samples = Math.floor(rate * Math.max(0.6, seconds));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const fade = Math.min(1, i / 400, (samples - i) / 400);
    const value = Math.sin((2 * Math.PI * frequency * i) / rate) * 0.18 * 32767 * fade;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(config.recordingsDir, { recursive: true });
  writeFileSync(join(config.recordingsDir, name), Buffer.concat([header, data]));
  return name;
}

const daysAgo = (days, hour) => {
  const d = new Date(Date.now() - days * 86400_000);
  d.setUTCHours(hour, Math.floor(rnd() * 60), 0, 0);
  // Never seed the future: a same-day hour later than now would render as
  // "-7h ago" and sort above everything real.
  return d.getTime() > Date.now() ? new Date(d.getTime() - 86400_000) : d;
};

const ACCOUNTS = [
  ['owner@telno.local', 'Owner', 'owner'],
  ['ops@telno.local', 'Operations', 'operator'],
  ['audit@telno.local', 'Read only', 'viewer'],
];

const ENTRIES = [
  { number: '+1 212 555 0142', name: 'Hudson & Vale', kind: 'business', category: 'Legal services', city: 'New York', country: 'US', website: 'hudsonvale.example' },
  { number: '+1 415 555 0117', name: 'Blue Harbor Coffee', kind: 'business', category: 'Cafe', city: 'San Francisco', country: 'US', website: 'blueharbor.example', tags: 'coffee,breakfast' },
  { number: '+1 305 555 0193', name: 'Coral Line Charters', kind: 'business', category: 'Travel', city: 'Miami', country: 'US' },
  { number: '+1 206 555 0166', name: 'Northbeam Analytics', kind: 'business', category: 'Software', city: 'Seattle', country: 'US', website: 'northbeam.example', tags: 'saas,data' },
  { number: '+1 312 555 0121', name: 'Lakeshore Dental', kind: 'business', category: 'Healthcare', city: 'Chicago', country: 'US' },
  { number: '+1 617 555 0188', name: 'Beacon Hill Books', kind: 'business', category: 'Retail', city: 'Boston', country: 'US' },
  { number: '+1 800 555 0199', name: 'Telno Support', kind: 'service', category: 'Support line', city: 'Worldwide', country: 'US', tags: 'tollfree,support' },
  { number: '+44 20 7946 0321', name: 'Thameside Studios', kind: 'business', category: 'Media', city: 'London', country: 'GB', website: 'thameside.example' },
  { number: '+44 7700 900451', name: 'A. Whitfield', kind: 'person', category: 'Personal', city: 'Bristol', country: 'GB' },
  { number: '+44 20 7946 0114', name: 'Clerkenwell Repair Co', kind: 'business', category: 'Repairs', city: 'London', country: 'GB' },
  { number: '+49 30 12345678', name: 'Spreewerk', kind: 'business', category: 'Manufacturing', city: 'Berlin', country: 'DE', website: 'spreewerk.example' },
  { number: '+33 1 23 45 67 89', name: 'Atelier Lumiere', kind: 'business', category: 'Design', city: 'Paris', country: 'FR' },
  { number: '+34 911 234 567', name: 'Casa Mirador', kind: 'business', category: 'Hospitality', city: 'Madrid', country: 'ES' },
  { number: '+39 06 1234 5678', name: 'Trattoria del Ponte', kind: 'business', category: 'Restaurant', city: 'Rome', country: 'IT', tags: 'dinner,family' },
  { number: '+31 20 123 4567', name: 'Kade Digital', kind: 'business', category: 'Software', city: 'Amsterdam', country: 'NL' },
  { number: '+46 8 123 456 78', name: 'Nordkontor', kind: 'business', category: 'Consulting', city: 'Stockholm', country: 'SE' },
  { number: '+353 1 234 5678', name: 'Liffey Legal', kind: 'business', category: 'Legal services', city: 'Dublin', country: 'IE' },
  { number: '+45 32 12 34 56', name: 'Nordlys Design', kind: 'business', category: 'Design', city: 'Copenhagen', country: 'DK' },
  { number: '+81 3 1234 5678', name: 'Sakura Logistics', kind: 'business', category: 'Logistics', city: 'Tokyo', country: 'JP' },
  { number: '+86 10 1234 5678', name: 'Jade Bridge Trading', kind: 'business', category: 'Import/export', city: 'Beijing', country: 'CN' },
  { number: '+91 98765 43210', name: 'Mehta Textiles', kind: 'business', category: 'Textiles', city: 'Mumbai', country: 'IN' },
  { number: '+61 2 9374 4000', name: 'Harbour Freight', kind: 'business', category: 'Logistics', city: 'Sydney', country: 'AU' },
  { number: '+64 9 123 4567', name: 'Kauri Analytics', kind: 'business', category: 'Software', city: 'Auckland', country: 'NZ' },
  { number: '+55 11 91234 5678', name: 'Cafe Paulista', kind: 'business', category: 'Cafe', city: 'Sao Paulo', country: 'BR' },
  { number: '+52 55 1234 5678', name: 'Casa Azul', kind: 'business', category: 'Hospitality', city: 'Mexico City', country: 'MX' },
  { number: '+27 11 123 4567', name: 'Kalahari Freight', kind: 'business', category: 'Logistics', city: 'Johannesburg', country: 'ZA' },
  { number: '+971 4 123 4567', name: 'Marina Desk', kind: 'business', category: 'Coworking', city: 'Dubai', country: 'AE' },
];

const created = [];
const failed = [];

db_.tx(() => {
  for (const entry of ENTRIES) {
    try {
      const resolved = resolveNumber(entry.number, {
        source: 'seed',
        status: 'active',
        region: entry.city,
        trustScore: 60 + Math.floor(rnd() * 25),
      });
      addListing(resolved.id, {
        name: entry.name,
        kind: entry.kind,
        category: entry.category,
        city: entry.city,
        country: entry.country,
        website: entry.website ? `https://${entry.website}` : '',
        languages: entry.country === 'GB' ? 'en' : '',
        tags: entry.tags || '',
        verified: true,
      });
      created.push({ ...entry, id: resolved.id });
    } catch (err) {
      failed.push({ number: entry.number, reason: err.message });
    }
  }
});

console.log(`[seed] ${created.length} numbers + listings created${failed.length ? `, ${failed.length} skipped` : ''}`);
if (failed.length) console.log('[seed] skipped:', failed.map((f) => `${f.number} (${f.reason})`).join(' | '));

// Extensions: the first three get DIDs from the registry (the dedupe payoff).
const EXTENSIONS = [
  ['101', 'Front Desk', 0, 'frontdesk@telno.local'],
  ['102', 'Sales', 1, 'sales@telno.local'],
  ['103', 'Support', 6, 'support@telno.local'],
  ['104', 'Warehouse', null, ''],
  ['105', 'Conference', null, ''],
];

db_.tx(() => {
  for (const [extension, name, entryIndex, email] of EXTENSIONS) {
    db_.run(
      `INSERT INTO extensions (id, extension, display_name, number_id, email, secret, voicemail, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
      [
        newId('ext_'),
        extension,
        name,
        entryIndex !== null && created[entryIndex] ? created[entryIndex].id : null,
        email,
        `demo-${extension}-${Math.floor(rnd() * 1e6)}`,
      ]
    );
  }

  if (created.length) {
    db_.run(
      `INSERT INTO trunks (id, name, provider, host, username, secret, codecs, context, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [newId('trk_'), 'primary', 'generic', 'sip.example.net', 'telno-demo', 'demo-secret', 'ulaw,alaw', 'from-trunk']
    );
  }

  db_.run(
    `INSERT INTO ivr_flows (id, name, extension, greeting, options, timeout_dest, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      newId('ivr_'),
      'Main menu',
      '200',
      'Thanks for calling. Press 1 for the front desk, 2 for sales, 3 for support.',
      JSON.stringify([
        { digit: '1', target: '101', label: 'Front desk' },
        { digit: '2', target: '102', label: 'Sales' },
        { digit: '3', target: '103', label: 'Support' },
      ]),
      '101',
    ]
  );
});

// Call history for the dashboard charts.
const DISPOSITIONS = ['answered', 'answered', 'answered', 'no-answer', 'busy', 'voicemail', 'answered', 'failed'];
db_.tx(() => {
  for (let i = 0; i < 180; i += 1) {
    const daysBack = Math.floor(rnd() * 7);
    const started = daysAgo(daysBack, 7 + Math.floor(rnd() * 12));
    const disposition = pick(DISPOSITIONS);
    const inbound = rnd() > 0.42;
    const entry = pick(created);
    const duration = disposition === 'answered' ? 20 + Math.floor(rnd() * 540) : 0;
    const billsec = disposition === 'answered' ? duration - Math.floor(rnd() * 15) : 0;
    db_.run(
      `INSERT INTO calls (id, call_id, direction, from_number, to_number, extension, trunk,
                          started_at, answered_at, ended_at, duration, billsec, disposition, hangup_cause)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('cal_'),
        `seed-${i}-${Math.floor(rnd() * 1e6)}`,
        inbound ? 'inbound' : 'outbound',
        inbound ? `+1 415 555 01${String(10 + Math.floor(rnd() * 80)).slice(-2)}` : entry?.number || '+14155550123',
        inbound ? entry?.number || '+14155550123' : `+1 212 555 01${String(10 + Math.floor(rnd() * 80)).slice(-2)}`,
        inbound ? pick(['101', '102', '103', '200']) : '',
        inbound ? 'primary' : 'primary',
        started.toISOString(),
        disposition === 'answered' ? new Date(started.getTime() + 5000).toISOString() : null,
        new Date(started.getTime() + duration * 1000 + 5000).toISOString(),
        duration,
        billsec,
        disposition,
        disposition === 'busy' ? 'User busy' : disposition === 'no-answer' ? 'No user responding' : 'Normal Clearing',
      ]
    );
  }
});

// A few recent answered calls carry audio, so the history is playable.
const recordedCalls = db_.all("SELECT id FROM calls WHERE disposition = 'answered' ORDER BY started_at DESC LIMIT 3");
for (const [index, call] of recordedCalls.entries()) {
  const audio = writeTone(`call_${call.id}.wav`, 2 + index);
  db_.run('UPDATE calls SET recording = ? WHERE id = ?', [audio, call.id]);
}

// Moderation queue: verified submissions waiting for a human decision.
const QUEUE = [
  { number: '+1 212 555 0177', name: 'SoHo Print Lab', category: 'Printing', city: 'New York', country: 'US', channel: 'email', target: 'hello@soprint.example' },
  { number: '+44 20 7946 0455', name: 'Bermondsey Tool Library', category: 'Community', city: 'London', country: 'GB', channel: 'sms', target: '+442079460455' },
  { number: '+49 89 1234567', name: 'Isar Werkstatt', category: 'Automotive', city: 'Munich', country: 'DE', channel: 'email', target: 'kontakt@isarwerkstatt.example' },
];

db_.tx(() => {
  for (const item of QUEUE) {
    try {
      const resolved = resolveNumber(item.number, { source: 'submission' });
      const id = newId('sub_');
      db_.run(
        `INSERT INTO submissions (id, e164, number_id, name, kind, category, city, country, email,
           domain_slug, status, verify_channel, verify_target, created_at)
         VALUES (?, ?, ?, ?, 'business', ?, ?, ?, ?, ?, 'verified', ?, ?, ?)`,
        [
          id,
          resolved.e164,
          resolved.id,
          item.name,
          item.category,
          item.city,
          item.country,
          item.channel === 'email' ? item.target : '',
          'telno.directory',
          item.channel,
          item.target,
          daysAgo(Math.floor(rnd() * 3), 9).toISOString(),
        ]
      );
    } catch (err) {
      console.log(`[seed] submission skipped ${item.number}: ${err.message}`);
    }
  }
});

// One opt-out, on a number that has no listing, so the demo stays populated.
try {
  const hidden = resolveNumber('+1 415 555 0133', { source: 'seed', visibility: 'private' });
  db_.run('INSERT OR IGNORE INTO optouts (e164, reason) VALUES (?, ?)', [hidden.e164, 'Requested by the number holder']);
  console.log('[seed] opt-out example added');
} catch (err) {
  console.log('[seed] opt-out example skipped:', err.message);
}

if (force) {
  const password = config.adminPassword || 'telno-demo-owner';
  for (const [email, name, role] of ACCOUNTS) {
    const exists = db_.get('SELECT id FROM accounts WHERE email = ?', [email]);
    if (exists) continue;
    db_.run('INSERT INTO accounts (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [
      newId('acc_'),
      email,
      name,
      hashPassword(password),
      role,
    ]);
  }
  console.log(`[seed] demo accounts: ${ACCOUNTS.map((a) => a[0]).join(', ')} (password: ${password})`);
}

if (config.telephony.configDir) writeConfigs();

const stats = db_.get('SELECT (SELECT COUNT(*) FROM numbers) AS numbers, (SELECT COUNT(*) FROM listings) AS listings, (SELECT COUNT(*) FROM extensions) AS extensions, (SELECT COUNT(*) FROM calls) AS calls');
console.log(`[seed] done — ${stats.numbers} numbers, ${stats.listings} listings, ${stats.extensions} extensions, ${stats.calls} calls`);
// ------------------------------------------------------------- workspace ----
// Operational surface: sites, agents, flows, inboxes, billing, health, tasks.
// Fixed ids keep this block idempotent; `--force` clears these tables first.

const SITES = [
  ['ste_london', 'London HQ', '18 Finsbury Circus', 'London', 'GB', 'Europe/London', 'active', 18],
  ['ste_rotterdam', 'Rotterdam DC', 'Waalhaven 12', 'Rotterdam', 'NL', 'Europe/Amsterdam', 'degraded', 140],
  ['ste_austin', 'Austin Branch', '600 Congress Ave', 'Austin', 'US', 'America/Chicago', 'active', 61],
  ['ste_singapore', 'Singapore Edge', '8 Marina View', 'Singapore', 'SG', 'Asia/Singapore', 'active', 210],
  ['ste_berlin', 'Berlin Office', 'Torstrasse 140', 'Berlin', 'DE', 'Europe/Berlin', 'planned', 0],
];

// The inventory itself: what is actually installed where. `extension` is the
// dial number it serves, or null for infrastructure gear.
const DEVICES = [
  ['dev_lon_reception', 'ste_london', 'Reception desk', 'handset', 'Yealink T54W', '80:5E:C0:11:24:01', '10.10.1.21', '96.86.0.15', 'online', '101', 4],
  ['dev_lon_sales', 'ste_london', 'Sales floor', 'handset', 'Yealink T54W', '80:5E:C0:11:24:02', '10.10.1.22', '96.86.0.15', 'online', '102', 6],
  ['dev_lon_support', 'ste_london', 'Support pod', 'handset', 'Yealink T54W', '80:5E:C0:11:24:03', '10.10.1.23', '96.86.0.15', 'online', '103', 7],
  ['dev_lon_conf', 'ste_london', 'Boardroom', 'conference', 'Polycom Trio 8800', '64:16:7F:04:11:09', '10.10.1.40', '5.9.3.1', 'online', '105', 9],
  ['dev_lon_sbc', 'ste_london', 'Session border controller', 'gateway', 'AudioCodes Mediant 800', '00:90:8F:2A:11:01', '10.10.1.5', '7.20A.256.008', 'online', null, 3],
  ['dev_lon_ata', 'ste_london', 'Fire panel line', 'ata', 'Cisco ATA 191', '00:1B:54:3C:88:02', '10.10.1.61', '1.2.1.3', 'faulty', null, 26],
  ['dev_rtm_sbc', 'ste_rotterdam', 'Edge SBC', 'gateway', 'AudioCodes Mediant 1000B', '00:90:8F:2A:22:01', '10.20.0.5', '7.20A.256.008', 'offline', null, 190],
  ['dev_rtm_ops', 'ste_rotterdam', 'NOC desk', 'handset', 'Snom D785', '00:04:F2:AA:31:07', '10.20.0.31', '10.1.84.1', 'online', '104', 5],
  ['dev_rtm_conference', 'ste_rotterdam', 'Ops room', 'conference', 'Polycom Trio 8800', '64:16:7F:04:22:03', '10.20.0.40', '5.9.3.1', 'provisioning', null, 2 * 1440],
  ['dev_aus_gateway', 'ste_austin', 'Branch gateway', 'gateway', 'Grandstream UCM6302', 'C0:74:AD:55:10:01', '10.30.0.5', '1.0.17.9', 'online', null, 8],
  ['dev_aus_reception', 'ste_austin', 'Front desk', 'handset', 'Grandstream GXP2170', 'C0:74:AD:55:10:11', '10.30.0.21', '1.0.11.52', 'online', '101', 5],
  ['dev_aus_warehouse', 'ste_austin', 'Warehouse', 'handset', 'Grandstream GXP1625', 'C0:74:AD:55:10:12', '10.30.0.35', '1.0.11.52', 'offline', '104', 4 * 1440],
  ['dev_sin_reception', 'ste_singapore', 'Lobby phone', 'handset', 'Yealink T31P', '80:5E:C0:77:33:01', '10.40.0.21', '124.15.0.5', 'online', null, 7],
  ['dev_sin_door', 'ste_singapore', 'Loading bay door', 'door', '2N IP Verso', '00:1A:2B:77:33:05', '10.40.0.60', '2.33.0.1', 'online', null, 6],
  ['dev_sin_sbc', 'ste_singapore', 'Edge SBC', 'gateway', 'AudioCodes Mediant 500L', '00:90:8F:2A:33:01', '10.40.0.5', '7.20A.256.008', 'online', null, 9],
  ['dev_ber_reception', 'ste_berlin', 'Reception (staged)', 'handset', 'Yealink T33G', '80:5E:C0:99:44:01', '10.50.0.21', '', 'provisioning', null, 4 * 1440],
  ['dev_ber_sales', 'ste_berlin', 'Sales (staged)', 'handset', 'Yealink T33G', '80:5E:C0:99:44:02', '10.50.0.22', '', 'provisioning', null, 4 * 1440],
];

const AGENTS = [
  ['vag_reception', 'Reception — English', 'aria', 'en-US', 'active', 'Thanks for calling. How can I help today?', 'Route billing questions to 101, support to 102, and take a message after 18:00.', 1842, 74],
  ['vag_afterhours', 'After-hours triage', 'marcus', 'en-US', 'active', 'You have reached the after-hours desk.', 'Capture the caller, check for an open incident, and page the on-call engineer for anything urgent.', 611, 96],
  ['vag_collections', 'Collections reminder', 'sofia', 'es-ES', 'paused', 'Hola, le llamamos de facturación.', 'Confirm identity before discussing any balance, then offer a payment link by SMS.', 203, 118],
  ['vag_survey', 'Post-call survey', 'nora', 'nl-NL', 'draft', 'Thank you for your call. One quick question.', 'Ask the single CSAT question and record the answer; never collect personal data.', 0, 0],
];

const FLOWS = [
  ['wfl_missed', 'Missed call → SMS', 'inbound', 'active', [
    { type: 'tag', label: 'Mark caller as missed', target: 'missed-call' },
    { type: 'sms', label: 'Send callback link', target: 'https://telno.services/callback' },
    { type: 'wait', label: 'Wait 10 minutes', target: '600' },
    { type: 'voicemail', label: 'Fall back to voicemail', target: '201' },
  ], 1482, 1461, 21, 'success'],
  ['wfl_afterhours', 'After-hours routing', 'schedule', 'active', [
    { type: 'dial', label: 'Ring on-call rotation', target: '220' },
    { type: 'wait', label: '30 second ring time', target: '30' },
    { type: 'voicemail', label: 'Voicemail box 220', target: '220' },
  ], 388, 380, 8, 'success'],
  ['wfl_provision', 'New DID provisioning', 'webhook', 'active', [
    { type: 'tag', label: 'Apply registry record', target: 'did' },
    { type: 'email', label: 'Notify the account owner', target: 'ops@telno.services' },
  ], 96, 96, 0, 'success'],
  ['wfl_invoice', 'Weekly invoice run', 'schedule', 'paused', [
    { type: 'tag', label: 'Close the billing period', target: 'billing' },
    { type: 'email', label: 'Send statements', target: 'billing@telno.services' },
  ], 52, 51, 1, 'failed'],
];

const VOICEMAILS = [
  ['vmi_1', '201', '+14155550111', 34, 'Hi, this is Dana from Hudson and Vale returning your call about the trunk cutover. Give me a ring before four.', 0, 0, 2],
  ['vmi_2', '220', '+442079460111', 12, 'On-call here. The Rotterdam link is flapping again, I am on it.', 1, 0, 1],
  ['vmi_3', '101', '+4930901820', 47, 'Guten Tag, ich möchte eine zusätzliche Durchwahl für unser Team in Berlin.', 0, 1, 3],
  ['vmi_4', '102', '+12125550142', 8, 'Missed the survey, call me back.', 0, 1, 24],
  ['vmi_5', '201', '+14155550111', 63, 'Following up on the directory listing — we moved offices and the postal code is wrong.', 0, 0, 30],
];

const FAXES = [
  ['fax_1', 'inbound', '+12125550142', '', 4, 'received', 'Signed service agreement', 'agreement-2026.pdf', 1],
  ['fax_2', 'outbound', '', '+442079460111', 2, 'sent', 'Porting confirmation', 'port-confirm.pdf', 2],
  ['fax_3', 'inbound', '+4930901820', '', 9, 'received', 'VAT certificate', 'vat-de.pdf', 4],
  ['fax_4', 'outbound', '', '+14155550111', 1, 'failed', 'Number change notice', 'change-notice.pdf', 0],
  ['fax_5', 'inbound', '+12125550142', '', 1, 'received', 'Porting window confirmed', '', 5],
];

const MESSAGES = [
  ['msq_1', 'sms', 'outbound', '+14155550111', 'Your verification code is 418 902. It expires in 10 minutes.', 'delivered', 0],
  ['msq_2', 'sms', 'inbound', '+442079460111', 'Yes please, move us to the 200 block.', 'received', 0],
  ['msq_3', 'whatsapp', 'outbound', '+4930901820', 'Your invoice INV-2026-0003 is ready: https://telno.services/i/3', 'sent', 1],
  ['msq_4', 'sms', 'outbound', '+12125550142', 'We tried to reach you at 14:20. Reply CALLBACK to book a slot.', 'delivered', 1],
  ['msq_5', 'mms', 'inbound', '+14155550111', 'Photo of the rack labeling attached.', 'received', 2],
  ['msq_6', 'sms', 'outbound', '+442079460111', 'Port completed. Your number is live.', 'failed', 3],
];

const INVOICES = [
  ['inv_1', 'INV-2026-0001', 'Hudson & Vale', 'billing@hudsonvale.example', 'USD', 240000, 'paid', 40, 26],
  ['inv_2', 'INV-2026-0002', 'Rotterdam Logistics', 'ap@rotterdam-logistics.example', 'EUR', 118500, 'open', 12, -3],
  ['inv_3', 'INV-2026-0003', 'Nordwind GmbH', 'rechnung@nordwind.example', 'EUR', 96000, 'overdue', 55, 18],
  ['inv_4', 'INV-2026-0004', 'Capstone Voice', 'finance@capstonevoice.example', 'USD', 480000, 'open', 8, -9],
  ['inv_5', 'INV-2026-0005', 'Marina Dental', 'office@marinadental.example', 'USD', 36000, 'overdue', 68, 31],
  ['inv_6', 'INV-2026-0006', 'Kestrel Analytics', '', 'USD', 72500, 'draft', 2, -14],
];

const TASKS = [
  ['tsk_1', 'Replace failed SBC at Rotterdam DC', 'incident', 'critical', 'in_progress', 'nadia', 'ste_rotterdam', 1, 'Link flapped 4x in 24h; spare staged on site.'],
  ['tsk_2', 'Port 12 numbers from the legacy carrier', 'change', 'high', 'open', 'ops', 'ste_london', 3, 'Losing carrier confirmed; LOA signed.'],
  ['tsk_3', 'Quarterly directory audit', 'audit', 'normal', 'open', 'ines', null, 9, 'Check opt-outs and stale listings.'],
  ['tsk_4', 'Provision Berlin handsets', 'provisioning', 'normal', 'blocked', 'marcus', 'ste_berlin', 12, 'Waiting on the landlord for cabling access.'],
  ['tsk_5', 'Rotate SIP trunk credentials', 'maintenance', 'high', 'done', 'nadia', 'ste_austin', -2, 'Rotated and verified with a test call.'],
  ['tsk_6', 'Investigate 502 on pbx.pbx.it.com', 'incident', 'high', 'open', 'ops', null, 0, 'Admin UI returning 502 since this morning.'],
];

for (const [id, name, address, city, country, timezone, status, latency] of SITES) {
  db_.run(
    `INSERT OR IGNORE INTO sites (id, name, address, city, country, timezone, status, latency_ms, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, address, city, country, timezone, status, latency, now()]
  );
}

for (const [
  id,
  siteId,
  name,
  kind,
  model,
  mac,
  ip,
  firmware,
  status,
  extension,
  seenMinutes,
] of DEVICES) {
  // Seeded devices check in like real ones, so the demo shows live telemetry
  // rather than a wall of silent rows.
  db_.run(
    `INSERT OR IGNORE INTO devices (id, site_id, extension_id, name, kind, model, mac, ip, firmware, status, last_seen_at)
     VALUES (?, ?, (SELECT id FROM extensions WHERE extension = ?), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      siteId,
      extension,
      name,
      kind,
      model,
      mac,
      ip,
      firmware,
      status,
      new Date(Date.now() - seenMinutes * 60_000).toISOString(),
    ]
  );
}

for (const [id, name, voice, language, status, greeting, prompt, calls, avg] of AGENTS) {
  db_.run(
    `INSERT OR IGNORE INTO voice_agents (id, name, voice, language, greeting, prompt, status, calls_handled, avg_handling_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, voice, language, greeting, prompt, status, calls, avg]
  );
}
// Recording policy is per direction; a reception line keeps both legs.

db_.run("UPDATE voice_agents SET record_inbound = 1, record_outbound = 1 WHERE id = 'vag_reception'");
db_.run("UPDATE voice_agents SET record_inbound = 1 WHERE id = 'vag_afterhours'");

// An agent only owns a policy for a number once it answers that number, so
// attach the seeded agents to the two DIDs that already ring an extension.
for (const [agentId, extension] of [['vag_reception', '101'], ['vag_afterhours', '102']]) {
  const row = db_.get('SELECT number_id FROM extensions WHERE extension = ?', [extension]);
  if (row?.number_id) db_.run('UPDATE voice_agents SET number_id = ? WHERE id = ?', [row.number_id, agentId]);
}

for (const [id, name, trigger, status, steps, runs, ok, failed, lastStatus] of FLOWS) {
  db_.run(
    `INSERT OR IGNORE INTO workflows (id, name, trigger, status, steps, runs, success_count, failure_count, last_run_at, last_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, trigger, status, JSON.stringify(steps), runs, ok, failed, daysAgo(0, 9).toISOString(), lastStatus]
  );
}

for (const [id, extension, from, duration, transcript, urgent, listened, hoursAgo] of VOICEMAILS) {
  db_.run(
    `INSERT OR IGNORE INTO voicemails (id, extension, from_e164, duration, transcript, urgent, listened, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, extension, from, duration, transcript, urgent, listened, new Date(Date.now() - hoursAgo * 3600_000).toISOString()]
  );
  // Real audio, so the play control in the console is not a dead button.
  const audio = writeTone(`vm_${id}.wav`, Math.min(4, Math.max(1, Math.round(duration / 10))));
  db_.run('UPDATE voicemails SET recording = ? WHERE id = ?', [audio, id]);
}

for (const [id, direction, from, to, pages, status, subject, document, daysBack] of FAXES) {
  db_.run(
    `INSERT OR IGNORE INTO faxes (id, direction, from_e164, to_e164, pages, status, subject, document, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, direction, from, to, pages, status, subject, document, daysAgo(daysBack, 11).toISOString()]
  );
}
// One fax is a plain-text message rather than a document, to show both modes.

db_.run("UPDATE faxes SET body = ?, document = '' WHERE id = 'fax_5'", [
  'Please find the porting window confirmed for next Tuesday between 02:00 and 04:00 UTC. No action needed.',
]);

for (const [id, channel, direction, counterpart, body, status, daysBack] of MESSAGES) {
  db_.run(
    `INSERT OR IGNORE INTO messages (id, channel, direction, from_e164, to_e164, body, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      channel,
      direction,
      direction === 'inbound' ? counterpart : '',
      direction === 'inbound' ? '' : counterpart,
      body,
      status,
      daysAgo(daysBack, 10).toISOString(),
    ]
  );
}

for (const [id, invoiceNo, account, email, currency, amount, status, issuedDaysAgo, dueInDays] of INVOICES) {
  db_.run(
    `INSERT OR IGNORE INTO invoices
       (id, invoice_no, account_name, email, period_start, period_end, amount_cents, currency, status, issued_at, due_at, paid_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
    [
      id,
      invoiceNo,
      account,
      email,
      daysAgo(issuedDaysAgo + 30, 0).toISOString(),
      daysAgo(issuedDaysAgo, 0).toISOString(),
      amount,
      currency,
      status,
      daysAgo(issuedDaysAgo, 9).toISOString(),
      new Date(Date.now() - dueInDays * 86400_000).toISOString(),
      status === 'paid' ? daysAgo(Math.abs(dueInDays) + 1, 12).toISOString() : null,
    ]
  );
}

for (const [id, title, kind, priority, status, assignee, siteId, dueInDays, note] of TASKS) {
  db_.run(
    `INSERT OR IGNORE INTO tasks (id, title, kind, priority, status, assignee, site_id, due_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, kind, priority, status, assignee, siteId, daysAgo(-dueInDays, 17).toISOString(), note]
  );
}

if (!db_.get('SELECT COUNT(*) AS n FROM health_checks').n) {
  const stamp = now();
  const probes = [
    ['database', 'database', 'up', 2, 'SQLite read/write, WAL mode'],
    ['api', 'api', 'up', 1, 'Seeded demo runtime'],
    ['switch', 'switch', 'degraded', 0, 'Simulated switch — AMI not connected'],
    ['delivery', 'delivery', 'degraded', 0, 'Verification channel: console'],
    ['directory hosts', 'dns', 'up', 0, '6/6 hosts enabled'],
  ];
  for (const [target, kind, status, latency, detail] of probes) {
    db_.run('INSERT INTO health_checks (target, kind, status, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)', [
      target,
      kind,
      status,
      latency,
      detail,
      stamp,
    ]);
  }
}

const workspaceStats = db_.get(
  `SELECT (SELECT COUNT(*) FROM sites) AS sites,
          (SELECT COUNT(*) FROM voice_agents) AS agents,
          (SELECT COUNT(*) FROM workflows) AS flows,
          (SELECT COUNT(*) FROM devices) AS devices,
          (SELECT COUNT(*) FROM voicemails) AS voicemails,
          (SELECT COUNT(*) FROM invoices) AS invoices,
          (SELECT COUNT(*) FROM tasks) AS tasks`
);
console.log(
  `[seed] workspace — ${workspaceStats.sites} sites, ${workspaceStats.devices} devices, ${workspaceStats.agents} agents, ` +
    `${workspaceStats.flows} flows, ${workspaceStats.voicemails} voicemails, ${workspaceStats.invoices} invoices, ` +
    `${workspaceStats.tasks} tasks`
);
