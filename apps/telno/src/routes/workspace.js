import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { newDeviceToken } from '../lib/security.js';
import { PROVISION_FORMATS, buildProvisioning } from '../lib/provisioning.js';
import {
  DEVICE_KINDS,
  DEVICE_STATES,
  isSilent,
  normalizeIp,
  normalizeMac,
} from '../lib/devices.js';
import { formatNumber } from '../lib/e164.js';
import { resolveNumber } from '../lib/registry.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { telephonyStatus } from '../telephony/index.js';
import { activeChannel, channelStatus, deliverNotice } from '../lib/channels.js';
import { invoiceEmail } from '../lib/mail.js';
import {
  payUrlForInvoice,
  paymentStatus,
  repairWebhookEndpoint,
  testConnection,
  webhookEventStatus,
  webhookUrl,
} from '../lib/payments.js';
import { ladder, reminderHistory, runReminderSweep, sendReminderNow } from '../lib/reminders.js';
import { monthPeriod } from '../lib/rentals.js';
import { maskPhone, maskText, maskedExtensions, maskedNumberIds } from '../lib/scif.js';
import { faxStatus, sendFax } from '../lib/fax.js';
import { presets } from '../lib/presets.js';
import {
  addItem,
  billPlanOnto,
  billRentOnto,
  itemsFor,
  monthBounds,
  monthLabel,
  nextInvoiceNumber,
  releaseRentFromInvoice,
  removeItem,
  runMonthlyInvoicing,
  uninvoicedRent,
  updateItem,
} from '../lib/invoicing.js';
import {
  billingAccount,
  escalationPolicy,
  listBillingAccounts,
  reinstateAccount,
} from '../lib/escalation.js';
import * as v from '../lib/validate.js';

/* ------------------------------------------------------------------ utils -- */

const num = (value) => (value ? formatNumber(value) : '');

/** Attach a canonical registry row to whatever object is being created. */
function linkNumber(raw) {
  if (!raw) return null;
  return resolveNumber(raw, { source: 'platform' }).id;
}

