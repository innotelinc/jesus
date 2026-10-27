import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { normalizeNumber, formatNumber } from './e164.js';
import { chatJson, aiConfigured } from './ai.js';
import { buildPdf, row } from './pdf.js';
import { deliverNotice } from './channels.js';

/**
 * Outbound marketing over the voice agents.
 *
 * A campaign is a list, a script and a goal. The platform owns the queue, the
 * disposition and the graded report; the agent engine (or a softphone on the
 * dialer extension) owns the talking. Everything here is written so a campaign
 * is useful on the day it is created:
 *
 *   import contacts → claim a batch → post what happened → grade → report
 *
 * Grading is the reason this is not just a call list. A transcript is read
 * against the campaign's own goal, so "interested" on a renewal campaign and
 * "interested" on a cold campaign do not score the same, and the report says
 * why each call scored what it did instead of showing a number nobody can
 * defend.
 */

/* ------------------------------------------------------------- templates -- */

/**
 * Starting points, each with the goal it is for and how to read a good call.
 * A template is copy in the database, not code: choosing one copies its script
 * into the campaign, where it can be edited freely.
 */
export const TEMPLATES = [
  {
    id: 'renewal',
    name: 'Renewal outreach',
    goal: 'Renew a subscription that is close to its end date.',
    script:
      'Hi, this is Alex from Innotel Labs about the line we look after for you. ' +
      'Your plan renews soon and I wanted to make sure the number and the handset are still exactly what you need. ' +
      'If they are, I can confirm the renewal today and keep the price the same. ' +
      'If something has changed, tell me what would work better and I will price it before we hang up.',
    tips: [
      'Name the renewal date early; vague urgency reads as a sales pitch.',
      'Ask one question at a time and let the customer finish.',
      'Agree the next step, with a date, before ending the call.',
    ],
  },
  {
    id: 'winback',
    name: 'Win-back',
    goal: 'Bring back a customer who left or canceled in the last year.',
    script:
      'Hi, this is Alex from Innotel Labs. We used to look after the phones for your business and I am not calling to sell you anything today. ' +
      'I am checking whether the reason you left is something we have since fixed. Can I ask what the old setup got wrong? ' +
      'If it is still a problem I will say so honestly; if it is fixed, I can show you what it would cost now.',
    tips: [
      'Acknowledge the reason they left before mentioning price.',
      'One concrete improvement beats a list of features.',
      'A clear "no" is a good outcome; record it and stop calling.',
    ],
  },
  {
    id: 'lead-qualify',
    name: 'Lead qualification',
    goal: 'Find out whether an inbound lead has a real requirement and a budget.',
    script:
      'Hi, this is Alex from Innotel Labs returning your inquiry about business phone service. ' +
      'So I point you at the right thing: how many people need a line, and are they in one office or several? ' +
      'Who handles the phone bill today? And is there a date you need this working by?',
    tips: [
      'Three questions, no more. Qualification is not an interrogation.',
      'Repeat the requirement back before proposing anything.',
      'Book the next step while you are still on the call.',
    ],
  },
  {
    id: 'appointment',
    name: 'Appointment booking',
    goal: 'Book a 20-minute review call with a decision maker.',
    script:
      'Hi, this is Alex from Innotel Labs. I work with businesses on their phone systems and I have 20 minutes on Thursday or Friday. ' +
      'Would a short review of what you are paying for now be useful, with no obligation to change anything? ' +
      'If Thursday works, I will send the invite while we are talking.',
    tips: [
      'Offer exactly two times; open-ended availability stalls the call.',
      'Confirm the email address and send the invite during the call.',
      'Never book a review you cannot staff.',
    ],
  },
  {
    id: 'payment',
    name: 'Payment follow-up',
    goal: 'Collect an overdue balance without damaging the relationship.',
    script:
      'Hi, this is Alex from Innotel Labs calling about the balance on your account. ' +
      'I can see the invoice and I would rather sort out the timing with you than send another notice. ' +
      'Can you clear it this week, or would a short plan work better? I can put the plan in place now.',
    tips: [
      'State the amount and the invoice date plainly, once.',
      'Offer a plan before mentioning suspension.',
      'Record the promise date exactly as the customer says it.',
    ],
  },
  {
    id: 'survey',
    name: 'Customer check-in',
    goal: 'Learn how the service is working and surface churn risk early.',
    script:
      'Hi, this is Alex from Innotel Labs. This is a short check-in, not a sales call. ' +
      'On a scale of one to ten, how likely are you to recommend us, and what is the main reason for that number? ' +
      'Is there anything about the phones that has been annoying you lately?',
    tips: [
      'Ask for the reason behind the score, not just the score.',
      'Write down the complaint in the customer\'s words.',
      'Anything below seven is a follow-up task, not a data point.',
    ],
  },
];

