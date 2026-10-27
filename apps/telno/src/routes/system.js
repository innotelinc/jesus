import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { telephonyStatus, applyConfiguration, previewConfiguration } from '../telephony/index.js';
import { newApiKey } from '../lib/security.js';
import { badRequest, notFound } from '../lib/errors.js';
import { recentEvents, logEvent } from '../lib/audit.js';
import { directoryStats } from '../lib/registry.js';
import { channelStatus, sendEmail } from '../lib/channels.js';
import { listSecrets, putSecret, deleteSecret } from '../lib/vault.js';
import { paymentStatus } from '../lib/payments.js';
import { aiStatus, testAi } from '../lib/ai.js';
import { brand, saveBrand, publicBrand } from '../lib/brand.js';
import { magnateUrl, publicPricing } from '../lib/subscriptions.js';
import {
  backupStatus,
  dbPath,
  deleteBackup,
  inspectBackup,
  listBackups,
  requestRestartAfterRestore,
  runBackup,
  stageRestore,
} from '../lib/backup.js';
import * as v from '../lib/validate.js';

const domainView = (row) => ({
  slug: row.slug,
  host: row.host,
  label: row.label,
  tagline: row.tagline,
  scope: row.scope,
  accent: row.accent,
  enabled: !!row.enabled,
  sortOrder: row.sort_order,
});

