import { db_, now } from '../db/index.js';
import { logEvent } from './audit.js';

/**
 * The consoles this platform sits beside, registered rather than remembered.
 *
 * These are defaults, not policy: each row is inserted only when it is missing,
 * so an operator who renamed or removed one is not overruled on the next boot.
 * The one thing done to existing rows is narrow — a system that is disabled but
 * has never been edited was only ever defaulted off, so it is switched on once.
 * A system somebody actually changed is left exactly as they left it.
 *
 * The interview dashboard belongs here for a plain reason: interviews are not
 * this platform's data. They live in their own console, so this is the link to
 * them, with a live probe saying whether that console is answering.
 */
export const CONNECTED_SYSTEMS = [
  {
    id: 'sys_interviews',
    name: 'Interview dashboard',
    host: 'https://dashboard.pbx.it.com',
    path: '/interviews',
    description: 'Interview pipeline and candidate records, in their own console.',
    group: 'Operations',
    order: 10,
    links: [['Interviews', '/interviews']],
  },
  {
    id: 'sys_capstone',
    name: 'Capstone',
    host: 'https://capstone.pbx.services',
    path: '/',
    description: 'The capstone operations console behind the same SSO gateway.',
    group: 'Capstone',
    order: 20,
    links: [],
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

export function ensureConnectedSystems() {
  let added = 0;
  for (const system of CONNECTED_SYSTEMS) {
    if (db_.get('SELECT id FROM systems WHERE id = ?', [system.id])) continue;
    db_.run(
      `INSERT INTO systems (id, name, host, path, description, group_name, links, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        system.id,
        system.name,
        system.host,
        system.path,
        system.description,
        system.group,
        JSON.stringify((system.links || []).map(([label, path]) => ({ label, path }))),
        system.order,
      ]
    );
    added += 1;
  }

  // Never-edited rows disabled by an older default are linked now. Stamping
  // updated_at is what makes this run once: an operator who switches a system
  // off afterwards has an edit on the row, so the next boot leaves it alone.
  const enabled = db_.run(
    'UPDATE systems SET enabled = 1, updated_at = ? WHERE enabled = 0 AND updated_at = created_at',
    [now()]
  );

  if (added) logEvent({ actor: 'system', action: 'systems.linked', subject: 'connected systems', detail: `${added} added` });
  return { added, enabled: enabled.changes ?? 0 };
}