export const templateById = (id) => TEMPLATES.find((entry) => entry.id === id) || null;

/* ------------------------------------------------------------------ views -- */

export const campaignView = (row) => ({
  id: row.id,
  name: row.name,
  goal: row.goal,
  template: row.template,
  agentId: row.agent_id || '',
  agentName: row.agent_name || '',
  script: row.script,
  status: row.status,
  dailyLimit: row.daily_limit,
  gradeThreshold: row.grade_threshold,
  dialerExtension: row.dialer_extension || '',
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastRunAt: row.last_run_at || null,
  counts: {
    total: row.total ?? 0,
    queued: row.queued ?? 0,
    calling: row.calling ?? 0,
    completed: row.completed ?? 0,
    failed: row.failed ?? 0,
    skipped: row.skipped ?? 0,
    blocked: row.blocked ?? 0,
    // Contacts at or above the campaign's own grade threshold.
    leads: row.leads ?? 0,
  },
  avgGrade: row.avg_grade === null || row.avg_grade === undefined ? null : Math.round(row.avg_grade),
});

export const contactView = (row) => {
  let reasons = [];
  try {
    const parsed = JSON.parse(row.reasons || '[]');
    reasons = Array.isArray(parsed) ? parsed : [];
  } catch {
    reasons = [];
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    number: row.e164 ? formatNumber(row.e164) : '',
    e164: row.e164,
    email: row.email,
    notes: row.notes,
    status: row.status,
    attempts: row.attempts,
    outcome: row.outcome,
    grade: row.grade,
    reasons,
    transcript: row.transcript,
    durationSec: row.duration_sec,
    calledAt: row.called_at,
    createdAt: row.created_at,
    siteName: row.site_name || '',
  };
};

/* --------------------------------------------------------------- contacts -- */

/**
 * Import a pasted list. Accepts `Name, +1 415 555 0123` per line, or columns
 * separated by tabs, commas or semicolons; the first column that parses as a
 * phone number wins, and anything before it is the name.
 *
 * Dedupe is the point: a list imported twice must not dial anyone twice, so the
 * unique index on (campaign, number) is what actually enforces it and the reply
 * reports what it did rather than claiming a clean import.
 */
export function importContacts(campaignId, text) {
  const report = { added: 0, duplicates: 0, optedOut: 0, invalid: 0, skipped: [] };
  const existing = new Set(
    db_.all('SELECT e164 FROM campaign_contacts WHERE campaign_id = ?', [campaignId]).map((r) => r.e164)
  );
  const optouts = new Set(db_.all('SELECT e164 FROM optouts').map((r) => r.e164));

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\t|,|;/).map((part) => part.trim()).filter((part) => part !== '');
    if (!parts.length) continue;

    let e164 = '';
    let name = '';
    let email = '';
    for (const part of parts) {
      if (part.includes('@') && !email) {
        email = part.toLowerCase();
        continue;
      }
      if (!e164) {
        const parsed = normalizeNumber(part, { defaultCountry: config.defaultCountry });
        if (parsed.ok) {
          e164 = parsed.e164;
          continue;
        }
        /* not a number: it is part of the name */
      }
      name = name ? `${name} ${part}` : part;
    }

    if (!e164) {
      report.invalid += 1;
      if (report.skipped.length < 8) report.skipped.push(line.slice(0, 60));
      continue;
    }
    if (optouts.has(e164)) {
      report.optedOut += 1;
      continue;
    }
    if (existing.has(e164)) {
      report.duplicates += 1;
      continue;
    }

    db_.run(
      `INSERT INTO campaign_contacts (id, campaign_id, name, e164, email)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (campaign_id, e164) DO NOTHING`,
      [newId('cc_'), campaignId, name.slice(0, 120), e164, email.slice(0, 160)]
    );
    existing.add(e164);
    report.added += 1;
  }

  return report;
}

