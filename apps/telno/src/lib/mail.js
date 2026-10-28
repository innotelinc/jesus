/**
 * Mail templates.
 *
 * Each template returns `{ subject, text, html }`. The text part is not a
 * courtesy: a provider that accepts only text, a client that strips HTML and a
 * log line all read it, and an invoice that arrives unreadable is worse than
 * one that arrives plain. Both parts are built from the same row, so the amount
 * in the subject, the HTML and the text cannot drift apart.
 *
 * The markup is deliberately old-fashioned — tables, inline styles, no web
 * fonts, no external images — because mail clients are not browsers. Nothing
 * here is interactive: a total and a date have to survive Outlook.
 *
 * Formatting is US: dollars first, dates as MM/DD/YYYY, times on a 12-hour
 * clock.
 */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Minor units to a string, in the invoice's own currency. */
export function money(cents, currency = 'USD') {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    // An unknown currency code must not lose the number.
    return `$${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * A calendar day, written the way an American reads it: 02/14/2026.
 *
 * A stored date is an instant; a period is a day. Formatting in UTC keeps
 * "February 1" from becoming "January 31" for a reader west of Greenwich.
 */
export function day(value) {
  if (!value) return '';
  const date = new Date(String(value).length === 10 ? `${String(value)}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dateOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${dateOfMonth}/${date.getUTCFullYear()}`;
}

const STATUS_COPY = {
  open: { label: 'Due', tone: '#635bff', background: '#eeecff' },
  overdue: { label: 'Overdue', tone: '#b42318', background: '#fee4e2' },
  paid: { label: 'Paid', tone: '#027a48', background: '#d1fadf' },
  void: { label: 'Void', tone: '#475467', background: '#f2f4f7' },
  draft: { label: 'Draft', tone: '#475467', background: '#f2f4f7' },
};

const rowHtml = ([label, value], { mono = false } = {}) => `<tr>
            <td style="padding:9px 0;color:#667085;width:38%;border-bottom:1px solid #f2f4f7;">${escapeHtml(label)}</td>
            <td style="padding:9px 0;border-bottom:1px solid #f2f4f7;font-weight:600;${mono ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' : ''}">${escapeHtml(value)}</td>
          </tr>`;

/**
 * The one card both billing emails are built on. Extracting it is what keeps a
 * reminder and an invoice from diverging: same branding, same row rhythm, same
 * legibility on a phone.
 */
function card({ eyebrow, amount, pill, pillTone, pillBackground, intro, rows, items = [], currency = 'USD', totalLabel, total, notes, footer, cta }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(eyebrow)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e4e7ec;">
    <tr>
      <td style="padding:22px 28px 0 28px;">
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">tel<span style="color:#635bff;">no</span></div>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 28px 0 28px;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#667085;">${escapeHtml(eyebrow)}</div>
        <div style="font-size:34px;font-weight:700;letter-spacing:-0.03em;margin-top:6px;">${escapeHtml(amount)}</div>
        <div style="margin-top:10px;">
          <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${pillTone};background:${pillBackground};">
            ${escapeHtml(pill)}
          </span>
        </div>
        ${
          intro
            ? `<div style="margin-top:14px;font-size:14px;line-height:1.6;color:#344054;">${escapeHtml(intro)}</div>`
            : ''
        }
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px 0 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
          ${rows.map((row) => rowHtml(row, { mono: row[0] === 'Invoice' })).join('')}
          <tr>
            <td style="padding:12px 0 0 0;color:#667085;">${escapeHtml(totalLabel)}</td>
            <td style="padding:12px 0 0 0;font-size:18px;font-weight:700;text-align:right;">${escapeHtml(total)}</td>
          </tr>
        </table>
      </td>
    </tr>
    ${
      items.length
        ? `<tr>
      <td style="padding:18px 28px 0 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;border-collapse:collapse;">
          <tr>
            <td style="padding:0 0 6px 0;color:#667085;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">What this bill covers</td>
            <td style="padding:0 0 6px 0;color:#667085;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;text-align:right;">Amount</td>
          </tr>
          ${items
            .map(
              (item) => `<tr>
            <td style="padding:7px 0;border-top:1px solid #f2f4f7;color:#344054;line-height:1.5;">${escapeHtml(item.description)}${
              Number(item.quantity) > 1 ? ` <span style="color:#98a2b3;">× ${escapeHtml(item.quantity)}</span>` : ''
            }</td>
            <td style="padding:7px 0;border-top:1px solid #f2f4f7;text-align:right;font-weight:600;white-space:nowrap;color:${
              (item.settledBy ?? item.settled_by) === 'subscription' ? '#98a2b3' : 'inherit'
            };">${escapeHtml(
              (item.settledBy ?? item.settled_by) === 'subscription' ? 'Included' : money(item.amount_cents ?? item.amountCents, currency)
            )}</td>
          </tr>`
            )
            .join('')}
        </table>
      </td>
    </tr>`
        : ''
    }
    ${
      cta
        ? `<tr>
      <td style="padding:20px 28px 0 28px;">
        <a href="${escapeHtml(cta.href)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#635bff;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(cta.label)}</a>
        <div style="margin-top:8px;font-size:12px;color:#98a2b3;">Secure payment page. Card details are entered on Stripe, never here.</div>
      </td>
    </tr>`
        : ''
    }
    ${
      notes
        ? `<tr>
      <td style="padding:16px 28px 0 28px;">
        <div style="background:#f9fafb;border:1px solid #eaecf0;border-radius:10px;padding:12px 14px;font-size:13px;color:#475467;white-space:pre-wrap;">${escapeHtml(notes)}</div>
      </td>
    </tr>`
        : ''
    }
    <tr>
      <td style="padding:22px 28px 26px 28px;">
        <div style="font-size:12px;color:#98a2b3;line-height:1.6;">${footer}</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The first message a new account receives.
 *
 * It goes out when the account is created, before anyone has configured
 * anything, so it does not promise a working phone — it says what the account is
 * and what to do first. Deliberately no amount, no invoice number and no "due":
 * a welcome that reads like a bill is the worst first impression this platform
 * can make. That is also why it is not built on the bill card.
 */
export function welcomeEmail(account, { line = {}, signInUrl = '', brand = 'Telno' } = {}) {
  const name = String(account?.name || '').trim() || String(account?.email || '').split('@')[0] || 'there';
  const email = String(account?.email || '');
  // What the account already has, so the message is specific rather than
  // generic: a fresh platform says "no line yet", not "your line is ready".
  const hasLine = Number(line.lines || 0) > 0;
  const number = line.numbers ? `${line.numbers} number${line.numbers === 1 ? '' : 's'}` : '';
  const nextSteps = [
    'Open the console and finish the first-run steps: agree to the terms, confirm your details, and verify the email address and phone number on the account.',
    hasLine
      ? `Your line is on the switch${number ? ` with ${number} attached` : ''} — open the softphone to register this browser and place a test call.`
      : 'Create your line and attach a phone number. An extension is the number you dial; the number is what the outside world calls.',
    'Install the SCIF app (or add the softphone to your home screen) to keep the line registered while you work in other tabs.',
  ];

  const subject = `Welcome to ${brand} — here is what to do first`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e4e7ec;">
    <tr>
      <td style="padding:22px 28px 0 28px;">
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">tel<span style="color:#635bff;">no</span></div>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 28px 0 28px;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#667085;">Welcome aboard</div>
        <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;margin-top:6px;">Hello ${escapeHtml(name)}</div>
        <div style="margin-top:12px;font-size:14px;line-height:1.65;color:#344054;">
          This is the account for <strong>${escapeHtml(email)}</strong>. It is the one that holds your line, your number and your bill.
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 28px 0 28px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#667085;padding-bottom:6px;">What to do first</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
          ${nextSteps
            .map(
              (step) => `<tr>
            <td style="padding:9px 0;border-top:1px solid #f2f4f7;color:#344054;line-height:1.6;">${escapeHtml(step)}</td>
          </tr>`
            )
            .join('')}
        </table>
      </td>
    </tr>
    ${
      signInUrl
        ? `<tr>
      <td style="padding:20px 28px 0 28px;">
        <a href="${escapeHtml(signInUrl)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#635bff;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Sign in to the console</a>
        <div style="margin-top:8px;font-size:12px;color:#98a2b3;">${escapeHtml(signInUrl)}</div>
      </td>
    </tr>`
        : ''
    }
    <tr>
      <td style="padding:22px 28px 26px 28px;">
        <div style="font-size:12px;color:#98a2b3;line-height:1.6;">
          You received this because an account was created for this address on ${escapeHtml(brand)}.
          If that was not you, reply to this message and we will close it.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Hello ${name}`,
    '',
    `This is the account for ${email}. It holds your line, your number and your bill.`,
    '',
    'What to do first:',
    ...nextSteps.map((step) => `  - ${step}`),
    ...(signInUrl ? ['', `Sign in: ${signInUrl}`] : []),
    '',
    `You received this because an account was created for this address on ${brand}.`,
  ].join('\n');

  return { subject, text, html };
}

