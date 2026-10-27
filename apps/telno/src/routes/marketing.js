import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { aiStatus, chatJson, aiConfigured } from '../lib/ai.js';
import {
  TEMPLATES,
  campaignTotals,
  campaignView,
  claimBatch,
  contactView,
  finishContact,
  generateReport,
  importContacts,
  rebuildPdf,
  reportRow,
  reportView,
  ruleGrade,
  templateById,
} from '../lib/marketing.js';
import * as v from '../lib/validate.js';

/**
 * Marketing: campaigns over the voice agents.
 *
 * The console sends copy and a list; the platform owns the queue and the grade.
 * Dialing is deliberately split in two: `run` claims a batch and returns it (the
 * softphone or the agent engine places the calls), and everything that happened
 * comes back through the outcome endpoint. That is what makes the feature work
 * with whatever is answering the phone, including nothing at all — a campaign
 * can be worked by hand from the console.
 */

const CAMPAIGN_STATUSES = ['draft', 'running', 'paused', 'completed'];
const OUTCOMES = [
  'interested',
  'callback',
  'not-interested',
  'wrong-number',
  'do-not-call',
  'voicemail',
  'no-answer',
  'busy',
  'failed',
];

/** Contacts joined with their site name, so the list reads like an address book. */
const campaignQuery = `
  SELECT c.*,
         a.name AS agent_name,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id) AS total,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'queued') AS queued,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'calling') AS calling,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'completed') AS completed,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'failed') AS failed,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'skipped') AS skipped,
         (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'do_not_call') AS blocked,
         -- A lead is measured against the campaign's own threshold, not a fixed
         -- number: one campaign's qualified call is another's warm maybe.
         (SELECT COUNT(*) FROM campaign_contacts cc
           WHERE cc.campaign_id = c.id AND cc.grade IS NOT NULL AND cc.status <> 'do_not_call'
             AND cc.grade >= c.grade_threshold) AS leads,
         (SELECT AVG(cc.grade) FROM campaign_contacts cc
           WHERE cc.campaign_id = c.id AND cc.grade IS NOT NULL AND cc.status <> 'do_not_call') AS avg_grade
    FROM campaigns c
    LEFT JOIN voice_agents a ON a.id = c.agent_id`;

const campaignFor = (id) => {
  const row = db_.get(`${campaignQuery} WHERE c.id = ?`, [id]);
  return row ? campaignView(row) : null;
};