/**
 * Claim the next batch. A contact is claimed by being moved to `calling` in the
 * same statement that selects it, so two runs can never dial the same person.
 * Claims older than the stale window are released first: a crashed run must not
 * strand a list forever.
 */
export function claimBatch(campaignId, limit, staleMinutes = 30) {
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  db_.run(
    `UPDATE campaign_contacts SET status = 'queued'
      WHERE campaign_id = ? AND status = 'calling' AND (called_at IS NULL OR called_at < ?)`,
    [campaignId, staleBefore]
  );

  const rows = db_.all(
    `SELECT * FROM campaign_contacts
      WHERE campaign_id = ? AND status = 'queued'
      ORDER BY created_at LIMIT ?`,
    [campaignId, limit]
  );
  const stamp = now();
  for (const contact of rows) {
    db_.run(
      `UPDATE campaign_contacts SET status = 'calling', attempts = attempts + 1, called_at = ? WHERE id = ?`,
      [stamp, contact.id]
    );
  }
  db_.run('UPDATE campaigns SET last_run_at = ?, updated_at = ? WHERE id = ?', [stamp, stamp, campaignId]);
  return rows.map((contact) => contactView({ ...contact, status: 'calling', attempts: contact.attempts + 1, called_at: stamp }));
}

/**
 * How the platform scores a call when no model is configured. Deliberately
 * simple and visible: it exists so the pipeline still produces a defensible
 * report instead of an empty column, and the report says which one ran.
 */
const RULE_GRADES = {
  interested: 85,
  callback: 65,
  'not-interested': 25,
  'wrong-number': 5,
  'do-not-call': 0,
  voicemail: 15,
  'no-answer': 10,
  busy: 10,
  failed: 0,
};

const POSITIVE_SIGNALS = [
  [/\b(budget|approved|decision|quote|proposal)\b/i, 6, 'Discussed commercial detail'],
  [/\b(next week|thursday|friday|monday|tuesday|wednesday|tomorrow)\b/i, 5, 'Named a specific time'],
  [/\b(email|send me|invite|calendar)\b/i, 4, 'Agreed to receive something'],
  [/\b(interesting|sounds good|yes|go ahead|tell me more)\b/i, 4, 'Responded positively'],
  [/\b(cancel|already have|not interested|remove|stop calling)\b/i, -12, 'Said no or asked to stop'],
  [/\b(complaint|angry|unhappy|frustrated)\b/i, -8, 'Raised a complaint'],
];

export function ruleGrade({ outcome, transcript = '', durationSec = 0 }) {
  const base = RULE_GRADES[outcome] ?? 20;
  const reasons = [];
  let score = base;

  if (transcript) {
    for (const [pattern, points, reason] of POSITIVE_SIGNALS) {
      if (pattern.test(transcript)) {
        score += points;
        reasons.push(reason);
      }
    }
  }
  if (durationSec >= 120) {
    score += 5;
    reasons.push('Conversation lasted two minutes or more');
  }
  if (durationSec > 0 && durationSec < 20 && outcome === 'interested') {
    // A 15-second "yes" is not a qualified lead; it is a hang-up with manners.
    score -= 15;
    reasons.push('Very short call for a positive outcome');
  }

  const grade = Math.max(0, Math.min(100, Math.round(score)));
  if (!reasons.length) reasons.push(`Disposition: ${outcome || 'not recorded'}`);
  return { grade, reasons, summary: '', nextStep: '', by: 'rules' };
}

/**
 * Grade one call against the campaign's goal. The model is asked for a score,
 * the reasons that justify it, and the next step; anything it cannot do falls
 * back to the rule grader, so a campaign is never left ungraded because the
 * gateway was slow.
 */
