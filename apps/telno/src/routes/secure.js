import { db_, newId, now } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import * as v from '../lib/validate.js';
import { logEvent } from '../lib/audit.js';
import { open, seal, threadId } from '../lib/secure.js';

/**
 * The internal channel: messages between people on this platform, carried by
 * nothing but this database.
 *
 * Every query is scoped to the signed-in identity, because a conversation is not
 * public just because it is internal. A recipient is either an account (by
 * email) or an extension whose owner account can be resolved; an extension that
 * nobody owns is addressable as `extension:<number>` so a staff line still has
 * somewhere to receive.
 */

const identity = (request) => String(request.account?.email || '').toLowerCase();

const view = (row) => ({
  id: row.id,
  threadId: row.thread_id,
  direction: row.direction,
  from: row.from_label,
  to: row.to_label,
  body: open(row.body_cipher),
  status: row.status,
  readAt: row.read_at,
  createdAt: row.created_at,
});

function resolveRecipient(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) throw badRequest('a recipient is required');
  if (value.includes('@')) {
    const account = db_.get('SELECT * FROM accounts WHERE lower(email) = ?', [value]);
    if (!account) throw notFound(`No account with the email ${value}`);
    return { label: account.email.toLowerCase(), accountId: account.id, extension: '' };
  }
  const digits = value.replace(/[^\d]/g, '');
  const extension = db_.get('SELECT * FROM extensions WHERE extension = ?', [digits]);
  if (extension?.account_id) {
    const account = db_.get('SELECT * FROM accounts WHERE id = ?', [extension.account_id]);
    if (account) return { label: account.email.toLowerCase(), accountId: account.id, extension: digits };
  }
  // An unowned line has nowhere to deliver: a message dropped into a mailbox
  // nobody holds is worse than a refusal that names the reason.
  if (extension) throw badRequest(`Extension ${digits} has no account, so there is nobody to deliver to`);
  throw notFound(`No extension or account matches ${raw}`);
}

export default async function secureRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator', 'viewer');

  /** Who you can message, so the compose form is a picker rather than a guess. */
  app.get('/secure-messages/recipients', async (request) => {
    const me = identity(request);
    const accounts = db_
      .all('SELECT email, name, role FROM accounts ORDER BY email')
      .filter((row) => String(row.email).toLowerCase() !== me)
      .map((row) => ({ value: row.email.toLowerCase(), label: `${row.name || row.email} — ${row.role}`, kind: 'account' }));
    const extensions = db_
      .all(
        `SELECT e.extension, e.display_name, a.email
           FROM extensions e LEFT JOIN accounts a ON a.id = e.account_id
          ORDER BY e.extension`
      )
      .filter((row) => !row.email || String(row.email).toLowerCase() !== me)
      .map((row) => ({
        value: row.email ? String(row.email).toLowerCase() : `extension:${row.extension}`,
        label: `${row.extension} — ${row.display_name || 'line'}${row.email ? ` (${row.email})` : ''}`,
        kind: 'extension',
      }));
    // One entry per value: an extension and its owner resolve to the same inbox.
    const seen = new Set();
    const items = [];
    for (const entry of [...accounts, ...extensions]) {
      if (seen.has(entry.value)) continue;
      seen.add(entry.value);
      items.push(entry);
    }
    return { items };
  });

  app.get('/secure-messages', async (request) => {
    const mine = request.account.id;
    const thread = v.str(request.query?.thread, { name: 'thread', max: 320, required: false });
    // Scoped by the copy's owner, not by the labels on it: both ends see the
    // same conversation, but each sees only their own copy of the messages.
    const where = thread ? ['thread_id = ?', 'account_id = ?'] : ['account_id = ?'];
    const params = thread ? [thread, mine] : [mine];
    const items = db_
      .all(
        `SELECT * FROM secure_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params
      )
      .map(view);

    // One row per conversation, with the newest message as its summary.
    const threads = new Map();
    for (const item of items) {
      if (threads.has(item.threadId)) continue;
      const other = item.direction === 'outbound' ? item.to : item.from;
      threads.set(item.threadId, {
        threadId: item.threadId,
        counterpart: other,
        last: item.body.slice(0, 140),
        lastAt: item.createdAt,
        unread: items.filter((row) => row.threadId === item.threadId && row.direction === 'inbound' && row.status !== 'read').length,
      });
    }

    return {
      items: thread ? items.reverse() : items,
      threads: [...threads.values()],
      summary: {
        total: items.length,
        threads: threads.size,
        unread: items.filter((row) => row.direction === 'inbound' && row.status !== 'read').length,
        // The honest cost of this channel: nothing per message, because nobody
        // outside this deployment carries it.
        cost: '$0.00 — internal, no carrier',
      },
    };
  });

  app.post('/secure-messages', { preHandler: requireWrite }, async (request, reply) => {
    const me = identity(request);
    const body = request.body || {};
    const to = resolveRecipient(body.to);
    const text = v.str(body.body, { name: 'body', max: 4000 });
    const id = newId('smg_');
    const thread = threadId(me, to.label);
    const stamp = now();

    db_.tx(() => {
      db_.run(
        `INSERT INTO secure_messages (id, thread_id, direction, from_label, to_label, account_id, extension, body_cipher, status, created_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, 'delivered', ?)`,
        [id, thread, me, to.label, request.account?.id || null, to.extension, seal(text), stamp]
      );
      // The recipient's copy is a row of its own: delivery is a fact this
      // platform can state, not a promise about somebody else's server.
      db_.run(
        `INSERT INTO secure_messages (id, thread_id, direction, from_label, to_label, account_id, extension, body_cipher, status, created_at)
         VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, 'delivered', ?)`,
        [newId('smg_'), thread, me, to.label, to.accountId, to.extension, seal(text), stamp]
      );
    });

    logEvent({ actor: me, action: 'secure_message.sent', subject: to.label, detail: `${text.length} characters`, ip: request.ip });
    reply.status(201);
    return { message: view(db_.get('SELECT * FROM secure_messages WHERE id = ?', [id])), threadId: thread, delivered: true };
  });

  app.post('/secure-messages/:id/read', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM secure_messages WHERE id = ?', [request.params.id]);
    if (!row || row.account_id !== request.account.id) throw notFound('Message not found');
    db_.run("UPDATE secure_messages SET status = 'read', read_at = ? WHERE id = ? AND status <> 'read'", [now(), row.id]);
    return { message: view(db_.get('SELECT * FROM secure_messages WHERE id = ?', [row.id])) };
  });
}