export default async function marketingRoutes(app) {
  // Every route here is somebody's pipeline data — campaign names, the agents
  // behind them, transcripts. The read routes had no hook and answered the open
  // internet; a session is required for all of them, entitlement included, and
  // the write routes below tighten it to a role on top of this.
  app.addHook('preHandler', async (request) => {
    await app.authenticate(request);
  });

  const requireWrite = app.requireRole('owner', 'operator');

  app.get('/marketing/overview', async () => {
    const campaigns = db_.all(`${campaignQuery} ORDER BY c.created_at DESC LIMIT 50`).map(campaignView);
    const agents = db_
      .all('SELECT id, name, status, voice FROM voice_agents ORDER BY name')
      .map((row) => ({ id: row.id, name: row.name, status: row.status, voice: row.voice }));
    const dialers = db_
      .all('SELECT extension, display_name FROM extensions WHERE enabled = 1 ORDER BY extension')
      .map((row) => ({ extension: row.extension, displayName: row.display_name }));

    const totals = campaigns.reduce(
      (acc, campaign) => ({
        campaigns: acc.campaigns + 1,
        dialed: acc.dialed + campaign.counts.calling + campaign.counts.completed,
        completed: acc.completed + campaign.counts.completed,
        leads: acc.leads + campaign.counts.leads,
      }),
      { campaigns: 0, dialed: 0, completed: 0, leads: 0 }
    );

    return {
      campaigns,
      templates: TEMPLATES,
      agents,
      dialers,
      // A campaign is graded with the model; the console says which one, and
      // whether the pipeline is running on rules instead.
      ai: aiStatus(),
      // Dialing is simulated when the switch runs without AMI, which is the
      // local/dev container. Saying so beats a campaign that appears to dial.
      telephony: { simulate: config.telephony.simulate },
      totals,
    };
  });

  /* ------------------------------------------------------------ campaigns -- */

  app.get('/marketing/campaigns', async () => ({
    items: db_.all(`${campaignQuery} ORDER BY c.created_at DESC LIMIT 100`).map(campaignView),
  }));

  app.post('/marketing/campaigns', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const name = v.str(body.name, { name: 'name', min: 3, max: 120 });
    if (db_.get('SELECT id FROM campaigns WHERE name = ?', [name])) {
      throw conflict(`A campaign named "${name}" already exists`);
    }
    const template = body.template ? templateById(body.template) : null;
    if (body.template && !template) throw badRequest('Unknown template');
    const agent = body.agentId
      ? db_.get('SELECT * FROM voice_agents WHERE id = ?', [String(body.agentId)]) || null
      : null;
    const dialer = v.str(body.dialerExtension, { name: 'dialerExtension', max: 12, required: false });

    const id = newId('cmp_');
    db_.run(
      `INSERT INTO campaigns (id, name, goal, template, agent_id, script, status, daily_limit,
                              grade_threshold, dialer_extension, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [
        id,
        name,
        v.str(body.goal || template?.goal, { name: 'goal', max: 400, required: false }),
        template?.id || '',
        agent?.id || null,
        v.str(body.script || template?.script, { name: 'script', max: 8000, required: false }),
        v.integer(body.dailyLimit ?? 50, { name: 'dailyLimit', min: 1, max: 1000 }),
        v.integer(body.gradeThreshold ?? 60, { name: 'gradeThreshold', min: 0, max: 100 }),
        dialer,
        request.account.email,
      ]
    );
    logEvent({
      actor: request.account.email,
      action: 'marketing.campaign_created',
      subject: name.slice(0, 80),
      detail: template ? `from template ${template.id}` : 'custom script',
      ip: request.ip,
    });
    reply.status(201);
    return { campaign: campaignFor(id) };
  });

  app.get('/marketing/campaigns/:id', async (request) => {
    const campaign = campaignFor(request.params.id);
    if (!campaign) throw notFound('Campaign not found');
    const contacts = db_
      .all('SELECT * FROM campaign_contacts WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 500', [campaign.id])
      .map(contactView);
    const reports = db_
      .all('SELECT * FROM campaign_reports WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 20', [campaign.id])
      .map(reportView);
    return {
      campaign,
      contacts,
      reports,
      totals: campaignTotals(campaign.id),
      template: campaign.template ? templateById(campaign.template) : null,
    };
  });

  app.patch('/marketing/campaigns/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM campaigns WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Campaign not found');
    const body = request.body || {};

    const cast = {
      name: (value) => v.str(value, { name: 'name', min: 3, max: 120 }),
      goal: (value) => v.str(value, { name: 'goal', max: 400, required: false }),
      script: (value) => v.str(value, { name: 'script', max: 8000, required: false }),
      status: (value) => v.oneOf(value, CAMPAIGN_STATUSES, 'status'),
      dailyLimit: (value) => v.integer(value, { name: 'dailyLimit', min: 1, max: 1000 }),
      gradeThreshold: (value) => v.integer(value, { name: 'gradeThreshold', min: 0, max: 100 }),
      template: (value) => (value ? v.oneOf(value, TEMPLATES.map((entry) => entry.id), 'template') : ''),
      agentId: (value) => {
        if (!value) return null;
        const agent = db_.get('SELECT id FROM voice_agents WHERE id = ?', [String(value)]);
        if (!agent) throw badRequest('Choose a voice agent that exists');
        return agent.id;
      },
      dialerExtension: (value) => {
        const extension = v.str(value, { name: 'dialerExtension', max: 12, required: false });
        if (!extension) return '';
        if (!db_.get('SELECT extension FROM extensions WHERE extension = ?', [extension])) {
          throw badRequest('That dialer extension does not exist');
        }
        return extension;
      },
    };

    const columns = {
      name: 'name',
      goal: 'goal',
      script: 'script',
      status: 'status',
      dailyLimit: 'daily_limit',
      gradeThreshold: 'grade_threshold',
      template: 'template',
      agentId: 'agent_id',
      dialerExtension: 'dialer_extension',
    };

    const sets = [];
    const params = [];
    for (const [field, column] of Object.entries(columns)) {
      if (body[field] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(cast[field](body[field]));
    }
    if (!sets.length) return { campaign: campaignFor(row.id) };

    sets.push('updated_at = ?');
    params.push(now(), row.id);
    db_.run(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, params);
    logEvent({
      actor: request.account.email,
      action: 'marketing.campaign_updated',
      subject: row.name.slice(0, 80),
      detail: Object.keys(body).join(', '),
      ip: request.ip,
    });
    return { campaign: campaignFor(row.id) };
  });

  app.delete('/marketing/campaigns/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM campaigns WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Campaign not found');
    db_.run('DELETE FROM campaigns WHERE id = ?', [row.id]);
    logEvent({
      actor: request.account.email,
      action: 'marketing.campaign_deleted',
      subject: row.name.slice(0, 80),
      ip: request.ip,
    });
    return { ok: true };
  });

  /* -------------------------------------------------------------- contacts -- */

  app.post('/marketing/campaigns/:id/contacts', { preHandler: requireWrite }, async (request, reply) => {
    const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [request.params.id]);
    if (!campaign) throw notFound('Campaign not found');
    const body = request.body || {};
    const text = v.str(body.text, { name: 'text', max: 200_000 });
    const report = importContacts(campaign.id, text);
    logEvent({
      actor: request.account.email,
      action: 'marketing.contacts_imported',
      subject: campaign.name.slice(0, 80),
      detail: `${report.added} added, ${report.duplicates} duplicate, ${report.optedOut} opted out, ${report.invalid} invalid`,
      ip: request.ip,
    });
    // `duplicates` is not an error: importing the same list twice is normal, and
    // the reply says exactly how many were already there.
    reply.status(report.added ? 201 : 200);
    return { report, campaign: campaignFor(campaign.id) };
  });

  app.delete('/marketing/contacts/:id', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM campaign_contacts WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Contact not found');
    db_.run('DELETE FROM campaign_contacts WHERE id = ?', [row.id]);
    return { ok: true };
  });

  /**
   * Claim the next batch. Claims are exclusive, so two operators working the
   * same campaign never call the same person.
   */
  app.post('/marketing/campaigns/:id/run', { preHandler: requireWrite }, async (request) => {
    const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [request.params.id]);
    if (!campaign) throw notFound('Campaign not found');
    if (campaign.status === 'draft' || campaign.status === 'paused' || campaign.status === 'completed') {
      throw badRequest(`A ${campaign.status} campaign does not dial. Set it to running first.`);
    }
    const body = request.body || {};
    const limit = v.integer(body.limit ?? 10, { name: 'limit', min: 1, max: 100 });
    const batch = claimBatch(campaign.id, Math.min(limit, campaign.daily_limit));

    logEvent({
      actor: request.account.email,
      action: 'marketing.batch_claimed',
      subject: campaign.name.slice(0, 80),
      detail: `${batch.length} contact(s)`,
      ip: request.ip,
    });
    return {
      campaign: campaignFor(campaign.id),
      batch,
      // What the console says while the batch is worked: dialing is off when the
      // switch is simulated, and the softphone has to place the call itself.
      telephony: {
        simulate: config.telephony.simulate,
        dialerExtension: campaign.dialer_extension || '',
      },
    };
  });

  /**
   * Post what happened. This is where a disposition becomes a grade, so it is
   * the only way a contact leaves `calling`.
   */
  app.post('/marketing/contacts/:id/outcome', { preHandler: requireWrite }, async (request) => {
    const contact = db_.get('SELECT * FROM campaign_contacts WHERE id = ?', [request.params.id]);
    if (!contact) throw notFound('Contact not found');
    const body = request.body || {};
    const outcome = v.oneOf(body.outcome, OUTCOMES, 'outcome');
    const status =
      outcome === 'do-not-call'
        ? 'do_not_call'
        : body.status
          ? v.oneOf(body.status, ['completed', 'failed', 'skipped'], 'status')
          : 'completed';

    const graded = await finishContact(contact.id, {
      status,
      outcome,
      transcript: v.str(body.transcript, { name: 'transcript', max: 20_000, required: false }),
      durationSec: v.integer(body.durationSec ?? 0, { name: 'durationSec', min: 0, max: 86_400 }),
    });
    logEvent({
      actor: request.account.email,
      action: 'marketing.outcome_recorded',
      subject: contact.e164,
      detail: `${outcome}${graded?.grade !== undefined && graded?.grade !== null ? ` grade ${graded.grade}` : ''}`,
      ip: request.ip,
    });
    return { contact: graded, campaign: campaignFor(contact.campaign_id) };
  });

  /** Re-grade everything already answered — after a prompt change, say. */
  app.post('/marketing/campaigns/:id/grade', { preHandler: requireWrite }, async (request) => {
    const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [request.params.id]);
    if (!campaign) throw notFound('Campaign not found');
    const contacts = db_.all(
      "SELECT * FROM campaign_contacts WHERE campaign_id = ? AND status = 'completed' AND outcome <> 'do-not-call'",
      [campaign.id]
    );
    let graded = 0;
    for (const contact of contacts) {
      const value = aiConfigured()
        ? await finishContact(contact.id, {
            status: 'completed',
            outcome: contact.outcome,
            transcript: contact.transcript,
            durationSec: contact.duration_sec,
          })
        : null;
      if (!value) {
        const rules = ruleGrade({
          outcome: contact.outcome,
          transcript: contact.transcript,
          durationSec: contact.duration_sec,
        });
        db_.run('UPDATE campaign_contacts SET grade = ?, reasons = ? WHERE id = ?', [
          rules.grade,
          JSON.stringify(rules.reasons),
          contact.id,
        ]);
      }
      graded += 1;
    }
    logEvent({
      actor: request.account.email,
      action: 'marketing.campaign_regraded',
      subject: campaign.name.slice(0, 80),
      detail: `${graded} call(s) re-graded`,
      ip: request.ip,
    });
    return { graded, campaign: campaignFor(campaign.id) };
  });

  /* ---------------------------------------------------------------- report -- */

  app.post('/marketing/campaigns/:id/report', { preHandler: requireWrite }, async (request, reply) => {
    const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [request.params.id]);
    if (!campaign) throw notFound('Campaign not found');
    const body = request.body || {};
    const email = body.email ? v.email(body.email) : '';

    const report = await generateReport(campaign.id, { email, actor: request.account.email });
    if (!report) throw notFound('Campaign not found');

    logEvent({
      actor: request.account.email,
      action: 'marketing.report_generated',
      subject: campaign.name.slice(0, 80),
      detail: `${report.bytes} bytes${email ? ` -> ${email} (${report.delivery.channel}${report.delivery.delivered ? '' : `: ${report.delivery.error}`})` : ' (not emailed)'}`,
      ip: request.ip,
    });

    reply.status(201);
    return {
      report: {
        id: report.id,
        file: report.file,
        bytes: report.bytes,
        totals: report.totals,
        narrative: report.narrative,
        generatedAt: report.generatedAt,
        delivery: report.delivery,
        downloadPath: `/api/marketing/reports/${report.id}/download`,
      },
    };
  });

  app.get('/marketing/reports/:id/download', async (request, reply) => {
    const row = reportRow(request.params.id);
    if (!row) throw notFound('Report not found');
    const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [row.campaign_id]);
    // The PDF is rebuilt from the stored totals: the numbers are the record, and
    // a regenerated document cannot drift from what was emailed.
    const pdf = rebuildPdf(row.totals, campaign?.name || 'Campaign', row.created_by);
    const name = `${String(campaign?.name || 'campaign').replace(/[^\w.-]+/g, '-').slice(0, 60)}-report.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, max-age=0')
      .send(pdf);
  });

  /* ------------------------------------------------------------ suggestion -- */

  /**
   * Improve a script against its goal. The model is told what the campaign is
   * for and what is on the page; it is not allowed to invent offers or prices.
   */
  app.post('/marketing/suggest', { preHandler: requireWrite }, async (request) => {
    const body = request.body || {};
    const goal = v.str(body.goal, { name: 'goal', min: 5, max: 400 });
    const script = v.str(body.script, { name: 'script', max: 8000, required: false });

    if (!aiConfigured()) {
      const template = TEMPLATES[0];
      return {
        ok: false,
        error: 'ai_not_configured',
        fallback: {
          script: script || template.script,
          tips: template.tips,
          note: 'Add LLM_API_KEY in Settings to get suggestions written for this goal.',
        },
      };
    }

    const result = await chatJson({
      maxTokens: 900,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content:
            'You write short outbound phone scripts for a business telephony provider. ' +
            'Return JSON: script (a 45-second spoken script, no stage directions), ' +
            'tips (array of 3 short coaching notes), objection (the most likely objection and one line to answer it). ' +
            'Never invent prices, discounts or promises. Plain American English, no marketing adjectives.',
        },
        {
          role: 'user',
          content: `Goal: ${goal}\n\nCurrent script:\n${script || '(none yet)'}`,
        },
      ],
    });

    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, suggestion: result.value, model: result.model };
  });
}