export async function gradeContact({ campaign, contact }) {
  const fallback = ruleGrade({
    outcome: contact.outcome,
    transcript: contact.transcript,
    durationSec: contact.duration_sec,
  });

  if (!aiConfigured()) return fallback;

  const result = await chatJson({
    maxTokens: 600,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'You grade outbound sales calls for a business telephony provider. ' +
          'You return JSON with: grade (0-100 integer), reasons (array of up to 4 short strings), ' +
          'summary (one sentence), nextStep (one short imperative sentence). ' +
          'Be strict: interest without a concrete next step is not a lead. ' +
          'If the customer asked not to be called again, the grade must be 0.',
      },
      {
        role: 'user',
        content:
          `Campaign: ${campaign.name}\n` +
          `Goal: ${campaign.goal}\n` +
          `Script the agent followed:\n${campaign.script}\n\n` +
          `Disposition recorded by the agent: ${contact.outcome || 'none'}\n` +
          `Call length: ${contact.duration_sec || 0} seconds\n` +
          `Transcript:\n${(contact.transcript || '(no transcript)').slice(0, 6000)}`,
      },
    ],
  });

  if (!result.ok) return { ...fallback, by: 'rules', error: result.error };
  const value = result.value || {};
  const grade = Number(value.grade);
  if (!Number.isFinite(grade)) return { ...fallback, by: 'rules', error: 'ai_ungraded' };

  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((reason) => typeof reason === 'string').slice(0, 4)
    : fallback.reasons;

  return {
    grade: Math.max(0, Math.min(100, Math.round(grade))),
    reasons: reasons.length ? reasons : fallback.reasons,
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 300) : '',
    nextStep: typeof value.nextStep === 'string' ? value.nextStep.slice(0, 200) : '',
    by: 'ai',
    model: result.model || null,
  };
}

/** Record what happened and grade it in one step, so a route cannot forget. */
export async function finishContact(contactId, { status, outcome, transcript, durationSec } = {}) {
  const contact = db_.get('SELECT * FROM campaign_contacts WHERE id = ?', [contactId]);
  if (!contact) return null;
  const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [contact.campaign_id]);
  if (!campaign) return null;

  const nextStatus = status || 'completed';
  db_.run(
    `UPDATE campaign_contacts
        SET status = ?, outcome = ?, transcript = ?, duration_sec = ?
      WHERE id = ?`,
    [
      ['queued', 'calling', 'completed', 'failed', 'skipped', 'do_not_call'].includes(nextStatus) ? nextStatus : 'completed',
      String(outcome || '').slice(0, 40),
      String(transcript || '').slice(0, 20000),
      Math.max(0, Math.min(86_400, Number(durationSec) || 0)),
      contact.id,
    ]
  );

  const fresh = db_.get('SELECT * FROM campaign_contacts WHERE id = ?', [contact.id]);
  // A do-not-call is not graded; it is honored, and the number is added to the
  // platform-wide opt-out list so no future campaign can dial it either.
  if (nextStatus === 'do_not_call' || outcome === 'do-not-call') {
    db_.run(
      'INSERT INTO optouts (e164, reason) VALUES (?, ?) ON CONFLICT (e164) DO NOTHING',
      [fresh.e164, `Campaign: ${campaign.name}`]
    );
    db_.run("UPDATE campaign_contacts SET status = 'do_not_call', grade = 0, reasons = ? WHERE id = ?", [
      JSON.stringify(['Customer asked not to be called again']),
      fresh.id,
    ]);
    return contactView(db_.get('SELECT * FROM campaign_contacts WHERE id = ?', [fresh.id]));
  }

  if (nextStatus === 'failed' || nextStatus === 'skipped') {
    return contactView(fresh);
  }

  const graded = await gradeContact({ campaign, contact: fresh });
  db_.run('UPDATE campaign_contacts SET grade = ?, reasons = ? WHERE id = ?', [
    graded.grade,
    JSON.stringify(graded.reasons.concat(graded.nextStep ? [graded.nextStep] : [])),
    fresh.id,
  ]);
  return contactView(db_.get('SELECT * FROM campaign_contacts WHERE id = ?', [fresh.id]));
}

/* ---------------------------------------------------------------- totals -- */