/** Accepts an ISO date, a date, or a datetime-local value; returns ISO or ''. */
function isoDate(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${name} is required`);
    return '';
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(text)) throw badRequest(`${name} must be a date`);
  const date = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(date.getTime())) throw badRequest(`${name} is not a valid date`);
  return date.toISOString();
}

function parseSteps(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeSteps(input) {
  const list = Array.isArray(input) ? input : [];
  return list.slice(0, 20).map((step) => ({
    type: String(step?.type ?? 'action').slice(0, 24),
    label: String(step?.label ?? '').slice(0, 80),
    target: String(step?.target ?? '').slice(0, 80),
  }));
}

/**
 * Writes a validated patch and returns the fresh row.
 * `columns` maps camelCase input to snake_case columns; `cast` runs per value.
 */
function patchRow(table, row, body, columns, { actor, action, subject, ip, cast = {}, touch = true }) {
  const patch = {};
  for (const [key, column] of Object.entries(columns)) {
    if (body[key] === undefined) continue;
    patch[column] = cast[key] ? cast[key](body[key]) : body[key];
  }
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const sets = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
  const values = [...Object.values(patch)];
  if (touch) {
    db_.run(`UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`, [...values, now(), row.id]);
  } else {
    db_.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...values, row.id]);
  }
  logEvent({ actor, action, subject: subject ?? row.id, ip });
  return db_.get(`SELECT * FROM ${table} WHERE id = ?`, [row.id]);
}

/* ------------------------------------------------------------------ views -- */

const voiceView = (row) => ({
  id: row.id,
  name: row.name,
  voice: row.voice,
  language: row.language,
  model: row.model,
  greeting: row.greeting,
  prompt: row.prompt,
  status: row.status,
  recordInbound: !!row.record_inbound,
  recordOutbound: !!row.record_outbound,
  callsHandled: row.calls_handled,
  avgHandlingSec: row.avg_handling_sec,
  numberId: row.number_id,
  number: num(row.e164),
  updatedAt: row.updated_at,
});

const workflowView = (row) => ({
  id: row.id,
  name: row.name,
  trigger: row.trigger,
  status: row.status,
  steps: parseSteps(row.steps),
  runs: row.runs,
  successCount: row.success_count,
  failureCount: row.failure_count,
  lastRunAt: row.last_run_at,
  lastStatus: row.last_status,
  updatedAt: row.updated_at,
});

const voicemailView = (row) => ({
  id: row.id,
  extension: row.extension,
  from: num(row.from_e164),
  fromE164: row.from_e164,
  duration: row.duration,
  transcript: row.transcript,
  recording: !!row.recording,
  audioUrl: row.recording ? `/api/voicemails/${row.id}/audio` : '',
  urgent: !!row.urgent,
  listened: !!row.listened,
  receivedAt: row.received_at,
});

const faxView = (row) => ({
  id: row.id,
  direction: row.direction,
  from: num(row.from_e164),
  to: num(row.to_e164),
  pages: row.pages,
  status: row.status,
  subject: row.subject,
  document: row.document,
  body: row.body,
  attachmentName: row.attachment_name,    attachmentUrl: row.attachment ? `/api/faxes/${row.id}/attachment` : '',
    // Why a transmission failed, in the switch's own words.
    error: row.error || '',
    stationId: row.station_id || '',
  at: row.at,
});

const messageView = (row) => ({
  id: row.id,
  channel: row.channel,
  direction: row.direction,
  from: num(row.from_e164),
  to: num(row.to_e164),
  body: row.body,
  status: row.status,
  sentAt: row.sent_at,
});

const invoiceView = (row) => ({
  id: row.id,
  invoiceNo: row.invoice_no,
  accountName: row.account_name,
  email: row.email,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  issuedAt: row.issued_at,
  dueAt: row.due_at,
  paidAt: row.paid_at,
  lastSentAt: row.last_sent_at,
  // The provider that carried the last invoice email, and the failure if there
  // was one, so the console can answer "did it go, and through what?" per row.
  lastProvider: row.last_provider || '',
  lastSendError: row.last_send_error || '',
  remindersPaused: !!row.reminders_paused,
  lastRemindedAt: row.last_reminded_at || null,
  // Counted from the ledger, so an invoice cannot claim reminders it never had.
  reminderCount: row.reminder_count ?? 0,
  // The final notice is the rung that changes something: it names the day the
  // customer's service stops, so the row and the dialog show it.
  finalNoticeAt: row.final_notice_at || null,
  accountState: row.account_state || 'current',
  // Empty unless online payment is actually switched on, so the console never
  // offers a link that would fail.
  payUrl: payUrlForInvoice(row),
  paymentRef: row.payment_ref || '',
  // Which account and which month this bill is for. Both empty on a one-off
  // invoice that is only addressed to an email.
  accountId: row.account_id || null,
  rentPeriod: row.rent_period || '',
  // How many lines the total is made of. The list shows the count; the detail
  // shows the lines themselves.
  itemCount: row.item_count ?? 0,
  // The part of the bill a card subscription already collected. Shown so the
  // customer can see the plan on their bill without being charged for it twice.
  coveredCents: row.covered_cents ?? 0,
  notes: row.notes,
  createdAt: row.created_at,
});

/** One invoice with the lines that make up its total. */
const invoiceDetail = (row) => ({ ...invoiceView(row), items: itemsFor(row.id) });

/** Reminder counts come from the ledger, so they cannot be stale. */
const INVOICE_SELECT = `SELECT i.*,
    (SELECT COUNT(*) FROM invoice_items it WHERE it.invoice_id = i.id) AS item_count,
    (SELECT COALESCE(SUM(it.amount_cents), 0) FROM invoice_items it
      WHERE it.invoice_id = i.id AND it.settled_by = 'subscription') AS covered_cents,
    (SELECT COUNT(*) FROM invoice_reminders r WHERE r.invoice_id = i.id AND r.status = 'sent') AS reminder_count,
    (SELECT MAX(r.sent_at) FROM invoice_reminders r
      WHERE r.invoice_id = i.id AND r.kind = 'final' AND r.status = 'sent') AS final_notice_at,
    (SELECT b.state FROM billing_accounts b WHERE b.email = lower(i.email)) AS account_state
  FROM invoices i`;

/** Device counts are always derived from the inventory, never stored. */
const SITE_SELECT = `SELECT s.*,
    (SELECT COUNT(*) FROM devices d WHERE d.site_id = s.id) AS device_count,
    (SELECT COUNT(*) FROM devices d WHERE d.site_id = s.id AND d.status = 'online') AS online_count,
    (SELECT COUNT(*) FROM devices d WHERE d.site_id = s.id AND d.status IN ('offline', 'faulty')) AS problem_count
  FROM sites s`;

const siteView = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  city: row.city,
  country: row.country,
  timezone: row.timezone,
  deviceCount: row.device_count ?? 0,
  onlineCount: row.online_count ?? 0,
  problemCount: row.problem_count ?? 0,
  status: row.status,
  latencyMs: row.latency_ms,
  lastSeenAt: row.last_seen_at,
  updatedAt: row.updated_at,
});

const siteById = (id) => siteView(db_.get(`${SITE_SELECT} WHERE s.id = ?`, [id]));

const deviceView = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  model: row.model,
  mac: row.mac,
  ip: row.ip,
  firmware: row.firmware,
  status: row.status,
  // A live device that stopped checking in is surfaced, not silently trusted.
  silent: isSilent(row, config.devices.staleAfterSec),
  hasToken: !!row.token_hash,
  siteId: row.site_id,
  site: row.site_name || '',
  extensionId: row.extension_id,
  extension: row.extension || '',
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const DEVICE_SELECT = `SELECT d.*, s.name AS site_name, e.extension
  FROM devices d
  LEFT JOIN sites s ON s.id = d.site_id
  LEFT JOIN extensions e ON e.id = d.extension_id`;

const deviceById = (id) => deviceView(db_.get(`${DEVICE_SELECT} WHERE d.id = ?`, [id]));

/** Sites and extensions are accepted by id or by their human label. */
function linkSite(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const row = db_.get('SELECT id FROM sites WHERE id = ? OR name = ?', [String(raw), String(raw)]);
  if (!row) throw badRequest(`Unknown site: ${raw}`);
  return row.id;
}

function linkExtension(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const row = db_.get('SELECT id FROM extensions WHERE id = ? OR extension = ?', [String(raw), String(raw)]);
  if (!row) throw badRequest(`Unknown extension: ${raw}`);
  return row.id;
}

const taskView = (row) => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  priority: row.priority,
  status: row.status,
  assignee: row.assignee,
  siteId: row.site_id,
  site: row.site_name || '',
  dueAt: row.due_at,
  note: row.note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const count = (sql, params = []) => db_.get(sql, params)?.n || 0;

/* ------------------------------------------------------------------ routes -- */

export default async function workspaceRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  /* --------------------------------------------------------------- voice -- */
  app.get('/voice/agents', async () => ({
    items: db_
      .all(
        `SELECT a.*, n.e164 FROM voice_agents a
           LEFT JOIN numbers n ON n.id = a.number_id
          ORDER BY a.status = 'active' DESC, a.name`
      )
      .map(voiceView),
    summary: {
      active: count("SELECT COUNT(*) AS n FROM voice_agents WHERE status = 'active'"),
      total: count('SELECT COUNT(*) AS n FROM voice_agents'),
      callsHandled: count('SELECT COALESCE(SUM(calls_handled), 0) AS n FROM voice_agents'),
      avgHandlingSec: Math.round(db_.get("SELECT COALESCE(AVG(avg_handling_sec), 0) AS n FROM voice_agents WHERE avg_handling_sec > 0")?.n || 0),
      channels: channelStatus(),
    },
  }));

  app.post('/voice/agents', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const name = v.str(body.name, { name: 'name', max: 80 });
    if (db_.get('SELECT id FROM voice_agents WHERE name = ?', [name])) throw conflict(`An agent named ${name} already exists`);
    const id = newId('vag_');
    db_.run(
      `INSERT INTO voice_agents (id, name, voice, language, model, greeting, prompt, number_id, status, record_inbound, record_outbound)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        v.str(body.voice, { name: 'voice', max: 40, required: false, fallback: 'aria' }),
        v.str(body.language, { name: 'language', max: 16, required: false, fallback: 'en-US' }),
        v.str(body.model, { name: 'model', max: 40, required: false, fallback: 'telno-voice-1' }),
        v.str(body.greeting, { name: 'greeting', max: 400, required: false }),
        v.str(body.prompt, { name: 'prompt', max: 2000, required: false }),
        linkNumber(body.number),
        v.oneOf(body.status || 'draft', ['draft', 'active', 'paused'], 'status'),
        v.bool(body.recordInbound, false) ? 1 : 0,
        v.bool(body.recordOutbound, false) ? 1 : 0,
      ]
    );
    logEvent({ actor: request.account.email, action: 'voice.agent_created', subject: name, ip: request.ip });
    reply.status(201);
    return {
      agent: voiceView(
        db_.get('SELECT a.*, n.e164 FROM voice_agents a LEFT JOIN numbers n ON n.id = a.number_id WHERE a.id = ?', [id])
      ),
    };
  });

  app.patch('/voice/agents/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM voice_agents WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Voice agent not found');
    const body = request.body || {};
    const cast = {
      name: (value) => v.str(value, { name: 'name', max: 80 }),
      voice: (value) => v.str(value, { name: 'voice', max: 40 }),
      language: (value) => v.str(value, { name: 'language', max: 16 }),
      greeting: (value) => v.str(value, { name: 'greeting', max: 400, required: false }),
      prompt: (value) => v.str(value, { name: 'prompt', max: 2000, required: false }),
      model: (value) => v.str(value, { name: 'model', max: 40 }),
      status: (value) => v.oneOf(value, ['draft', 'active', 'paused'], 'status'),
      recordInbound: (value) => (v.bool(value) ? 1 : 0),
      recordOutbound: (value) => (v.bool(value) ? 1 : 0),
      number: (value) => linkNumber(value),
    };
    const fresh = patchRow(
      'voice_agents',
      row,
      body,
      {
        name: 'name',
        voice: 'voice',
        language: 'language',
        model: 'model',
        greeting: 'greeting',
        prompt: 'prompt',
        status: 'status',
        recordInbound: 'record_inbound',
        recordOutbound: 'record_outbound',
        number: 'number_id',
      },
      { actor: request.account.email, action: 'voice.agent_updated', subject: row.name, ip: request.ip, cast }
    );
    return {
      agent: voiceView(db_.get('SELECT a.*, n.e164 FROM voice_agents a LEFT JOIN numbers n ON n.id = a.number_id WHERE a.id = ?', [row.id])),
    };
  });

  app.delete('/voice/agents/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM voice_agents WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Voice agent not found');
    db_.run('DELETE FROM voice_agents WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'voice.agent_deleted', subject: row.name, ip: request.ip });
    return { ok: true };
  });

  /* ----------------------------------------------------------- workflows -- */
  /** The recipes both the workflow and voice screens offer instead of a blank form. */
  app.get('/presets', async () => presets());

  app.get('/workflows', async () => {
    const items = db_.all('SELECT * FROM workflows ORDER BY name').map(workflowView);
    return {
      items,
      summary: {
        active: items.filter((item) => item.status === 'active').length,
        runs: items.reduce((total, item) => total + item.runs, 0),
        failing: items.filter((item) => item.lastStatus === 'failed').length,
      },
    };
  });

  app.post('/workflows', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const name = v.str(body.name, { name: 'name', max: 80 });
    if (db_.get('SELECT id FROM workflows WHERE name = ?', [name])) throw conflict(`A workflow named ${name} already exists`);
    const steps = normalizeSteps(body.steps);
    if (!steps.length) throw badRequest('A workflow needs at least one step');
    const id = newId('wfl_');
    db_.run(
      `INSERT INTO workflows (id, name, trigger, status, steps) VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        name,
        v.oneOf(body.trigger || 'inbound', ['inbound', 'outbound', 'schedule', 'webhook', 'manual'], 'trigger'),
        v.oneOf(body.status || 'draft', ['draft', 'active', 'paused'], 'status'),
        JSON.stringify(steps),
      ]
    );
    logEvent({ actor: request.account.email, action: 'workflow.created', subject: name, ip: request.ip });
    reply.status(201);
    return { workflow: workflowView(db_.get('SELECT * FROM workflows WHERE id = ?', [id])) };
  });

  app.patch('/workflows/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM workflows WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Workflow not found');
    const body = request.body || {};
    const cast = {
      name: (value) => v.str(value, { name: 'name', max: 80 }),
      trigger: (value) => v.oneOf(value, ['inbound', 'outbound', 'schedule', 'webhook', 'manual'], 'trigger'),
      status: (value) => v.oneOf(value, ['draft', 'active', 'paused'], 'status'),
      steps: (value) => {
        const steps = normalizeSteps(value);
        if (!steps.length) throw badRequest('A workflow needs at least one step');
        return JSON.stringify(steps);
      },
    };
    const fresh = patchRow(
      'workflows',
      row,
      body,
      { name: 'name', trigger: 'trigger', status: 'status', steps: 'steps' },
      { actor: request.account.email, action: 'workflow.updated', subject: row.name, ip: request.ip, cast }
    );
    return { workflow: workflowView(fresh) };
  });

  app.post('/workflows/:id/run', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM workflows WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Workflow not found');
    if (row.status !== 'active') throw conflict('Activate the workflow before running it');
    const steps = parseSteps(row.steps);
    if (!steps.length) throw conflict('This workflow has no steps to run');
    // Every step is validated against a known action vocabulary; unknown types
    // are a configuration error rather than a silent success.
    const known = new Set(['dial', 'transfer', 'voicemail', 'sms', 'email', 'webhook', 'tag', 'wait']);
    const unknown = steps.filter((step) => !known.has(step.type));
    const ok = unknown.length === 0;
    db_.run(
      `UPDATE workflows
          SET runs = runs + 1,
              success_count = success_count + ?,
              failure_count = failure_count + ?,
              last_run_at = ?,
              last_status = ?
        WHERE id = ?`,
      [ok ? 1 : 0, ok ? 0 : 1, now(), ok ? 'success' : 'failed', row.id]
    );
    logEvent({
      actor: request.account.email,
      action: 'workflow.run',
      subject: row.name,
      detail: ok ? `${steps.length} steps` : `unknown step: ${unknown.map((s) => s.type).join(', ')}`,
      ip: request.ip,
    });
    return { workflow: workflowView(db_.get('SELECT * FROM workflows WHERE id = ?', [row.id])), ok };
  });

  app.delete('/workflows/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM workflows WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Workflow not found');
    db_.run('DELETE FROM workflows WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'workflow.deleted', subject: row.name, ip: request.ip });
    return { ok: true };
  });

  /* ---------------------------------------------------------- voicemails -- */
  app.get('/voicemails', async (request) => {
    const where = [];
    const params = [];
    if (v.bool(request.query?.unread, false)) where.push('listened = 0');
    if (request.query?.extension) {
      where.push('extension = ?');
      params.push(v.str(request.query.extension, { name: 'extension', max: 6 }));
    }
    // A voicemail on a SCIF line is masked where the line asked for it: the
    // caller's number and any identifiers in the transcript are redacted before
    // the response leaves the platform.
    const maskedLines = maskedExtensions(db_);
    const items = db_
      .all(
        `SELECT * FROM voicemails ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC LIMIT 100`,
        params
      )
      .map((row) => {
        const view = voicemailView(row);
        if (!maskedLines.has(String(row.extension))) return view;
        return {
          ...view,
          from: maskPhone(view.from),
          fromE164: view.fromE164 ? maskPhone(view.fromE164) : '',
          transcript: maskText(view.transcript),
          masked: true,
        };
      });
    return {
      items,
      summary: {
        total: count('SELECT COUNT(*) AS n FROM voicemails'),
        unread: count('SELECT COUNT(*) AS n FROM voicemails WHERE listened = 0'),
        urgent: count('SELECT COUNT(*) AS n FROM voicemails WHERE urgent = 1 AND listened = 0'),
        minutes: Math.round((db_.get('SELECT COALESCE(SUM(duration), 0) AS n FROM voicemails')?.n || 0) / 60),
      },
    };
  });

  app.patch('/voicemails/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM voicemails WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Voicemail not found');
    const body = request.body || {};
    const cast = { listened: (value) => (v.bool(value) ? 1 : 0), urgent: (value) => (v.bool(value) ? 1 : 0) };
    const fresh = patchRow(
      'voicemails',
      row,
      body,
      { listened: 'listened', urgent: 'urgent' },
      { actor: request.account.email, action: 'voicemail.updated', subject: row.extension || row.id, ip: request.ip, cast, touch: false }
    );
    return { voicemail: voicemailView(fresh) };
  });

  app.delete('/voicemails/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM voicemails WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Voicemail not found');
    db_.run('DELETE FROM voicemails WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'voicemail.deleted', subject: row.extension || row.id, ip: request.ip });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- faxes -- */
  app.get('/faxes', async (request) => {
    const where = [];
    const params = [];
    const direction = v.str(request.query?.direction, { name: 'direction', max: 10, required: false });
    if (direction) {
      where.push('direction = ?');
      params.push(v.oneOf(direction, ['inbound', 'outbound'], 'direction'));
    }
    const items = db_
      .all(
        `SELECT * FROM faxes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT 100`,
        params
      )
      .map(faxView);
    return {
      items,
      summary: {
        inbound: count("SELECT COUNT(*) AS n FROM faxes WHERE direction = 'inbound'"),
        outbound: count("SELECT COUNT(*) AS n FROM faxes WHERE direction = 'outbound'"),
        queued: count("SELECT COUNT(*) AS n FROM faxes WHERE status IN ('queued','sending')"),
        failed: count("SELECT COUNT(*) AS n FROM faxes WHERE status = 'failed'"),
      },
    };
  });

  app.post('/faxes', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const to = resolveNumber(v.str(body.to, { name: 'to', max: 40 }), { source: 'platform' });
    const id = newId('fax_');
    db_.run(
      `INSERT INTO faxes (id, direction, number_id, from_e164, to_e164, pages, status, subject, body, document)
       VALUES (?, 'outbound', ?, '', ?, ?, 'queued', ?, ?, ?)`,
      [
        id,
        to.id,
        to.e164,
        v.integer(body.pages, { name: 'pages', min: 1, max: 500, required: false, fallback: 1 }),
        v.str(body.subject, { name: 'subject', max: 120, required: false }),
        v.str(body.body, { name: 'body', max: 4000, required: false }),
        v.str(body.document, { name: 'document', max: 120, required: false }),
      ]
    );
    logEvent({ actor: request.account.email, action: 'fax.queued', subject: to.e164, ip: request.ip });
    reply.status(201);
    return { fax: faxView(db_.get('SELECT * FROM faxes WHERE id = ?', [id])) };
  });

  app.patch('/faxes/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM faxes WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Fax not found');
    const body = request.body || {};
    const cast = { status: (value) => v.oneOf(value, ['queued', 'sending', 'sent', 'received', 'failed'], 'status') };
    const fresh = patchRow(
      'faxes',
      row,
      body,
      { status: 'status' },
      { actor: request.account.email, action: 'fax.status', subject: row.id, ip: request.ip, cast, touch: false }
    );
    return { fax: faxView(fresh) };
  });

  /**
   * Transmit a queued fax. The switch is the fax machine: this hands the
   * document to res_fax over the SIP trunk, so there is no carrier fax API and
   * no per-page charge. A failure comes back with the reason attached.
   */
  app.post('/faxes/:id/send', { preHandler: requireWrite }, async (request, reply) => {
    const result = await sendFax(request.params.id, request.account.email);
    if (!result.ok) {
      reply.status(result.statusCode || 400);
      return { error: { code: 'fax_not_sent', message: result.error } };
    }
    return { fax: faxView(result.fax) };
  });

  /** What the fax engine can actually do on this install. */
  app.get('/fax/engine', async () => ({ engine: await faxStatus() }));

  /* ------------------------------------------------------------- messages -- */
  app.get('/messages', async (request) => {
    const where = [];
    const params = [];
    const channel = v.str(request.query?.channel, { name: 'channel', max: 10, required: false });
    if (channel) {
      where.push('channel = ?');
      params.push(v.oneOf(channel, ['sms', 'mms', 'web'], 'channel'));
    }
    // Messages on a SCIF line: the addresses and any numbers or emails in the
    // body are redacted for as long as the line asks for masking.
    const maskedNumbers = maskedNumberIds(db_);
    const items = db_
      .all(
        `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sent_at DESC LIMIT 100`,
        params
      )
      .map((row) => {
        const view = messageView(row);
        if (!row.number_id || !maskedNumbers.has(row.number_id)) return view;
        return {
          ...view,
          from: maskPhone(view.from),
          to: maskPhone(view.to),
          body: maskText(view.body),
          masked: true,
        };
      });
    return {
      items,
      summary: {
        sent: count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound'"),
        received: count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound'"),
        failed: count("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'"),
        provider: activeChannel('sms').name,
      },
    };
  });

  app.post('/messages', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const channel = v.oneOf(body.channel || 'sms', ['sms', 'mms', 'web'], 'channel');
    const to = resolveNumber(v.str(body.to, { name: 'to', max: 40 }), { source: 'platform' });
    // Text messages are an SMS-shaped channel, so they report the SMS provider;
    // the mail provider is not what would carry them.
    const provider = activeChannel(channel === 'sms' || channel === 'mms' ? 'sms' : 'email');
    const id = newId('msg_');
    db_.run(
      `INSERT INTO messages (id, channel, direction, number_id, from_e164, to_e164, body, status)
       VALUES (?, ?, 'outbound', ?, '', ?, ?, ?)`,
      [
        id,
        channel,
        to.id,
        to.e164,
        v.str(body.body, { name: 'body', min: 1, max: 1600 }),
        // Nothing is claimed as delivered: an SMS only leaves the queue when a
        // provider is configured for it.
        channel === 'web' ? 'sent' : 'queued',
      ]
    );
    logEvent({
      actor: request.account.email,
      action: 'message.queued',
      subject: to.e164,
      detail: `${channel} via ${provider.name}`,
      ip: request.ip,
    });
    reply.status(201);
    return { message: messageView(db_.get('SELECT * FROM messages WHERE id = ?', [id])), provider: provider.name };
  });

  app.patch('/messages/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM messages WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Message not found');
    const body = request.body || {};
    const cast = { status: (value) => v.oneOf(value, ['queued', 'sent', 'delivered', 'failed', 'received'], 'status') };
    const fresh = patchRow(
      'messages',
      row,
      body,
      { status: 'status' },
      { actor: request.account.email, action: 'message.status', subject: row.id, ip: request.ip, cast, touch: false }
    );
    return { message: messageView(fresh) };
  });

  /* -------------------------------------------------------------- billing -- */
  app.get('/billing/invoices', async (request) => {
    const where = [];
    const params = [];
    const status = v.str(request.query?.status, { name: 'status', max: 10, required: false });
    if (status) {
      where.push('status = ?');
      params.push(v.oneOf(status, ['draft', 'open', 'paid', 'overdue', 'void'], 'status'));
    }
    const items = db_
      .all(
        `${INVOICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(i.due_at, i.created_at) DESC LIMIT 200`,
        params
      )
      .map(invoiceView);
    // Totals are grouped by currency: adding GBP to USD would be a false number.
    const byCurrency = db_
      .all(
        `SELECT currency,
                COALESCE(SUM(CASE WHEN status IN ('open','overdue') THEN amount_cents ELSE 0 END), 0) AS open_cents,
                COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount_cents ELSE 0 END), 0) AS overdue_cents,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS paid_cents,
                SUM(CASE WHEN status IN ('open','overdue') THEN 1 ELSE 0 END) AS open_count
           FROM invoices GROUP BY currency ORDER BY open_cents DESC`
      )
      .map((row) => ({
        currency: row.currency,
        openCents: row.open_cents,
        overdueCents: row.overdue_cents,
        paidCents: row.paid_cents,
        openCount: row.open_count,
      }));
    return {
      items,
      summary: {
        byCurrency,
        currencies: byCurrency.length,
        openCount: db_.get("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('open','overdue')")?.n || 0,
        overdueCount: db_.get("SELECT COUNT(*) AS n FROM invoices WHERE status = 'overdue'")?.n || 0,
        paidCount: db_.get("SELECT COUNT(*) AS n FROM invoices WHERE status = 'paid'")?.n || 0,
        // What the automation is doing, so the screen can say it without guessing.
        reminders: {
          enabled: config.billing.reminders,
          scheduleDays: ladder(),
          gapHours: config.billing.reminderGapHours,
          sweepMinutes: config.billing.reminderSweepMinutes,
          sent: db_.get("SELECT COUNT(*) AS n FROM invoice_reminders WHERE status = 'sent'")?.n || 0,
          failed: db_.get("SELECT COUNT(*) AS n FROM invoice_reminders WHERE status = 'failed'")?.n || 0,
          paused: db_.get("SELECT COUNT(*) AS n FROM invoices WHERE reminders_paused = 1 AND status IN ('open','overdue')")?.n || 0,
          lastSentAt: db_.get("SELECT MAX(sent_at) AS at FROM invoice_reminders WHERE status = 'sent'")?.at || null,
          finalNotices: count("SELECT COUNT(*) AS n FROM invoice_reminders WHERE kind = 'final' AND status = 'sent'"),
        },
        // Whether the pay button in those emails can work at all.
        payments: paymentStatus(),
        // What happens after the ladder, in the same words the emails use.
        escalation: {
          ...escalationPolicy(),
          scheduled: count("SELECT COUNT(*) AS n FROM billing_accounts WHERE state = 'final-notice'"),
          suspended: count("SELECT COUNT(*) AS n FROM billing_accounts WHERE state = 'suspended'"),
          nextSuspension: db_.get(
            "SELECT MIN(suspend_on) AS at FROM billing_accounts WHERE state = 'final-notice' AND suspend_on IS NOT NULL AND suspend_on <> ''"
          )?.at || null,
          suspendedAccounts: listBillingAccounts({ state: 'suspended' }),
        },
      },
    };
  });

  /**
   * Create a bill.
   *
   * Three shapes, in order of preference: line items (the total is their sum),
   * the month's rent pulled from the ledger, or one amount typed by an operator.
   * Naming the account links the invoice to a customer, which is what lets its
   * own portal find the bill and its rent attach to the right person.
   */
  app.post('/billing/invoices', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const accountEmail = v.str(body.account, { name: 'account', max: 160, required: false });
    const account = accountEmail
      ? db_.get('SELECT * FROM accounts WHERE lower(email) = ?', [String(accountEmail).toLowerCase()])
      : null;
    if (accountEmail && !account) throw badRequest('No account has that email');
    const accountName = v.str(body.accountName || account?.company || account?.name, {
      name: 'accountName',
      max: 120,
    });
    const periodStart = isoDate(body.periodStart, 'periodStart', { required: true });
    const periodEnd = isoDate(body.periodEnd, 'periodEnd', { required: true });
    if (new Date(periodEnd) < new Date(periodStart)) throw badRequest('periodEnd cannot precede periodStart');
    const status = v.oneOf(body.status || 'open', ['draft', 'open', 'paid', 'overdue', 'void'], 'status');
    const dueAt = isoDate(body.dueAt, 'dueAt') || new Date(Date.now() + 14 * 86400_000).toISOString();
    const incoming = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    const wantsRent = body.includeRent === undefined ? !!body.rentPeriod : v.bool(body.includeRent, false);
    const rentPeriod = wantsRent ? String(body.rentPeriod || monthPeriod()).slice(0, 7) : '';
    if (rentPeriod && !monthBounds(rentPeriod)) throw badRequest('rentPeriod must be a YYYY-MM month');
    const amountCents =
      body.amountCents === undefined && (incoming.length || rentPeriod)
        ? 0
        : v.integer(body.amountCents, { name: 'amountCents', min: 0, max: 100_000_000_00, required: true });

    const id = newId('inv_');
    const invoiceNo = nextInvoiceNumber();
    try {
      db_.run(
        `INSERT INTO invoices (id, invoice_no, account_name, email, account_id, rent_period, period_start, period_end,
                               amount_cents, currency, status, issued_at, due_at, paid_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          invoiceNo,
          accountName,
          v.str(body.email ?? account?.email, { name: 'email', max: 160, required: false }),
          account?.id || null,
          rentPeriod,
          periodStart,
          periodEnd,
          amountCents,
          v.str(body.currency, { name: 'currency', max: 3, required: false, fallback: 'USD' }).toUpperCase(),
          status,
          status === 'draft' ? null : now(),
          dueAt,
          status === 'paid' ? now() : null,
          v.str(body.notes, { name: 'notes', max: 500, required: false }),
        ]
      );
    } catch (err) {
      // One invoice per account per month is the invariant; a second attempt is
      // a corrected bill for the same month, so say so instead of a 500.
      if (/UNIQUE/i.test(String(err.message))) {
        throw conflict(`That account already has an invoice for ${monthLabel(rentPeriod)}`);
      }
      throw err;
    }

    for (const item of incoming) addItem(id, item);
    let rent = null;
    let plan = null;
    if (rentPeriod) {
      // A monthly bill carries the plan as well as the rent, so the invoice
      // created here says the same thing the automatic run would.
      const invoice = db_.get('SELECT * FROM invoices WHERE id = ?', [id]);
      plan = billPlanOnto(invoice, rentPeriod);
      rent = billRentOnto(db_.get('SELECT * FROM invoices WHERE id = ?', [id]), rentPeriod);
    }

    logEvent({ actor: request.account.email, action: 'billing.invoice_created', subject: invoiceNo, ip: request.ip });
    reply.status(201);
    return { invoice: invoiceDetail(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [id])), rent, plan };
  });

  /** One invoice with everything that makes up its total. */
  app.get('/billing/invoices/:id', async (request) => {
    const row = db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    return { invoice: invoiceDetail(row) };
  });

  /**
   * Put the month's number rent on an invoice that already exists.
   *
   * The charges move from pending to invoiced in the same pass, so pressing this
   * twice bills a month once: the second press has nothing left to pull.
   */
  app.post('/billing/invoices/:id/rent', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM invoices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    if (row.status === 'void') throw conflict('A void invoice cannot take new charges');
    if (row.status === 'paid') throw conflict('This invoice is already settled');
    if (!row.account_id) {
      throw badRequest('This invoice is not linked to an account, so it holds no number rent');
    }
    const period = String(request.body?.period || row.rent_period || monthPeriod()).slice(0, 7);
    if (!monthBounds(period)) throw badRequest('period must be a YYYY-MM month');
    const billed = billRentOnto(row, period);
    logEvent({
      actor: request.account.email,
      action: 'billing.rent_billed',
      subject: row.invoice_no,
      detail: `${period}: ${billed.added} line(s)`,
      ip: request.ip,
    });
    return { invoice: invoiceDetail(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [row.id])), billed };
  });

  app.post('/billing/invoices/:id/items', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM invoices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    if (row.status === 'void') throw conflict('A void invoice cannot take new lines');
    const item = addItem(row.id, request.body || {});
    logEvent({
      actor: request.account.email,
      action: 'billing.item_added',
      subject: row.invoice_no,
      detail: item.description,
      ip: request.ip,
    });
    return { item, invoice: invoiceDetail(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [row.id])) };
  });

  app.patch('/billing/invoice-items/:id', { preHandler: requireWrite }, async (request) => {
    const item = updateItem(request.params.id, request.body || {});
    logEvent({
      actor: request.account.email,
      action: 'billing.item_updated',
      subject: item.id,
      detail: item.description,
      ip: request.ip,
    });
    return { item, invoice: invoiceDetail(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [item.invoiceId])) };
  });

  app.delete('/billing/invoice-items/:id', { preHandler: requireWrite }, async (request) => {
    const result = removeItem(request.params.id);
    logEvent({
      actor: request.account.email,
      action: 'billing.item_removed',
      subject: result.id,
      ip: request.ip,
    });
    return { ok: true, invoice: invoiceDetail(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [result.invoiceId])) };
  });

  /** Rent recorded for a month but not yet on any bill. */
  app.get('/billing/rent', async (request) => {
    const period = String(request.query?.period || monthPeriod()).slice(0, 7);
    if (!monthBounds(period)) throw badRequest('period must be a YYYY-MM month');
    return {
      period,
      label: monthLabel(period),
      enabled: config.billing.rentInvoicing,
      uninvoiced: uninvoicedRent({ period }),
      invoices: db_
        .all('SELECT * FROM invoices WHERE rent_period = ? ORDER BY created_at DESC', [period])
        .map(invoiceView),
    };
  });

  /** Bill every subscriber and every account that owes rent for a month, now. */
  app.post('/billing/rent/run', { preHandler: requireWrite }, async (request) => {
    const period = String(request.body?.period || monthPeriod()).slice(0, 7);
    if (!monthBounds(period)) throw badRequest('period must be a YYYY-MM month');
    const accountEmail = v.str(request.body?.account, { name: 'account', max: 160, required: false });
    const account = accountEmail
      ? db_.get('SELECT * FROM accounts WHERE lower(email) = ?', [String(accountEmail).toLowerCase()])
      : null;
    if (accountEmail && !account) throw badRequest('No account has that email');
    const result = runMonthlyInvoicing({ period, accountId: account?.id || null });
    logEvent({
      actor: request.account.email,
      action: 'billing.rent_run',
      subject: period,
      detail: `${result.planLines} plan + ${result.billedLines} rent line(s) across ${result.invoices.length} invoice(s)`,
      ip: request.ip,
    });
    return { ...result, label: monthLabel(period), uninvoiced: uninvoicedRent({ period }) };
  });

  app.patch('/billing/invoices/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    const body = request.body || {};
    const patch = {};
    if (body.status !== undefined) {
      patch.status = v.oneOf(body.status, ['draft', 'open', 'paid', 'overdue', 'void'], 'status');
      // Payment is a timestamp fact, not just a label: transitioning sets it,
      // reopening clears it so an invoice cannot claim it was paid twice.
      patch.paid_at = patch.status === 'paid' ? row.paid_at || now() : null;
    }
    // A bill built from lines owns its total: typing one by hand would make the
    // invoice disagree with the items printed underneath it.
    if (body.amountCents !== undefined) {
      if (itemsFor(row.id).length) {
        throw badRequest('This invoice is built from line items — edit the items instead of the total');
      }
      patch.amount_cents = v.integer(body.amountCents, { name: 'amountCents', min: 0, max: 100_000_000_00 });
    }
    if (body.dueAt !== undefined) patch.due_at = isoDate(body.dueAt, 'dueAt', { required: true });
    if (body.notes !== undefined) patch.notes = v.str(body.notes, { name: 'notes', max: 500, required: false });
    if (body.email !== undefined) patch.email = v.str(body.email, { name: 'email', max: 160, required: false });
    if (body.accountName !== undefined) patch.account_name = v.str(body.accountName, { name: 'accountName', max: 120 });
    if (body.currency !== undefined) patch.currency = v.str(body.currency, { name: 'currency', max: 3 }).toUpperCase();
    if (body.remindersPaused !== undefined) patch.reminders_paused = v.bool(body.remindersPaused, false) ? 1 : 0;
    if (body.periodStart !== undefined) patch.period_start = isoDate(body.periodStart, 'periodStart', { required: true });
    if (body.periodEnd !== undefined) patch.period_end = isoDate(body.periodEnd, 'periodEnd', { required: true });
    if (patch.period_start && patch.period_end && new Date(patch.period_end) < new Date(patch.period_start)) {
      throw badRequest('periodEnd cannot precede periodStart');
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const sets = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
    db_.run(`UPDATE invoices SET ${sets} WHERE id = ?`, [...Object.values(patch), row.id]);
    // A void bill hands its month back to the ledger, so a corrected invoice can
    // carry it rather than the customer paying for a month twice.
    if (patch.status === 'void') releaseRentFromInvoice(row.id);
    logEvent({ actor: request.account.email, action: 'billing.invoice_updated', subject: row.invoice_no, ip: request.ip });
    return { invoice: invoiceDetail(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [row.id])) };
  });

  app.post('/billing/invoices/:id/resend', { preHandler: requireWrite }, async (request) => {
    const row = db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    if (!row.email) throw badRequest('Add a billing email to this invoice before resending it');
    if (row.status === 'void') throw conflict('A void invoice cannot be resent');
    // One template, both parts: the HTML a customer reads and the text a
    // provider or a log falls back to describe the same invoice.
    const message = invoiceEmail({ ...row, items: itemsFor(row.id) });
    const result = await deliverNotice({ to: row.email, ...message });
    // The provider is recorded whether or not it worked: a failed attempt names
    // who was asked, which is the part that makes an outage traceable.
    db_.run(
      `UPDATE invoices
          SET last_provider = ?, last_send_error = ?,
              last_sent_at = CASE WHEN ? = 1 THEN ? ELSE last_sent_at END
        WHERE id = ?`,
      [
        result.channel || '',
        result.delivered ? '' : String(result.error || 'unknown').slice(0, 300),
        result.delivered ? 1 : 0,
        now(),
        row.id,
      ]
    );
    logEvent({
      actor: request.account.email,
      action: 'billing.invoice_resent',
      subject: row.invoice_no,
      detail: `${row.email} via ${result.channel}: ${result.delivered ? 'sent' : result.error}`,
      ip: request.ip,
    });
    return {
      sent: result.delivered,
      channel: result.channel,
      simulated: !!result.simulated,
      error: result.error || null,
      invoice: invoiceView(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [row.id])),
    };
  });

  /* ------------------------------------------------------------ reminders -- */

  app.get('/billing/invoices/:id/reminders', async (request) => {
    const row = db_.get('SELECT * FROM invoices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    return {
      invoiceId: row.id,
      invoiceNo: row.invoice_no,
      paused: !!row.reminders_paused,
      items: reminderHistory(row.id),
      schedule: {
        enabled: config.billing.reminders,
        days: ladder(),
        gapHours: config.billing.reminderGapHours,
      },
    };
  });

  app.post('/billing/invoices/:id/reminder', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM invoices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Invoice not found');
    if (!row.email) throw badRequest('Add a billing email to this invoice before sending a reminder');
    if (row.status === 'paid') throw conflict('This invoice is paid — there is nothing to remind about');
    if (row.status === 'void') throw conflict('A void invoice cannot be reminded');
    if (!row.due_at) throw badRequest('Set a due date before sending a reminder');

    const result = await sendReminderNow(row.id, { actor: request.account.email });
    logEvent({
      actor: request.account.email,
      action: 'billing.reminder_manual',
      subject: row.invoice_no,
      detail: `${row.email}: ${result.action}${result.error ? ` (${result.error})` : ''}`,
      ip: request.ip,
    });
    return {
      ...result,
      invoice: invoiceView(db_.get(`${INVOICE_SELECT} WHERE i.id = ?`, [row.id])),
      items: reminderHistory(row.id),
    };
  });

  // The sweep is normally a timer; this is the operator's "run it now", for a
  // batch that arrived late or a provider that was down overnight.
  app.post('/billing/reminders/run', { preHandler: requireWrite }, async (request) => {
    const result = await runReminderSweep({ actor: request.account.email });
    logEvent({
      actor: request.account.email,
      action: 'billing.reminder_sweep',
      detail: `${result.checked} checked, ${result.sent} sent, ${result.failed} failed, ${result.markedOverdue} newly overdue`,
      ip: request.ip,
    });
    return result;
  });

  // Proves the stored Stripe credentials against Stripe itself. The screen
  // shows the same checks the notice button depends on, so a dead key or a
  // webhook pointing at an old host is found here instead of by a customer who
  // paid an invoice that never cleared.
  app.post('/billing/payments/test', { preHandler: requireWrite }, async (request) => {
    const result = await testConnection();
    logEvent({
      actor: request.account.email,
      action: 'billing.payments_tested',
      detail: result.ok
        ? `ok · ${result.mode} mode`
        : result.checks
            .filter((entry) => entry.state === 'fail')
            .map((entry) => entry.id)
            .join(', '),
      ip: request.ip,
    });
    return result;
  });

  // The endpoint's event list without the price of the full test. The Billing
  // screen reads this on load so a missing event is visible on the page, not
  // only behind a button that also probes Checkout. One Stripe read, no
  // session created, nothing charged.
  app.get('/billing/payments/webhook', async () => ({ webhook: await webhookEventStatus() }));

  // The gap the test reports, closed: an endpoint in Stripe that is missing an
  // event this platform needs gets it, and keeps every event it had. Safe to
  // press twice — the second press finds nothing missing.
  app.post('/billing/payments/webhook/repair', { preHandler: requireWrite }, async (request) => {
    const result = await repairWebhookEndpoint({ actor: request.account.email });
    if (!result.ok) {
      const reasons = {
        stripe_not_configured: 'Add the Stripe secret key in Settings → Vault first.',
        not_registered: `No endpoint points at ${webhookUrl()}. Add it in Stripe → Developers → Webhooks, then run this again.`,
      };
      throw badRequest(reasons[result.error] || `Stripe could not be updated: ${result.error}`);
    }
    logEvent({
      actor: request.account.email,
      action: 'billing.webhook_repair',
      detail: result.changed
        ? `added ${result.added.join(', ')} · ${result.endpointId}`
        : `nothing to do (${result.reason})`,
      ip: request.ip,
    });
    return result;
  });

  /* ---------------------------------------------------------- escalation -- */

  // Dunning state per billing account, with the balance recomputed on read so a
  // paid invoice cannot leave a stale number on the screen.
  app.get('/billing/accounts', async (request) => {
    const state = v.str(request.query?.state, { name: 'state', max: 20, required: false });
    const items = listBillingAccounts({
      state: state ? v.oneOf(state, ['current', 'final-notice', 'suspended'], 'state') : '',
    });
    const scheduled = items.filter((row) => row.state === 'final-notice');
    return {
      items,
      summary: {
        ...escalationPolicy(),
        watched: items.length,
        scheduled: scheduled.length,
        suspended: items.filter((row) => row.state === 'suspended').length,
        nextSuspension: scheduled.map((row) => row.suspendOn).filter(Boolean).sort()[0] || null,
        owedCents: items.reduce((total, row) => (row.currency === 'USD' ? total + row.overdueCents : total), 0),
      },
    };
  });

  app.get('/billing/accounts/:id', async (request) => {
    const row = db_.get('SELECT email FROM billing_accounts WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Billing account not found');
    const account = billingAccount(row.email);
    return {
      account,
      invoices: db_
        .all(
          `${INVOICE_SELECT} WHERE lower(i.email) = ? ORDER BY date(i.due_at) ASC LIMIT 50`,
          [row.email]
        )
        .map(invoiceView),
    };
  });

  // The operator's escape hatch. Paying reinstates automatically; this is for
  // the case a person decides the suspension was wrong, and it is audited.
  app.post('/billing/accounts/:id/reinstate', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT email FROM billing_accounts WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Billing account not found');
    const force = v.bool(request.body?.force, false);
    const result = await reinstateAccount(row.email, {
      actor: request.account.email,
      reason: force ? 'operator override' : 'paid',
    });
    if (result.action !== 'reinstated') {
      throw conflict(
        'This account still owes money. Settle or void the open invoices, or reinstate it as an override.',
        { overdueCents: result.overdueCents ?? 0, currency: result.currency || 'USD' }
      );
    }
    logEvent({
      actor: request.account.email,
      action: 'billing.account_reinstated_manual',
      subject: row.email,
      detail: `${result.extensionsRestored} extension(s) back on${force ? ', override' : ''}`,
      ip: request.ip,
    });
    return result;
  });

  /* --------------------------------------------------------------- estate -- */
  app.get('/estate/sites', async () => {
    const items = db_.all(`${SITE_SELECT} ORDER BY s.name`).map(siteView);
    return {
      items,
      summary: {
        sites: items.length,
        devices: items.reduce((total, site) => total + site.deviceCount, 0),
        online: items.reduce((total, site) => total + site.onlineCount, 0),
        // Estate-wide, so a filtered device list cannot change the tiles above it.
        problemDevices: count("SELECT COUNT(*) AS n FROM devices WHERE status IN ('offline', 'faulty')"),
        silentDevices: db_
          .all("SELECT status, last_seen_at FROM devices WHERE status = 'online'")
          .filter((device) => isSilent(device, config.devices.staleAfterSec)).length,
        degraded: items.filter((site) => site.status === 'degraded').length,
        offline: items.filter((site) => site.status === 'offline').length,
      },
    };
  });

  app.post('/estate/sites', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const name = v.str(body.name, { name: 'name', max: 80 });
    if (db_.get('SELECT id FROM sites WHERE name = ?', [name])) throw conflict(`A site named ${name} already exists`);
    const id = newId('ste_');
    db_.run(
      `INSERT INTO sites (id, name, address, city, country, timezone, status, latency_ms, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        v.str(body.address, { name: 'address', max: 160, required: false }),
        v.str(body.city, { name: 'city', max: 80, required: false }),
        v.str(body.country, { name: 'country', max: 2, required: false }).toUpperCase(),
        v.str(body.timezone, { name: 'timezone', max: 40, required: false }),
        v.oneOf(body.status || 'active', ['active', 'degraded', 'offline', 'planned'], 'status'),
        v.integer(body.latencyMs, { name: 'latencyMs', min: 0, max: 60000, required: false, fallback: 0 }),
        now(),
      ]
    );
    logEvent({ actor: request.account.email, action: 'estate.site_created', subject: name, ip: request.ip });
    reply.status(201);
    return { site: siteById(id) };
  });

  app.patch('/estate/sites/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM sites WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Site not found');
    const body = request.body || {};
    const cast = {
      name: (value) => v.str(value, { name: 'name', max: 80 }),
      address: (value) => v.str(value, { name: 'address', max: 160, required: false }),
      city: (value) => v.str(value, { name: 'city', max: 80, required: false }),
      country: (value) => v.str(value, { name: 'country', max: 2, required: false }).toUpperCase(),
      timezone: (value) => v.str(value, { name: 'timezone', max: 40, required: false }),
      status: (value) => v.oneOf(value, ['active', 'degraded', 'offline', 'planned'], 'status'),
      latencyMs: (value) => v.integer(value, { name: 'latencyMs', min: 0, max: 60000 }),
    };
    patchRow(
      'sites',
      row,
      body,
      { name: 'name', address: 'address', city: 'city', country: 'country', timezone: 'timezone', status: 'status', latencyMs: 'latency_ms' },
      { actor: request.account.email, action: 'estate.site_updated', subject: row.name, ip: request.ip, cast }
    );
    return { site: siteById(row.id) };
  });

  app.delete('/estate/sites/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM sites WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Site not found');
    // Devices belong to the site: deleting it retires its equipment with it.
    db_.run('DELETE FROM sites WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'estate.site_deleted', subject: row.name, ip: request.ip });
    return { ok: true };
  });

  /* -------------------------------------------------------------- devices -- */
  app.get('/estate/devices', async (request) => {
    const where = [];
    const params = [];
    if (request.query?.site) {
      where.push('d.site_id = ?');
      params.push(linkSite(request.query.site));
    }
    if (request.query?.kind) {
      where.push('d.kind = ?');
      params.push(v.oneOf(request.query.kind, DEVICE_KINDS, 'kind'));
    }
    if (request.query?.status) {
      where.push('d.status = ?');
      params.push(v.oneOf(request.query.status, DEVICE_STATES, 'status'));
    }
    const items = db_
      .all(
        `${DEVICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY s.name, d.name`,
        params
      )
      .map(deviceView);
    return {
      items,
      summary: {
        total: items.length,
        online: items.filter((device) => device.status === 'online').length,
        offline: items.filter((device) => device.status === 'offline').length,
        provisioning: items.filter((device) => device.status === 'provisioning').length,
        faulty: items.filter((device) => device.status === 'faulty').length,
        silent: items.filter((device) => device.silent).length,
        kinds: DEVICE_KINDS.map((kind) => ({ kind, count: items.filter((device) => device.kind === kind).length })),
        checkInSec: config.devices.checkInSec,
        staleAfterSec: config.devices.staleAfterSec,
      },
    };
  });

  app.post('/estate/devices', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const mac = normalizeMac(body.mac);
    if (mac && db_.get('SELECT id FROM devices WHERE mac = ?', [mac])) {
      throw conflict(`A device with MAC ${mac} is already provisioned`);
    }
    const id = newId('dev_');
    // The check-in credential is minted with the row: it is the device's own
    // identity, so it is returned exactly once and only its hash is kept.
    const token = newDeviceToken();
    db_.run(
      `INSERT INTO devices (id, site_id, extension_id, name, kind, model, mac, ip, firmware, status, token_hash, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        linkSite(body.siteId ?? body.site),
        linkExtension(body.extension ?? body.extensionId),
        v.str(body.name, { name: 'name', max: 80 }),
        v.oneOf(body.kind || 'handset', DEVICE_KINDS, 'kind'),
        v.str(body.model, { name: 'model', max: 80, required: false }),
        mac,
        normalizeIp(body.ip),
        v.str(body.firmware, { name: 'firmware', max: 40, required: false }),
        v.oneOf(body.status || 'provisioning', DEVICE_STATES, 'status'),
        token.hash,
        body.lastSeenAt || now(),
      ]
    );
    logEvent({
      actor: request.account.email,
      action: 'estate.device_created',
      subject: String(body.name).slice(0, 80),
      detail: `${body.kind || 'handset'}${mac ? ` ${mac}` : ''}`,
      ip: request.ip,
    });
    reply.status(201);
    return { device: deviceById(id), token: token.secret, checkInSec: config.devices.checkInSec };
  });

  app.post('/estate/devices/:id/token', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM devices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Device not found');
    const token = newDeviceToken();
    db_.run('UPDATE devices SET token_hash = ?, updated_at = ? WHERE id = ?', [token.hash, now(), row.id]);
    logEvent({
      actor: request.account.email,
      action: 'estate.device_token_rotated',
      subject: row.name,
      detail: 'previous token can no longer check in',
      ip: request.ip,
    });
    return { device: deviceById(row.id), token: token.secret, checkInSec: config.devices.checkInSec };
  });

  app.patch('/estate/devices/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM devices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Device not found');
    const body = request.body || {};
    const cast = {
      name: (value) => v.str(value, { name: 'name', max: 80 }),
      kind: (value) => v.oneOf(value, DEVICE_KINDS, 'kind'),
      model: (value) => v.str(value, { name: 'model', max: 80, required: false }),
      mac: normalizeMac,
      ip: normalizeIp,
      firmware: (value) => v.str(value, { name: 'firmware', max: 40, required: false }),
      status: (value) => v.oneOf(value, DEVICE_STATES, 'status'),
      siteId: linkSite,
      extension: linkExtension,
    };
    if (body.mac !== undefined) {
      const mac = normalizeMac(body.mac);
      const owner = mac && db_.get('SELECT id FROM devices WHERE mac = ? AND id != ?', [mac, row.id]);
      if (owner) throw conflict(`A device with MAC ${mac} is already provisioned`);
    }
    patchRow(
      'devices',
      row,
      body,
      { name: 'name', kind: 'kind', model: 'model', mac: 'mac', ip: 'ip', firmware: 'firmware', status: 'status', siteId: 'site_id', extension: 'extension_id' },
      { actor: request.account.email, action: 'estate.device_updated', subject: row.name, ip: request.ip, cast }
    );
    // A device that reports itself online has, by definition, just been seen.
    if (body.status === 'online') db_.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', [now(), row.id]);
    return { device: deviceById(row.id) };
  });

  /**
   * Returns a config file the handset can boot from. Generating it rotates the
   * check-in token: the config is the only copy of the new one.
   */
  app.get('/estate/devices/:id/provisioning', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM devices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Device not found');
    const format = v.oneOf(request.query?.format || 'yealink', PROVISION_FORMATS, 'format');
    const extension = row.extension_id
      ? db_.get('SELECT * FROM extensions WHERE id = ?', [row.extension_id])
      : null;
    const token = newDeviceToken();
    db_.run('UPDATE devices SET token_hash = ?, updated_at = ? WHERE id = ?', [token.hash, now(), row.id]);
    const built = buildProvisioning(format, {
      device: { name: row.name, mac: row.mac, label: extension?.extension || row.name },
      extension,
      token: token.secret,
    });
    logEvent({
      actor: request.account.email,
      action: 'estate.device_provisioned',
      subject: row.name,
      detail: `${format} config issued, token rotated`,
      ip: request.ip,
    });
    return {
      deviceId: row.id,
      format,
      fileName: built.fileName,
      contentType: built.contentType,
      config: built.body,
    };
  });

  app.delete('/estate/devices/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM devices WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Device not found');
    db_.run('DELETE FROM devices WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'estate.device_deleted', subject: row.name, ip: request.ip });
    return { ok: true };
  });

  /* --------------------------------------------------------------- health -- */
  const latestChecks = () =>
    db_.all(
      `SELECT h.* FROM health_checks h
         JOIN (SELECT target, MAX(id) AS id FROM health_checks GROUP BY target) last ON last.id = h.id
        ORDER BY h.status != 'up' DESC, h.target`
    );

  const healthSummary = async () => {
    const checks = latestChecks();
    const telephony = await telephonyStatus();
    const channels = channelStatus();
    const dbStart = performance.now();
    db_.get('SELECT 1 AS n');
    const dbLatency = Math.max(1, Math.round(performance.now() - dbStart));
    return {
      status: checks.some((check) => check.status === 'down')
        ? 'down'
        : checks.some((check) => check.status === 'degraded')
          ? 'degraded'
          : 'up',
      counts: {
        up: checks.filter((check) => check.status === 'up').length,
        degraded: checks.filter((check) => check.status === 'degraded').length,
        down: checks.filter((check) => check.status === 'down').length,
      },
      runtime: {
        uptime: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        node: process.version,
        dbLatencyMs: dbLatency,
      },
      telephony,
      channels,
      checks: checks.map((row) => ({
        id: row.id,
        target: row.target,
        kind: row.kind,
        status: row.status,
        latencyMs: row.latency_ms,
        detail: row.detail,
        checkedAt: row.checked_at,
      })),
    };
  };

  app.get('/health/summary', async () => healthSummary());

  app.get('/health/checks', async (request) => ({
    items: db_
      .all('SELECT * FROM health_checks ORDER BY id DESC LIMIT ?', [
        v.integer(request.query?.limit, { name: 'limit', min: 1, max: 500, required: false, fallback: 60 }),
      ])
      .map((row) => ({
        id: row.id,
        target: row.target,
        kind: row.kind,
        status: row.status,
        latencyMs: row.latency_ms,
        detail: row.detail,
        checkedAt: row.checked_at,
      })),
  }));

  /** Runs the probes that this container can actually observe. */
  app.post('/health/checks/run', { preHandler: requireWrite }, async (request) => {
    const started = performance.now();
    db_.get('SELECT 1 AS n');
    const dbLatency = Math.max(1, Math.round(performance.now() - started));

    const switchStart = performance.now();
    const telephony = await telephonyStatus();
    const switchLatency = Math.max(1, Math.round(performance.now() - switchStart));
    const channels = channelStatus();
    const domains = db_.get('SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM domains') || { total: 0, enabled: 0 };

    const probes = [
      {
        target: 'database',
        kind: 'database',
        status: 'up',
        latencyMs: dbLatency,
        detail: 'SQLite read/write, WAL mode',
      },
      {
        target: 'api',
        kind: 'api',
        status: 'up',
        latencyMs: Math.round(performance.now() - started),
        detail: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB rss, up ${Math.round(process.uptime())}s`,
      },
      {
        target: 'switch',
        kind: 'switch',
        status: telephony.connected ? 'up' : telephony.simulated ? 'degraded' : 'down',
        latencyMs: telephony.connected ? switchLatency : 0,
        detail: telephony.simulated
          ? 'Simulated switch — no Cantus node connected'
          : telephony.connected
            ? `Cantus control API connected to ${telephony.host || 'switch'}`
            : telephony.error || 'Cantus switch not connected',
      },
      {
        target: 'delivery',
        kind: 'delivery',
        status: channels.active && channels.active !== 'console' ? 'up' : 'degraded',
        latencyMs: 0,
        detail: `Verification channel: ${channels.active || 'none'} (available: ${channels.available?.join(', ') || 'none'})`,
      },
      {
        target: 'directory hosts',
        kind: 'dns',
        status: domains.total > 0 && domains.enabled === domains.total ? 'up' : domains.total > 0 ? 'degraded' : 'down',
        latencyMs: 0,
        detail: `${domains.enabled}/${domains.total} hosts enabled`,
      },
    ];

    const stamp = now();
    for (const probe of probes) {
      db_.run(
        'INSERT INTO health_checks (target, kind, status, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)',
        [probe.target, probe.kind, probe.status, probe.latencyMs, probe.detail, stamp]
      );
    }
    logEvent({
      actor: request.account.email,
      action: 'health.checks_run',
      subject: `${probes.length} targets`,
      detail: probes.map((probe) => `${probe.target}:${probe.status}`).join(' '),
      ip: request.ip,
    });
    return { ...(await healthSummary()), ranAt: stamp };
  });

  /* ----------------------------------------------------------- operations -- */
  app.get('/operations/tasks', async (request) => {
    const where = [];
    const params = [];
    const status = v.str(request.query?.status, { name: 'status', max: 12, required: false });
    if (status) {
      where.push('t.status = ?');
      params.push(v.oneOf(status, ['open', 'in_progress', 'blocked', 'done'], 'status'));
    }
    const items = db_
      .all(
        `SELECT t.*, s.name AS site_name FROM tasks t
           LEFT JOIN sites s ON s.id = t.site_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                   COALESCE(t.due_at, '9999')`
        ,
        params
      )
      .map(taskView);
    const overdue = db_.get(
      "SELECT COUNT(*) AS n FROM tasks WHERE status != 'done' AND due_at IS NOT NULL AND due_at < ?",
      [now()]
    )?.n || 0;
    return {
      items,
      summary: {
        open: items.filter((task) => task.status === 'open').length,
        inProgress: items.filter((task) => task.status === 'in_progress').length,
        blocked: items.filter((task) => task.status === 'blocked').length,
        done: items.filter((task) => task.status === 'done').length,
        overdue,
      },
    };
  });

  app.post('/operations/tasks', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const id = newId('tsk_');
    const siteId = body.siteId
      ? db_.get('SELECT id FROM sites WHERE id = ? OR name = ?', [String(body.siteId), String(body.siteId)])?.id || null
      : null;
    db_.run(
      `INSERT INTO tasks (id, title, kind, priority, status, assignee, site_id, due_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        v.str(body.title, { name: 'title', min: 3, max: 140 }),
        v.oneOf(body.kind || 'maintenance', ['maintenance', 'incident', 'change', 'provisioning', 'audit'], 'kind'),
        v.oneOf(body.priority || 'normal', ['low', 'normal', 'high', 'critical'], 'priority'),
        v.oneOf(body.status || 'open', ['open', 'in_progress', 'blocked', 'done'], 'status'),
        v.str(body.assignee, { name: 'assignee', max: 80, required: false }),
        siteId,
        isoDate(body.dueAt, 'dueAt') || null,
        v.str(body.note, { name: 'note', max: 500, required: false }),
      ]
    );
    logEvent({ actor: request.account.email, action: 'operations.task_created', subject: String(body.title).slice(0, 80), ip: request.ip });
    reply.status(201);
    return {
      task: taskView(
        db_.get('SELECT t.*, s.name AS site_name FROM tasks t LEFT JOIN sites s ON s.id = t.site_id WHERE t.id = ?', [id])
      ),
    };
  });

  app.patch('/operations/tasks/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM tasks WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Task not found');
    const body = request.body || {};
    const cast = {
      status: (value) => v.oneOf(value, ['open', 'in_progress', 'blocked', 'done'], 'status'),
      priority: (value) => v.oneOf(value, ['low', 'normal', 'high', 'critical'], 'priority'),
      assignee: (value) => v.str(value, { name: 'assignee', max: 80, required: false }),
      dueAt: (value) => isoDate(value, 'dueAt', { required: true }),
      note: (value) => v.str(value, { name: 'note', max: 500, required: false }),
      title: (value) => v.str(value, { name: 'title', min: 3, max: 140 }),
    };
    const fresh = patchRow(
      'tasks',
      row,
      body,
      { status: 'status', priority: 'priority', assignee: 'assignee', dueAt: 'due_at', note: 'note', title: 'title' },
      { actor: request.account.email, action: 'operations.task_updated', subject: row.title.slice(0, 80), ip: request.ip, cast }
    );
    return {
      task: taskView(
        db_.get('SELECT t.*, s.name AS site_name FROM tasks t LEFT JOIN sites s ON s.id = t.site_id WHERE t.id = ?', [row.id])
      ),
    };
  });

  app.delete('/operations/tasks/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM tasks WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Task not found');
    db_.run('DELETE FROM tasks WHERE id = ?', [row.id]);
    logEvent({ actor: request.account.email, action: 'operations.task_deleted', subject: row.title.slice(0, 80), ip: request.ip });
    return { ok: true };
  });
}
