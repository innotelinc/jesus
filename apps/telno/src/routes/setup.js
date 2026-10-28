import { db_, now } from '../db/index.js';
import { resolveNumber } from '../lib/registry.js';
import { insertExtension, extensionByNumber, suggestExtension } from '../lib/extensions.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { needsOnboarding, numberCount, lineCount } from '../lib/onboarding.js';
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

/**
 * Put a number on the account that just attached it to a line.
 *
 * The registry is worldwide and most of its rows belong to nobody, so a number
 * is only ever claimed here — by the setup path, for an account that is putting
 * it on its own line — and never adopted in bulk.
 */
const claimNumber = (numberId, accountId) => {
  if (!numberId || !accountId) return;
  db_.run('UPDATE numbers SET account_id = ? WHERE id = ? AND (account_id IS NULL OR account_id = ?)', [
    accountId,
    numberId,
    accountId,
  ]);
};

/**
 * Whether this number may be published in the worldwide directory.
 *
 * Not a silent default either way: the account answers that question in the step
 * before this one, and a number put on a line is listed only if they said their
 * numbers may be. resolveNumber applies it, so a number that already exists in
 * the registry is corrected rather than left public by accident.
 */
const listedFor = (account) => (account?.directory_opt_in ? 'public' : 'private');

export default async function setupRoutes(app) {
  app.addHook('preHandler', async (request) => {
    // Staff only: a customer's console is their own line, and setup is the
    // switch's own front door.
    await app.authenticate(request);
  });
  /**
   * Staff write, or an account still in the first login creating the one thing it
   * cannot do without.
   *
   * A subscriber is not an operator, and the last step of the wizard is a line
   * with a number on it — so without this the one screen every new account has to
   * finish would be closed to the people signing up. The allowance is narrow on
   * purpose: it holds only while the account is unfinished, only for the first
   * line it owns and the first number on it, and it is spent the moment setup is
   * done. Everything else about the switch stays staff-only, which is what the
   * test suite asserts against a customer session.
   */
  const requireWriteOrSetup = async (request, kind) => {
    const account = request.account || app.readSession(request);
    if (!account) throw unauthorized();
    if (['owner', 'operator'].includes(account.role)) return;
    if (!needsOnboarding(account)) throw forbidden('Requires one of: owner, operator');
    const owned = kind === 'number' ? numberCount(account.id) : lineCount(account.id);
    if (owned > 0) throw forbidden('Requires one of: owner, operator');
  };
  const requireOwnLine = (kind) => async (request) => requireWriteOrSetup(request, kind);

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
  app.post('/setup/line', { preHandler: requireOwnLine('line') }, async (request, reply) => {
    const body = request.body || {};
    const extension = v.str(body.extension, { name: 'extension', max: 6, required: false }) || suggestExtension();
    if (!extension) throw badRequest('Every extension from 101 to 999 is in use');

    let number = null;
    if (v.str(body.number, { name: 'number', max: 20, required: false })) {
      // resolveNumber records the DID in the registry as well, so the line is
      // reachable from the Numbers screen the moment it exists.
      const resolved = resolveNumber(body.number, {
        source: 'setup',
        visibility: listedFor(request.account),
      });
      number = resolved.number;
      claimNumber(number.id, request.account.id);
    }

    const created = insertExtension({
      extension,
      displayName: v.str(body.displayName, { name: 'displayName', max: 80, required: false }) || displayNameFor(request.account),
      email: request.account.email,
      numberId: number?.id || null,
      // The line belongs to whoever made it. Without this the wizard's own step
      // could never see it and the account would stay unfinished.
      accountId: request.account.id,
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
  app.post('/setup/number', { preHandler: requireOwnLine('number') }, async (request) => {
    const extension = extensionByNumber(v.str(request.body?.extension, { name: 'extension', max: 6 }));
    if (!extension) throw notFound('That extension does not exist');
    // A subscriber may only put a number on a line of their own: an operator's
    // line is not theirs to change, however tidy the extension number looks.
    if (!['owner', 'operator'].includes(request.account.role) && extension.account_id !== request.account.id) {
      throw notFound('That extension does not exist');
    }
    const resolved = resolveNumber(v.str(request.body?.number, { name: 'number', max: 20 }), {
      source: 'setup',
      visibility: listedFor(request.account),
    });
    db_.run('UPDATE extensions SET number_id = ?, updated_at = ? WHERE id = ?', [resolved.id, now(), extension.id]);
    claimNumber(resolved.id, request.account.id);
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