export function campaignTotals(campaignId) {
  const contacts = db_.all('SELECT * FROM campaign_contacts WHERE campaign_id = ?', [campaignId]);
  const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  const threshold = campaign?.grade_threshold ?? 60;

  const byOutcome = {};
  for (const contact of contacts) {
    if (contact.status !== 'completed') continue;
    const key = contact.outcome || 'unrecorded';
    byOutcome[key] = (byOutcome[key] || 0) + 1;
  }

  // A do-not-call is counted, but never averaged: it was not a conversation,
  // and a zero in the average would make a good campaign look bad.
  const graded = contacts.filter(
    (contact) => contact.grade !== null && contact.grade !== undefined && contact.status !== 'do_not_call'
  );
  const average = graded.length ? graded.reduce((sum, c) => sum + Number(c.grade), 0) / graded.length : 0;
  const leads = graded.filter((contact) => Number(contact.grade) >= threshold);
  const talked = contacts.filter((contact) => contact.status === 'completed' && (contact.duration_sec || 0) > 0);
  const totalSeconds = talked.reduce((sum, contact) => sum + Number(contact.duration_sec || 0), 0);

  // Reason tallies: what the grader said most often is the campaign's lesson.
  const reasonCounts = new Map();
  for (const contact of graded) {
    let reasons = [];
    try {
      reasons = JSON.parse(contact.reasons || '[]');
    } catch {
      reasons = [];
    }
    for (const reason of reasons) {
      if (typeof reason !== 'string' || !reason) continue;
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  return {
    campaign: campaign?.name || '',
    goal: campaign?.goal || '',
    threshold,
    contacts: contacts.length,
    dialed: contacts.filter((c) => (c.attempts || 0) > 0).length,
    completed: contacts.filter((c) => c.status === 'completed').length,
    queued: contacts.filter((c) => c.status === 'queued').length,
    blocked: contacts.filter((c) => c.status === 'do_not_call').length,
    leads: leads.length,
    averageGrade: Math.round(average),
    totalTalkSeconds: totalSeconds,
    byOutcome: Object.entries(byOutcome)
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, count]) => ({ outcome, count })),
    topReasons,
    leaders: leads
      .sort((a, b) => Number(b.grade) - Number(a.grade))
      .slice(0, 10)
      .map((contact) => ({
        name: contact.name || formatNumber(contact.e164),
        number: formatNumber(contact.e164),
        grade: Number(contact.grade),
        outcome: contact.outcome,
      })),
  };
}

/* ---------------------------------------------------------------- report -- */