export default async function systemRoutes(app) {
  /** Liveness for Docker/compose. No auth, no secrets, no data. */
  app.get('/healthz', async () => ({
    ok: true,
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    db: 'ok',
  }));

  app.get('/system/status', { preHandler: app.authenticate }, async () => {
    const counts = {
      extensions: db_.get('SELECT COUNT(*) AS n FROM extensions').n,
      trunks: db_.get('SELECT COUNT(*) AS n FROM trunks').n,
      ivr: db_.get('SELECT COUNT(*) AS n FROM ivr_flows').n,
      calls: db_.get('SELECT COUNT(*) AS n FROM calls').n,
      pending: db_.get("SELECT COUNT(*) AS n FROM submissions WHERE status IN ('awaiting_verification','verified')").n,
    };
    return {
      telephony: await telephonyStatus(),
      directory: directoryStats(),
      counts,
      channels: channelStatus(),
      // Whether card payment is on, which mode, and the URL Stripe has to call.
      // Settings shows this next to the vault fields that switch it on.
      payments: paymentStatus(),
      // The model behind grading and suggestions, and whether the catalogue is
      // mirrored into the subscriber system of record.
      ai: aiStatus(),
      // What the console header, the public site and the signup page call this
      // deployment. Edited in Settings → Branding.
      brand: brand(),
      commerce: {
        magnateConfigured: !!magnateUrl(),
        subscribeUrl: config.subscribeUrl || '/subscribe',
        plans: publicPricing().plans.length,
      },
      catalog: {
        defaultCountry: config.defaultCountry,
        domains: config.directory.domains,
        canonical: config.directory.canonical,
        simulate: config.telephony.simulate,
      },
      storage: { dbFile: dbPath() },
    };
  });

  // ----------------------------------------------------------------- backups --
  // Owner-only: an archive is the whole database, and a restore replaces it.

  app.get('/system/backups', { preHandler: app.authenticate }, async () => ({
    status: backupStatus(),
    items: listBackups(),
  }));

  app.post('/system/backups', { preHandler: app.requireRole('owner') }, async (request) => {
    const result = await runBackup({ label: `manual:${request.account.email}` });
    if (!result.ok) {
      logEvent({ actor: request.account.email, action: 'backup.manual_failed', subject: result.name, detail: result.error });
      throw badRequest(`Backup failed: ${result.error}`);
    }
    logEvent({
      actor: request.account.email,
      action: 'backup.manual',
      subject: result.name,
      detail: `${Math.round(result.bytes / 1024)} kB, pruned ${result.pruned.length}`,
    });
    return { ...result, status: backupStatus(), items: listBackups() };
  });

  app.get('/system/backups/:name', { preHandler: app.requireRole('owner') }, async (request) => {
    const name = v.str(request.params?.name, { name: 'name', max: 80, required: true });
    const result = await inspectBackup(name);
    if (!result.ok) throw notFound(`No usable backup named ${name} (${result.error})`);
    return result;
  });

  /**
   * A restore cannot swap the database out from under the process serving this
   * request, so it is staged and applied at the next boot; the platform asks to
   * be restarted, which the container's supervisor does immediately.
   */
  app.post('/system/backups/restore', { preHandler: app.requireRole('owner') }, async (request) => {
    const name = v.str(request.body?.name, { name: 'name', max: 80, required: true });
    const preview = await inspectBackup(name);
    if (!preview.ok) throw badRequest(`Restore failed: no usable backup named ${name} (${preview.error})`);

    if (request.body?.dryRun === true) {
      logEvent({ actor: request.account.email, action: 'backup.restore_checked', subject: name });
      return { ok: true, dryRun: true, name, manifest: preview.manifest, records: preview.records };
    }

    const staged = stageRestore(name, { by: request.account.email });
    if (!staged.ok) throw badRequest(`Restore failed: ${staged.error}`);

    // The response is flushed before the process goes down, so the operator sees
    // the answer rather than a dropped connection.
    requestRestartAfterRestore();
    return { ...staged, records: preview.records, manifest: preview.manifest };
  });

  app.delete('/system/backups/:name', { preHandler: app.requireRole('owner') }, async (request) => {
    const name = v.str(request.params?.name, { name: 'name', max: 80, required: true });
    const result = deleteBackup(name);
    if (!result.ok) throw notFound(`No backup named ${name}`);
    logEvent({ actor: request.account.email, action: 'backup.deleted', subject: name });
    return { deleted: true, name, items: listBackups() };
  });

  app.post('/system/apply', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const result = await applyConfiguration(request.account.email);
    return { ...result, telephony: await telephonyStatus() };
  });

  app.get('/system/config-preview', { preHandler: app.authenticate }, async (request) => {
    const files = previewConfiguration();
    const only = v.str(request.query?.file, { name: 'file', max: 40, required: false });
    if (only) {
      if (!files[only]) throw notFound(`No generated file named ${only}`);
      return { file: only, content: files[only] };
    }
    return { files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content])) };
  });

  app.get('/system/domains', { preHandler: app.authenticate }, async () => ({
    items: db_.all('SELECT * FROM domains ORDER BY sort_order, host').map(domainView),
    configured: config.directory.domains,
  }));

  app.patch('/system/domains/:slug', { preHandler: app.requireRole('owner') }, async (request) => {
    const row = db_.get('SELECT * FROM domains WHERE slug = ?', [request.params.slug]);
    if (!row) throw notFound('Domain not found');
    const body = request.body || {};
    const patch = {};
    if (body.label !== undefined) patch.label = v.str(body.label, { name: 'label', max: 80 });
    if (body.tagline !== undefined) patch.tagline = v.str(body.tagline, { name: 'tagline', max: 160, required: false });
    if (body.accent !== undefined) {
      patch.accent = v.str(body.accent, { name: 'accent', max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/ });
    }
    if (body.scope !== undefined) patch.scope = v.str(body.scope, { name: 'scope', max: 2, required: false }) || 'world';
    if (body.enabled !== undefined) patch.enabled = v.bool(body.enabled) ? 1 : 0;
    if (body.sortOrder !== undefined) patch.sort_order = v.integer(body.sortOrder, { name: 'sortOrder', min: 0, max: 9999 });
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db_.run(`UPDATE domains SET ${sets} WHERE slug = ?`, [...Object.values(patch), row.slug]);
    logEvent({ actor: request.account.email, action: 'system.domain_updated', subject: row.slug, ip: request.ip });
    return { domain: domainView(db_.get('SELECT * FROM domains WHERE slug = ?', [row.slug])) };
  });

  app.get('/system/keys', { preHandler: app.authenticate }, async () => ({
    items: db_
      .all('SELECT id, label, prefix, scope, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC')
      .map((k) => ({
        id: k.id,
        label: k.label,
        prefix: k.prefix,
        scope: k.scope,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
        revokedAt: k.revoked_at,
      })),
  }));

  app.post('/system/keys', { preHandler: app.requireRole('owner') }, async (request, reply) => {
    const body = request.body || {};
    const label = v.str(body.label, { name: 'label', max: 80 });
    const scope = v.str(body.scope, { name: 'scope', max: 120, required: false, fallback: 'registry:read' });
    const { secret, prefix, hash } = newApiKey();
    db_.run('INSERT INTO api_keys (id, label, prefix, key_hash, scope) VALUES (?, ?, ?, ?, ?)', [
      `key_${Date.now().toString(36)}`,
      label,
      prefix,
      hash,
      scope,
    ]);
    logEvent({ actor: request.account.email, action: 'system.key_created', subject: label, ip: request.ip });
    reply.status(201);
    // The only time the secret is ever returned.
    return { key: secret, prefix, label, scope };
  });

  app.delete('/system/keys/:id', { preHandler: app.requireRole('owner') }, async (request) => {
    const row = db_.get('SELECT * FROM api_keys WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Key not found');
    db_.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [now(), row.id]);
    logEvent({ actor: request.account.email, action: 'system.key_revoked', subject: row.label, ip: request.ip });
    return { ok: true };
  });

  /* ------------------------------------------------------------------ vault -- */
  // Credentials live here, not in the image. The API returns names, hints and
  // dates only: once a value is stored there is no endpoint that echoes it.

  app.get('/system/brand', { preHandler: app.requireRole('owner', 'operator') }, async () => ({
    brand: brand(),
    public: publicBrand(),
  }));

  /**
   * White-label edit. The accent colour is validated as a hex value because it
   * is written into a stylesheet, and the logo as an http(s) URL because it is
   * fetched by every visitor's browser.
   */
  app.put('/system/brand', { preHandler: app.requireRole('owner') }, async (request) => {
    const result = saveBrand(request.body || {});
    if (!result.ok) throw badRequest(result.errors.join('; '));
    logEvent({
      actor: request.account.email,
      action: 'brand.updated',
      subject: result.brand.name,
      detail: result.brand.vendor,
      ip: request.ip,
    });
    return { brand: result.brand, public: publicBrand(), channels: channelStatus() };
  });

  /**
   * The model is a real round trip, not a key-shaped string in a field. A
   * gateway can hold a key that is wrong, expired or out of credit, and the
   * grader would silently fall back to rules for weeks.
   */
  app.post('/system/ai/test', { preHandler: app.requireRole('owner', 'operator') }, async () => ({
    status: aiStatus(),
    test: await testAi(),
  }));

  app.get('/system/vault', { preHandler: app.requireRole('owner') }, async () => ({
    items: listSecrets(),
    channels: channelStatus(),
  }));

  app.put('/system/vault/:name', { preHandler: app.requireRole('owner') }, async (request) => {
    const body = request.body || {};
    const value = v.str(body.value, { name: 'value', max: 4096 });
    const secret = putSecret(request.params.name, value, request.account.email);
    // The name and the hint are logged; the value is not, anywhere.
    logEvent({
      actor: request.account.email,
      action: 'system.secret_set',
      subject: secret.name,
      detail: secret.hint,
      ip: request.ip,
    });
    return { secret, channels: channelStatus() };
  });

  app.delete('/system/vault/:name', { preHandler: app.requireRole('owner') }, async (request) => {
    const removed = deleteSecret(request.params.name);
    if (!removed) throw notFound('No secret with that name');
    logEvent({
      actor: request.account.email,
      action: 'system.secret_deleted',
      subject: String(request.params.name).toUpperCase(),
      ip: request.ip,
    });
    return { ok: true, channels: channelStatus() };
  });

  /** Proves the stored key actually reaches the provider, from the container. */
  app.post('/system/email/test', { preHandler: app.requireRole('owner') }, async (request) => {
    const to = v.email(request.body?.to || request.account.email, { name: 'to' });
    const result = await sendEmail({
      to,
      subject: 'Telno test message',
      text:
        'This is a test from your Telno platform.\n\n' +
        'If it arrived, the mail key in Settings → Email delivery is working and invoice ' +
        'resends, directory verification codes and reports will use the same provider.',
    });
    logEvent({
      actor: request.account.email,
      action: 'system.email_tested',
      subject: to,
      detail: result.delivered ? `sent via ${result.provider}` : `failed: ${result.error}`,
      ip: request.ip,
    });
    return { sent: result.delivered, provider: result.provider, error: result.error || null, to };
  });

  app.get('/system/events', { preHandler: app.authenticate }, async (request) => ({
    items: recentEvents(v.integer(request.query?.limit, { name: 'limit', min: 1, max: 200, required: false, fallback: 50 })),
  }));
}