/**
 * The invoice a customer receives: who it is for, what period it covers, the
 * total and — the part people actually look for — when it is due.
 */
export function invoiceEmail(invoice) {
  const amount = money(invoice.amount_cents, invoice.currency);
  // The lines the total is made of. An invoice that says "$14.00" is a demand;
  // one that says what the $14.00 bought is a bill the customer can check.
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const status = STATUS_COPY[invoice.status] || STATUS_COPY.open;
  const due = invoice.status === 'paid' && invoice.paid_at ? `Paid ${day(invoice.paid_at)}` : day(invoice.due_at);
  const period =
    invoice.period_start && invoice.period_end
      ? `${day(invoice.period_start)} – ${day(invoice.period_end)}`
      : '';
  // An invoice that is already settled must not arrive saying "due": the
  // subject is the line a customer reads first, and chasing a paid bill is the
  // fastest way to look like a bad system.
  const subject =
    invoice.status === 'paid'
      ? `Invoice ${invoice.invoice_no} — ${amount} paid ${day(invoice.paid_at) || ''}`.trim()
      : `Invoice ${invoice.invoice_no} — ${amount} due ${day(invoice.due_at) || 'on receipt'}`;

  const rows = [
    ['Invoice', invoice.invoice_no],
    ['Billed to', invoice.account_name],
    period ? ['Period', period] : null,
    day(invoice.issued_at) ? ['Issued', day(invoice.issued_at)] : null,
    ['Status', status.label],
  ].filter(Boolean);

  const html = card({
    eyebrow: `Invoice ${invoice.invoice_no}`,
    amount,
    pill: invoice.status === 'paid' ? due || 'Paid' : `${status.label} ${due}`.trim(),
    pillTone: status.tone,
    pillBackground: status.background,
    rows,
    items,
    currency: invoice.currency || 'USD',
    totalLabel: invoice.status === 'paid' ? 'Paid' : 'Amount due',
    total: amount,
    notes: invoice.notes,
    footer: `${escapeHtml(
      invoice.status === 'paid'
        ? 'Thank you — this invoice is settled.'
        : `Payment is due ${day(invoice.due_at) || 'on receipt'}.`
    )}
          <br>Sent by Telno on behalf of ${escapeHtml(invoice.account_name)}. Quote ${escapeHtml(invoice.invoice_no)} with your payment.`,
  });

  const text = [
    `Invoice ${invoice.invoice_no}`,
    `Amount: ${amount}`,
    // A line the card subscription already collected is named as covered, so
    // the lines still add up to the amount due.
    ...items.map((item) =>
      (item.settledBy ?? item.settled_by) === 'subscription'
        ? `  ${item.description}: included in your subscription`
        : `  ${item.description}: ${money(item.amount_cents ?? item.amountCents, invoice.currency)}`
    ),
    invoice.status === 'paid' && invoice.paid_at ? `Paid: ${day(invoice.paid_at)}` : `Due: ${day(invoice.due_at) || 'on receipt'}`,
    `Account: ${invoice.account_name}`,
    period ? `Period: ${period}` : '',
    invoice.notes ? `\n${invoice.notes}` : '',
    '',
    'Sent by Telno.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text, html };
}

/**
 * A payment reminder, sent by the sweep when an invoice passes a rung on the
 * ladder. The amount and the due date are in the subject, the headline and the
 * text part: a reminder whose point is only in the markup is not a reminder.
 */
export function reminderEmail(invoice, { stageDays = 1, daysPastDue = null } = {}) {
  const amount = money(invoice.amount_cents, invoice.currency);
  const past = Number.isFinite(daysPastDue) ? daysPastDue : stageDays;
  const due = day(invoice.due_at);
  const period =
    invoice.period_start && invoice.period_end
      ? `${day(invoice.period_start)} – ${day(invoice.period_end)}`
      : '';
  const overdueLabel =
    past <= 1 ? '1 day past due' : `${past} days past due`;

  const subject = `Invoice ${invoice.invoice_no} — ${amount} due ${due} (${overdueLabel})`;

  const intro =
    past <= 1
      ? 'Our records show this invoice was not paid by its due date. If payment is already on the way, thank you — no action needed.'
      : `Our records show this invoice is still unpaid ${overdueLabel.replace(' past due', '')} after its due date. Please send payment or reply to this message if something is wrong with the invoice.`;

  const rows = [
    ['Invoice', invoice.invoice_no],
    ['Billed to', invoice.account_name],
    ['Due date', due],
    period ? ['Period', period] : null,
    ['Status', 'Overdue'],
  ].filter(Boolean);

  const html = card({
    eyebrow: `Payment reminder · Invoice ${invoice.invoice_no}`,
    amount,
    pill: overdueLabel,
    pillTone: '#b42318',
    pillBackground: '#fee4e2',
    intro,
    rows,
    totalLabel: 'Amount due',
    total: amount,
    notes: invoice.notes,
    footer: `If you have already sent payment, thank you — you can ignore this reminder.
          <br>Sent by Telno on behalf of ${escapeHtml(invoice.account_name)}. Quote ${escapeHtml(invoice.invoice_no)} with your payment.`,
  });

  const text = [
    `Payment reminder — invoice ${invoice.invoice_no}`,
    `Amount due: ${amount}`,
    `Due date: ${due || 'on receipt'}`,
    `Status: ${overdueLabel}`,
    `Account: ${invoice.account_name}`,
    period ? `Period: ${period}` : '',
    '',
    intro,
    invoice.notes ? `\n${invoice.notes}` : '',
    '',
    'If you have already sent payment, thank you — you can ignore this reminder.',
    'Sent by Telno.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text, html };
}

/**
 * The final notice. It is the only email that changes anything on a date: it
 * names the day the account is suspended, so the action and the warning cannot
 * disagree. The date is passed in rather than computed here — the sweep stores
 * it once and both the email and the suspension read that one value.
 */
export function finalNoticeEmail(invoice, { suspendOn = '', daysPastDue = null, payUrl = '' } = {}) {
  const amount = money(invoice.amount_cents, invoice.currency);
  const due = day(invoice.due_at);
  const stops = day(suspendOn);
  const past = Number.isFinite(daysPastDue) ? daysPastDue : null;
  const overdueLabel = past ? (past === 1 ? '1 day past due' : `${past} days past due`) : 'Past due';

  const subject = stops
    ? `Final notice — invoice ${invoice.invoice_no}, ${amount}: service stops ${stops}`
    : `Final notice — invoice ${invoice.invoice_no}, ${amount} past due`;

  const intro = stops
    ? `This invoice is ${overdueLabel.toLowerCase()} and remains unpaid. Unless payment in full is received by ${stops}, this account and its phone service will be suspended on that date. Extensions on the account stop registering with the switch, and calls to them will not be delivered until the balance is cleared.`
    : `This invoice is ${overdueLabel.toLowerCase()} and remains unpaid. Please contact us before service is affected.`;

  const rows = [
    ['Invoice', invoice.invoice_no],
    ['Billed to', invoice.account_name],
    ['Due date', due || 'on receipt'],
    stops ? ['Pay by', stops] : null,
    stops ? ['Service stops', stops] : null,
    ['Status', overdueLabel],
  ].filter(Boolean);

  const html = card({
    eyebrow: `Final notice · Invoice ${invoice.invoice_no}`,
    amount,
    pill: overdueLabel,
    pillTone: '#b42318',
    pillBackground: '#fee4e2',
    intro,
    rows,
    totalLabel: 'Balance due',
    total: amount,
    notes: invoice.notes,
    cta: payUrl ? { label: `Pay ${amount} now`, href: payUrl } : null,
    footer: `${stops ? `Payment received by ${escapeHtml(stops)} clears this notice and nothing is suspended. ` : ''}Service is restored automatically, in full, as soon as the balance is cleared — there is no reactivation fee to argue about.
          <br>If something is wrong with this invoice, reply to this message before ${stops ? escapeHtml(stops) : 'service is affected'} and we will hold the account while it is sorted out.
          <br>Sent by Telno on behalf of ${escapeHtml(invoice.account_name)}. Quote ${escapeHtml(invoice.invoice_no)} with your payment.`,
  });

  const text = [
    `FINAL NOTICE — invoice ${invoice.invoice_no}`,
    `Balance due: ${amount}`,
    `Due date: ${due || 'on receipt'}`,
    stops ? `Pay by: ${stops}` : '',
    stops ? `Service stops: ${stops}` : '',
    `Status: ${overdueLabel}`,
    `Account: ${invoice.account_name}`,
    '',
    intro,
    invoice.notes ? `\n${invoice.notes}` : '',
    '',
    payUrl ? `Pay online: ${payUrl}` : '',
    stops ? `Payment received by ${stops} clears this notice and nothing is suspended.` : '',
    'Service is restored automatically, in full, as soon as the balance is cleared.',
    `If something is wrong with this invoice, reply to this message${stops ? ` before ${stops}` : ''} and we will hold the account while it is sorted out.`,
    'Sent by Telno.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text, html };
}

/**
 * The email that follows the switch-off. Silence would be cheaper and worse:
 * a customer whose phones stopped has to be told what stopped, what it takes to
 * restore it, and that restoration is automatic.
 */
export function suspensionEmail({
  accountName,
  email,
  amount,
  currency = 'USD',
  suspendOn = '',
  suspendedAt = '',
  extensionCount = 0,
  invoiceNumbers = [],
  payUrl = '',
}) {
  const balance = amount === undefined ? '' : money(amount, currency);
  const stopped = day(suspendedAt) || day(new Date());
  const promised = day(suspendOn);

  const subject = balance
    ? `Service suspended — ${balance} past due on this account`
    : 'Service suspended — balance past due on this account';

  const intro = `Phone service on this account was suspended on ${stopped}, after the final notice${promised ? ` dated ${promised}` : ''} went unanswered.${extensionCount ? ` ${extensionCount} ${extensionCount === 1 ? 'extension is' : 'extensions are'} no longer registered with the switch, so calls to those numbers will not be delivered.` : ''} Inbound calls are not being answered, and recorded voicemail is kept — nothing has been deleted.`;

  const rows = [
    ['Account', accountName || email],
    balance ? ['Balance due', balance] : null,
    ['Suspended', stopped],
    promised ? ['Noticed on', promised] : null,
    invoiceNumbers.length ? ['Invoices', invoiceNumbers.slice(0, 5).join(', ')] : null,
    extensionCount ? ['Extensions off', String(extensionCount)] : null,
  ].filter(Boolean);

  const html = card({
    eyebrow: 'Service suspended',
    amount: balance || 'Account',
    pill: 'Suspended',
    pillTone: '#b42318',
    pillBackground: '#fee4e2',
    intro,
    rows,
    totalLabel: 'Balance due',
    total: balance || 'See invoices',
    cta: payUrl ? { label: balance ? `Pay ${balance} now` : 'Pay the balance now', href: payUrl } : null,
    footer: `Payment in full restores service automatically, usually within one sweep of the platform — no call to support is needed to be switched back on.
          <br>To pay or to dispute this balance, reply to this message. Quote ${escapeHtml(invoiceNumbers[0] || email)} with your payment.
          <br>Sent by Telno on behalf of ${escapeHtml(accountName || email)}.`,
  });

  const text = [
    'SERVICE SUSPENDED',
    `Account: ${accountName || email}`,
    balance ? `Balance due: ${balance}` : '',
    `Suspended: ${stopped}`,
    promised ? `Noticed on: ${promised}` : '',
    invoiceNumbers.length ? `Invoices: ${invoiceNumbers.slice(0, 5).join(', ')}` : '',
    extensionCount ? `Extensions off: ${extensionCount}` : '',
    '',
    intro,
    '',
    payUrl ? `Pay online: ${payUrl}` : '',
    'Payment in full restores service automatically, usually within one sweep of the platform.',
    'To pay or to dispute this balance, reply to this message.',
    'Sent by Telno.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text, html };
}