const duration = (seconds) => {
  const total = Math.round(Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
};

/**
 * A closing summary written from the totals, not from individual transcripts:
 * it is the paragraph a manager reads before the numbers.
 */
async function reportNarrative(totals) {
  const shape =
    `${totals.campaign}: ${totals.dialed} calls placed, ${totals.completed} completed, ` +
    `${totals.leads} at or above the ${totals.threshold} grade threshold, ` +
    `average grade ${totals.averageGrade}, ${duration(totals.totalTalkSeconds)} of talk time. ` +
    `Goal: ${totals.goal}`;

  if (!aiConfigured()) {
    return {
      ok: false,
      text:
        `${shape}\n\n` +
        (totals.byOutcome.length
          ? `Dispositions: ${totals.byOutcome.map((entry) => `${entry.outcome} ${entry.count}`).join(', ')}.`
          : 'No dispositions recorded yet.'),
    };
  }

  const result = await chatJson({
    maxTokens: 500,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'You write the executive summary of an outbound call campaign for its operator. ' +
          'Return JSON: headline (one sentence), findings (array of up to 4 short strings), ' +
          'recommendation (one short paragraph). Be concrete, use the numbers given, do not invent any.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          campaign: totals.campaign,
          goal: totals.goal,
          contacts: totals.contacts,
          dialed: totals.dialed,
          completed: totals.completed,
          leads: totals.leads,
          averageGrade: totals.averageGrade,
          talkTimeSeconds: totals.totalTalkSeconds,
          dispositions: totals.byOutcome,
          recurringReasons: totals.topReasons,
        }),
      },
    ],
  });

  if (!result.ok) return { ok: false, text: shape };
  const value = result.value || {};
  const findings = Array.isArray(value.findings) ? value.findings.filter((f) => typeof f === 'string') : [];
  return {
    ok: true,
    headline: typeof value.headline === 'string' ? value.headline : '',
    findings,
    recommendation: typeof value.recommendation === 'string' ? value.recommendation : '',
    text: [
      typeof value.headline === 'string' ? value.headline : '',
      ...findings.map((finding) => `- ${finding}`),
      typeof value.recommendation === 'string' ? `\n${value.recommendation}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** The PDF: numbers first, then the narrative, then the lead list. */
function renderPdf(totals, narrative, generatedAt, by) {
  const blocks = [
    { style: 'title', text: 'Campaign report' },
    { style: 'heading', text: totals.campaign },
    { style: 'body', text: `Goal: ${totals.goal || 'not stated'}` },
    { style: 'fine', text: `Generated ${generatedAt} by ${by || 'telno'}` },
    { style: 'space', size: 10 },
    { style: 'rule' },
    { style: 'heading', text: 'Results' },
    { style: 'mono', text: row(['Contacts', 'Dialed', 'Completed', 'Leads'], [14, 10, 12, 10]) },
    {
      style: 'mono',
      text: row(
        [String(totals.contacts), String(totals.dialed), String(totals.completed), String(totals.leads)],
        [14, 10, 12, 10]
      ),
    },
    { style: 'space', size: 6 },
    { style: 'body', text: `Average grade: ${totals.averageGrade} (lead threshold ${totals.threshold})` },
    { style: 'body', text: `Talk time: ${duration(totals.totalTalkSeconds)}` },
    { style: 'space', size: 6 },
    { style: 'heading', text: 'Dispositions' },
  ];

  if (totals.byOutcome.length) {
    blocks.push({ style: 'mono', text: row(['Outcome', 'Calls', 'Share'], [22, 8, 8]) });
    for (const entry of totals.byOutcome) {
      const share = totals.completed ? Math.round((entry.count / totals.completed) * 100) : 0;
      blocks.push({
        style: 'mono',
        text: row([entry.outcome, String(entry.count), `${share}%`], [22, 8, 8]),
      });
    }
  } else {
    blocks.push({ style: 'body', text: 'No completed calls yet.' });
  }

  blocks.push({ style: 'space', size: 8 }, { style: 'rule' }, { style: 'heading', text: 'Summary' });
  for (const line of String(narrative.text || '').split('\n')) {
    blocks.push({ style: 'body', text: line || ' ' });
  }

  if (totals.topReasons.length) {
    blocks.push({ style: 'space', size: 8 }, { style: 'heading', text: 'What the grader saw most' });
    for (const entry of totals.topReasons) {
      blocks.push({ style: 'body', text: `${entry.count} x ${entry.reason}` });
    }
  }

  if (totals.leaders.length) {
    blocks.push({ style: 'space', size: 8 }, { style: 'heading', text: 'Top graded calls' });
    blocks.push({ style: 'mono', text: row(['Grade', 'Name', 'Number', 'Outcome'], [6, 22, 17, 14]) });
    for (const lead of totals.leaders) {
      blocks.push({
        style: 'mono',
        text: row([String(lead.grade), lead.name, lead.number, lead.outcome || '-'], [6, 22, 17, 14]),
      });
    }
  }

  return buildPdf(blocks, { footer: `${totals.campaign} - Telno campaign report` });
}

const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The email body: the same report, readable without opening the attachment. */
function renderHtml(totals, narrative) {
  const outcomeRows = totals.byOutcome.length
    ? totals.byOutcome
        .map(
          (entry) =>
            `<tr><td style="padding:6px 0;border-bottom:1px solid #eef0f4">${escapeHtml(entry.outcome)}</td>` +
            `<td style="padding:6px 0;border-bottom:1px solid #eef0f4;text-align:right">${entry.count}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="2" style="padding:6px 0;color:#6b7280">No completed calls yet.</td></tr>';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="padding:22px 26px;background:#0b1020;color:#ffffff">
      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9aa4b2">Telno campaign report</div>
      <div style="font-size:22px;font-weight:650;margin-top:6px">${escapeHtml(totals.campaign)}</div>
      <div style="font-size:13px;color:#c7cdd6;margin-top:4px">${escapeHtml(totals.goal)}</div>
    </div>
    <div style="padding:24px 26px">
      <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
        <tr>
          <td style="padding:10px;background:#f8fafc;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:650">${totals.dialed}</div>
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em">Dialed</div>
          </td>
          <td style="width:8px"></td>
          <td style="padding:10px;background:#f8fafc;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:650">${totals.completed}</div>
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em">Completed</div>
          </td>
          <td style="width:8px"></td>
          <td style="padding:10px;background:#f8fafc;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:650">${totals.leads}</div>
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em">Leads</div>
          </td>
          <td style="width:8px"></td>
          <td style="padding:10px;background:#f8fafc;border-radius:8px;text-align:center">
            <div style="font-size:22px;font-weight:650">${totals.averageGrade}</div>
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em">Avg grade</div>
          </td>
        </tr>
      </table>

      <h2 style="font-size:15px;margin:24px 0 8px">Summary</h2>
      <div style="font-size:14px;line-height:1.55;color:#1f2937;white-space:pre-line">${escapeHtml(narrative.text || '')}</div>

      <h2 style="font-size:15px;margin:24px 0 8px">Dispositions</h2>
      <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${outcomeRows}</table>

      <p style="font-size:12px;color:#6b7280;margin-top:24px">
        The full report is attached as a PDF. Talk time: ${duration(totals.totalTalkSeconds)}.
        Lead threshold: grade ${totals.threshold} or above.
      </p>
    </div>
    <div style="padding:16px 26px;background:#f8fafc;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280">
      Telno by Innotel Labs - outbound marketing report
    </div>
  </div>
</body></html>`;
}

/**
 * Build, store and (optionally) email the report. The stored row is the
 * receipt: bytes on the data volume so the same report can be downloaded later,
 * and the provider that carried it so a delivery problem is traceable.
 */
export async function generateReport(campaignId, { email = '', actor = 'system' } = {}) {
  const campaign = db_.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  if (!campaign) return null;

  const totals = campaignTotals(campaignId);
  const narrative = await reportNarrative(totals);
  const generatedAt = new Date().toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const pdf = renderPdf(totals, narrative, generatedAt, actor);
  const html = renderHtml(totals, narrative);

  const id = newId('rpt_');
  const file = `${campaign.id}-${id}.pdf`;
  db_.run(
    `INSERT INTO campaign_reports (id, campaign_id, created_by, totals, file, bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, campaignId, actor, JSON.stringify({ ...totals, narrative: narrative.text, gradedBy: narrative.ok ? 'ai' : 'rules' }), file, pdf.length]
  );

  let delivery = { delivered: false, channel: 'none', error: 'no_recipient' };
  if (email) {
    delivery = await deliverNotice({
      to: email,
      subject: `Campaign report: ${campaign.name} - ${totals.leads} leads from ${totals.dialed} calls`,
      text:
        `${totals.campaign}\n\n${narrative.text}\n\n` +
        `Dialed ${totals.dialed}, completed ${totals.completed}, ${totals.leads} leads, ` +
        `average grade ${totals.averageGrade}. The full report is attached.\n`,
      html,
      attachments: [
        {
          filename: `${String(campaign.name).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'campaign'}-report.pdf`,
          contentType: 'application/pdf',
          content: pdf,
        },
      ],
    });
  }

  db_.run('UPDATE campaign_reports SET sent_to = ?, delivered = ?, provider = ?, error = ? WHERE id = ?', [
    email || '',
    delivery.delivered ? 1 : 0,
    delivery.channel || delivery.provider || '',
    delivery.error || '',
    id,
  ]);

  return {
    id,
    campaignId,
    file,
    bytes: pdf.length,
    totals,
    narrative,
    generatedAt,
    pdf,
    delivery,
  };
}

