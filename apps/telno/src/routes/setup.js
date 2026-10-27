import { db_, now } from '../db/index.js';
import { resolveNumber } from '../lib/registry.js';
import { insertExtension, extensionByNumber, suggestExtension } from '../lib/extensions.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import * as v from '../lib/validate.js';
import { applyAfterChange, telephonyStatus } from '../telephony/index.js';
import { tlsPaths } from '../telephony/provision.js';
import { voipmsConfigured } from '../lib/carriers/voipms.js';
import { pushStatus } from '../lib/push.js';
import { config } from '../config.js';

/**
 * First run.
 *
 * A container that has just been deployed has an owner account and nothing
 * else: no line, no number, so no call can be placed or received and every
 * screen in the console is an empty panel. This is the shortest honest path
 * from that state to a registered phone, and it deliberately does not use a
 * separate creation path — a line made here is the same row the Extensions
 * screen makes, written by the same helper.
 */

const displayNameFor = (account) => {
  const name = String(account?.name || '').trim();
  if (name) return name;
  const local = String(account?.email || '').split('@')[0];
  return local ? local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';
};

const numberView = (row) => (row ? { e164: row.e164 } : null);

export default async function setupRoutes(app) {
  app.addHook('preHandler', async (request) => {
    // Staff only: a customer's console is their own line, and setup is the
    // switch's own front door.
    await app.authenticate(request);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  /** What is missing between this install and a phone that rings. */
  app.get('/setup', async (request) => {
    const extensions = db_.all('SELECT * FROM extensions WHERE enabled = 1 ORDER BY extension');
    const numbers = db_.get('SELECT COUNT(*) AS n FROM numbers').n;
    const trunks = db_.get('SELECT COUNT(*) AS n FROM trunks WHERE enabled = 1').n;
    const switchStatus = await telephonyStatus();
    const tls = tlsPaths();
    const push = pushStatus();
    const softphoneReady = config.softphone.enabled && tls.ready;

    return {
      // "First run" is one fact, not a guess: no enabled line means nothing on
      // this platform can ring.
      needed: extensions.length === 0,
      suggested: {
        extension: suggestExtension(),
        displayName: displayNameFor(request.account),
      },
      steps: [
        {
          id: 'line',
          title: 'Create your line',
          done: extensions.length > 0,
          detail:
            extensions.length > 0
              ? `${extensions.length} line${extensions.length === 1 ? '' : 's'} on the switch`
              : 'An extension is the number you dial and the identity that registers.',
        },
        {
          id: 'number',
          title: 'Give it a phone number',
          done: numbers > 0,
          detail:
            numbers > 0
              ? `${numbers} number${numbers === 1 ? '' : 's'} in the registry`
              : 'Optional to start: attach a number you own, or buy one at VoIP.ms.',
        },
        {
          id: 'register',
          title: 'Register a phone',
          done: false,
          ready: softphoneReady,
          detail: softphoneReady
            ? 'Open the softphone to register this browser, or install the SCIF app and sign in on the line.'
            : 'The softphone cannot register yet: the switch listener or its certificate is missing.',
        },
      ],
      counts: { extensions: extensions.length, numbers, trunks },
      switch: {
        connected: !!switchStatus.connected,
        simulated: !!switchStatus.simulated,
        error: switchStatus.error || '',
      },
      softphone: {
        enabled: config.softphone.enabled,
        tls: tls.ready,
        video: config.softphone.video,
        ticketTtlSec: config.softphone.ticketTtlSec,
      },
      // A number can be bought here only if the carrier is configured; the UI
      // hides the offer rather than sending somebody to a dead end.
      carrier: { voipms: voipmsConfigured() },
      push: { enabled: push.enabled, parking: push.parking?.enabled },
    };
  });

  /**
   * Create the first line, and optionally attach a number in the same step.
   *
   * Not restricted to an empty switch: an operator setting up a second line is
   * the same job, and refusing it here would be an arbitrary rule.
   */
  app.post('/setup/line', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const extension = v.str(body.extension, { name: 'extension', max: 6, required: false }) || suggestExtension();
    if (!extension) throw badRequest('Every extension from 101 to 999 is in use');

    let number = null;
    if (v.str(body.number, { name: 'number', max: 20, required: false })) {
      // resolveNumber records the DID in the registry as well, so the line is
      // reachable from the Numbers screen the moment it exists.
      const resolved = resolveNumber(body.number, { source: 'setup' });
      number = resolved.number;
    }

    const created = insertExtension({
      extension,
      displayName: v.str(body.displayName, { name: 'displayName', max: 80, required: false }) || displayNameFor(request.account),
      email: request.account.email,
      numberId: number?.id || null,
    });

    logEvent({
      actor: request.account.email,
      action: 'setup.line_created',
      subject: created.extension,
      detail: number?.e164 || '',
      ip: request.ip,
    });

    // The switch has to know immediately: a line that exists in the console and
    // not in extensions.conf is a line that does not ring.
    const applied = await applyAfterChange(request);
    reply.status(201);
    return {
      extension: {
        id: created.id,
        extension: created.extension,
        displayName: created.display_name,
        number: numberView(number),
        // Shown once, because a phone registers with it and there is no other
        // way to read it back out of the console.
        secret: created.secret,
      },
      number: numberView(number),
      applied: applied || null,
    };
  });

  /** Attach a number to a line that already exists. */
  app.post('/setup/number', { preHandler: requireWrite }, async (request) => {
    const extension = extensionByNumber(v.str(request.body?.extension, { name: 'extension', max: 6 }));
    if (!extension) throw notFound('That extension does not exist');
    const resolved = resolveNumber(v.str(request.body?.number, { name: 'number', max: 20 }), {
      source: 'setup',
    });
    db_.run('UPDATE extensions SET number_id = ?, updated_at = ? WHERE id = ?', [resolved.id, now(), extension.id]);
    logEvent({
      actor: request.account.email,
      action: 'setup.number_attached',
      subject: extension.extension,
      detail: resolved.e164,
      ip: request.ip,
    });
    const applied = await applyAfterChange(request);
    return {
      extension: { id: extension.id, extension: extension.extension, number: numberView(resolved.number) },
      applied: applied || null,
    };
  });
}