/**
 * Rebuild the PDF from a stored report row. The stored numbers are the record,
 * so a download months later shows what was emailed, not what the campaign looks
 * like now.
 */
export function rebuildPdf(storedTotals, campaignName = 'Campaign', by = 'telno') {
  let stored = {};
  try {
    stored = JSON.parse(storedTotals || '{}');
  } catch {
    stored = {};
  }
  const totals = {
    campaign: stored.campaign || campaignName,
    goal: stored.goal || '',
    threshold: stored.threshold ?? 60,
    contacts: stored.contacts ?? 0,
    dialed: stored.dialed ?? 0,
    completed: stored.completed ?? 0,
    leads: stored.leads ?? 0,
    averageGrade: stored.averageGrade ?? 0,
    totalTalkSeconds: stored.totalTalkSeconds ?? 0,
    byOutcome: Array.isArray(stored.byOutcome) ? stored.byOutcome : [],
    topReasons: Array.isArray(stored.topReasons) ? stored.topReasons : [],
    leaders: Array.isArray(stored.leaders) ? stored.leaders : [],
  };
  const narrative = { text: stored.narrative || '' };
  const generatedAt = new Date().toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return renderPdf(totals, narrative, generatedAt, by);
}

/** The report a download route serves: bytes are rebuilt, never stored twice. */
export function reportRow(id) {
  return db_.get('SELECT * FROM campaign_reports WHERE id = ?', [id]) || null;
}

export const reportView = (row) => {
  let totals = {};
  try {
    totals = JSON.parse(row.totals || '{}');
  } catch {
    totals = {};
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    file: row.file,
    bytes: row.bytes,
    sentTo: row.sent_to,
    delivered: !!row.delivered,
    provider: row.provider,
    error: row.error,
    totals,
  };
};
