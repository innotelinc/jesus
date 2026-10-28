import { useEffect, useState } from 'react';
import { api, clockTime, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Icon,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Stat,
  Tabs,
  Textarea,
  useToast,
} from '../ui.jsx';

const TONE = { paid: 'success', open: 'info', overdue: 'danger', draft: 'neutral', void: 'neutral' };

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format((cents || 0) / 100);

/** A delivery channel or provider as a person reads it. */
const PROVIDER = { resend: 'Resend', mailjet: 'Mailjet', console: 'log', twilio: 'Twilio', unknown: 'unknown' };
const via = (provider) => PROVIDER[provider] || provider || '';

/** Money dates are calendar days: MM/DD/YYYY, in UTC so a due date cannot slip a day. */
const day = (value) => {
  if (!value) return '—';
  const date = new Date(String(value).length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return '—';
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${dayOfMonth}/${date.getUTCFullYear()}`;
};
const dateInput = (value) => (value ? String(value).slice(0, 10) : '');

const toForm = (invoice) => ({
  accountName: invoice.accountName,
  email: invoice.email || '',
  amount: (invoice.amountCents / 100).toFixed(2),
  currency: invoice.currency,
  periodStart: dateInput(invoice.periodStart),
  periodEnd: dateInput(invoice.periodEnd),
  dueAt: dateInput(invoice.dueAt),
  status: invoice.status,
  notes: invoice.notes || '',
});

const BLANK = {
  accountName: '',
  email: '',
  amount: '',
  currency: 'USD',
  periodStart: '',
  periodEnd: '',
  dueAt: '',
  status: 'open',
  notes: '',
};

export default function Billing() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState(BLANK);
  const [history, setHistory] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountSummary, setAccountSummary] = useState(null);
  const [stripeTest, setStripeTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  // The webhook's event list, read on load so a gap is on the page itself.
  const [webhook, setWebhook] = useState(null);
  // The month's rent, and the lines of whichever invoice is open in the dialog.
  const [rent, setRent] = useState(null);
  const [invoiceItems, setInvoiceItems] = useState([]);
  const [lineForm, setLineForm] = useState({ description: '', amount: '' });

  const load = async () => {
    try {
      const [data, dunning, rentData, hookData] = await Promise.all([
        api.get(`/billing/invoices${tab ? `?status=${tab}` : ''}`),
        api.get('/billing/accounts'),
        api.get('/billing/rent'),
        // A convenience, not a dependency: if Stripe is unreachable the
        // invoices still have to load.
        api.get('/billing/payments/webhook').catch(() => null),
      ]);
      setItems(data.items);
      setSummary(data.summary);
      setAccounts(dunning.items || []);
      setAccountSummary(dunning.summary || null);
      setRent(rentData);
      setWebhook(hookData?.webhook || null);
    } catch (err) {
      toast.error('Could not load billing', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const setStatus = async (invoice, status) => {
    setBusy(invoice.id);
    try {
      await api.patch(`/billing/invoices/${invoice.id}`, { status });
      load();
      toast.success(
        `${invoice.invoiceNo} → ${status}`,
        status === 'paid' ? 'Payment timestamp recorded, overriding any previous state.' : ''
      );
    } catch (err) {
      toast.error('Could not update the invoice', err.message);
    } finally {
      setBusy('');
    }
  };

  const openEdit = async (invoice) => {
    setEditing(invoice);
    setForm(toForm(invoice));
    setHistory(null);
    setInvoiceItems([]);
    setLineForm({ description: '', amount: '' });
    try {
      // The list carries a row count, not the rows: the dialog asks for the
      // invoice itself so it can show what the amount is made of.
      const [detail, data] = await Promise.all([
        api.get(`/billing/invoices/${invoice.id}`),
        api.get(`/billing/invoices/${invoice.id}/reminders`),
      ]);
      setEditing(detail.invoice);
      setForm(toForm(detail.invoice));
      setInvoiceItems(detail.invoice.items || []);
      setHistory(data.items);
    } catch {
      setHistory([]);
    }
  };

  const pullRent = async (invoice) => {
    setBusy('rent');
    try {
      const data = await api.post(`/billing/invoices/${invoice.id}/rent`, {});
      setEditing(data.invoice);
      setForm(toForm(data.invoice));
      setInvoiceItems(data.invoice.items || []);
      load();
      toast.success(
        data.billed.added ? `${data.billed.added} rent line(s) added` : 'Nothing left to bill',
        data.billed.added
          ? `This invoice now covers ${money(data.billed.cents, invoice.currency)} of number rent.`
          : 'Every number on this account is already on an invoice for that month.'
      );
    } catch (err) {
      toast.error('Could not pull the rent', err.message);
    } finally {
      setBusy('');
    }
  };

  const addLine = async () => {
    setBusy('line');
    try {
      const amountCents = Math.round(Number(lineForm.amount || 0) * 100);
      const data = await api.post(`/billing/invoices/${editing.id}/items`, {
        description: lineForm.description,
        amountCents,
        unitAmountCents: amountCents,
      });
      setEditing(data.invoice);
      setInvoiceItems(data.invoice.items || []);
      setForm(toForm(data.invoice));
      setLineForm({ description: '', amount: '' });
      load();
      toast.success('Line added', 'The invoice total is now the sum of its lines.');
    } catch (err) {
      toast.error('Could not add that line', err.message);
    } finally {
      setBusy('');
    }
  };

  const removeLine = async (item) => {
    setBusy(`item:${item.id}`);
    try {
      const data = await api.del(`/billing/invoice-items/${item.id}`);
      setEditing(data.invoice);
      setInvoiceItems(data.invoice.items || []);
      setForm(toForm(data.invoice));
      load();
      toast.success(
        'Line removed',
        item.kind === 'number_rent' ? 'That month of rent is back in the ledger, unbilled.' : 'The total was recalculated.'
      );
    } catch (err) {
      toast.error('Could not remove that line', err.message);
    } finally {
      setBusy('');
    }
  };

  const billAllRent = async () => {
    setBusy('rentrun');
    try {
      const data = await api.post('/billing/rent/run', {});
      load();
      const billed = (data.planLines || 0) + (data.billedLines || 0);
      toast.success(
        billed
          ? `${billed} line(s) billed: ${data.planLines || 0} plan, ${data.billedLines || 0} rent`
          : 'Nothing left to bill this month',
        data.invoices.length
          ? data.invoices.map((entry) => `${entry.invoiceNo}${entry.created ? ' (new)' : ''}`).join(', ')
          : 'Every number is already on an invoice for this month.'
      );
    } catch (err) {
      toast.error('Could not bill the rent', err.message);
    } finally {
      setBusy('');
    }
  };

  const sendReminder = async (invoice) => {
    setBusy(invoice.id);
    try {
      const data = await api.post(`/billing/invoices/${invoice.id}/reminder`, {});
      // The ledger the route just wrote is the freshest truth about this
      // invoice: show it in the dialog immediately instead of a stale list.
      setHistory(data.items || null);
      setEditing((current) => (current && current.id === invoice.id ? data.invoice : current));
      load();
      if (data.action === 'sent') {
        // A final notice is not a reminder: it names the day service stops, and
        // the person who clicked it should see that date straight away.
        toast.success(
          data.kind === 'final' ? `Final notice sent for ${invoice.invoiceNo}` : `Reminder sent for ${invoice.invoiceNo}`,
          data.kind === 'final'
            ? `Service stops ${day(data.suspendOn)} unless it is paid.${data.simulated ? ' Delivered to the mail log.' : ''}`
            : data.simulated
              ? `Delivered to the ${data.channel} log — configure a provider to email it.`
              : `Delivered via ${via(data.channel)}.`
        );
      } else if (data.action === 'skipped') {
        // The API says *why* it did not send; passing that through is better
        // than blaming the provider for a decision this screen made.
        const why = {
          paused: 'Reminders are paused for this invoice — resume them first.',
          draft: 'Issue the invoice before reminding anyone about it.',
          'no-email': 'Add a billing email to this invoice first.',
          'no-due-date': 'Set a due date before sending a reminder.',
          paid: 'This invoice is already paid.',
          void: 'This invoice is void.',
          'account-suspended': 'This account is suspended — service is already off.',
          'final-notice': 'The final notice has already gone out for this invoice.',
        }[data.reason] || 'There is nothing to remind about on this invoice.';
        toast.error('No reminder sent', why);
      } else {
        toast.error('Not delivered', data.error || 'The provider rejected the message.');
      }
    } catch (err) {
      toast.error('Could not send the reminder', err.message);
    } finally {
      setBusy('');
    }
  };

  const toggleReminders = async (invoice) => {
    setBusy(invoice.id);
    try {
      const data = await api.patch(`/billing/invoices/${invoice.id}`, { remindersPaused: !invoice.remindersPaused });
      setEditing(data.invoice);
      load();
      toast.success(
        data.invoice.remindersPaused ? `Reminders paused for ${invoice.invoiceNo}` : `Reminders resumed for ${invoice.invoiceNo}`,
        data.invoice.remindersPaused ? 'No reminder will be sent until this is resumed.' : 'The next sweep can remind this invoice.'
      );
    } catch (err) {
      toast.error('Could not change reminders', err.message);
    } finally {
      setBusy('');
    }
  };

  const runReminders = async () => {
    setBusy('sweep');
    try {
      const data = await api.post('/billing/reminders/run', {});
      load();
      const off = data.escalation?.suspended?.length || 0;
      const back = data.escalation?.reinstated?.length || 0;
      toast.success(
        `Reminders checked: ${data.checked}`,
        `${data.sent} sent, ${data.failed} failed, ${data.markedOverdue} marked overdue` +
          `${off ? `, ${off} suspended` : ''}${back ? `, ${back} reinstated` : ''}.`
      );
    } catch (err) {
      toast.error('Could not run the reminders', err.message);
    } finally {
      setBusy('');
    }
  };

  const testStripe = async () => {
    setTesting(true);
    try {
      const data = await api.post('/billing/payments/test', {});
      // The dialog is the detail; the toast is the verdict, so nobody has to
      // read five rows to learn whether the button will work.
      setStripeTest(data);
      if (data.ok) toast.success('Stripe is connected', data.summary);
      else toast.error('Stripe needs attention', data.summary);
    } catch (err) {
      toast.error('Could not test Stripe', err.message);
    } finally {
      setTesting(false);
    }
  };

  /** Re-read the webhook's event list. Cheap: one Stripe read, no probe. */
  const refreshWebhook = async () => {
    try {
      const data = await api.get('/billing/payments/webhook');
      setWebhook(data.webhook);
    } catch {
      // The strip is a convenience. A read that fails because Stripe is down is
      // already described by the strip's own text, so it must not raise a toast
      // over the work the operator came here to do.
    }
  };

  /**
   * Close the gap the test just reported.
   *
   * The endpoint's event list lives in Stripe's dashboard, so a missing event
   * shows up here and is fixed here — the alternative is an operator copying
   * event names out of a dialog into another tab.
   */
  const repairStripe = async () => {
    setRepairing(true);
    try {
      const data = await api.post('/billing/payments/webhook/repair', {});
      toast.success(
        data.changed ? `${data.added.length} event${data.added.length === 1 ? '' : 's'} added in Stripe` : 'Nothing was missing',
        data.changed
          ? data.added.join(', ')
          : data.reason === 'all_events'
            ? 'This endpoint is subscribed to every event.'
            : 'The endpoint already carries every event the platform needs.'
      );
      // One read refreshes the strip. The full test creates and expires a
      // Checkout session, so it is only re-run for the dialog that asked for it
      // — pressing repair on the page must not open one nobody wanted.
      await refreshWebhook();
      if (stripeTest) setStripeTest(await api.post('/billing/payments/test', {}));
    } catch (err) {
      toast.error('Could not update the endpoint', err.message);
      await refreshWebhook();
    } finally {
      setRepairing(false);
    }
  };

  const reinstate = async (account) => {
    setBusy(account.id);
    try {
      const owed = account.overdueCents > 0;
      const data = await api.post(`/billing/accounts/${account.id}/reinstate`, owed ? { force: true } : {});
      load();
      toast.success(
        `${account.email} is back in service`,
        `${data.extensionsRestored} extension(s) re-enabled${data.loginsRestored ? `, ${data.loginsRestored} login(s) unblocked` : ''}.`
      );
    } catch (err) {
      toast.error('Could not reinstate the account', err.message);
    } finally {
      setBusy('');
    }
  };

  const resend = async (invoice) => {
    setBusy(invoice.id);
    try {
      const data = await api.post(`/billing/invoices/${invoice.id}/resend`, {});
      load();
      if (data.sent) {
        toast.success(
          `${invoice.invoiceNo} sent`,
          data.simulated ? `Delivered to the ${data.channel} log — configure a provider to email it.` : `Delivered via ${via(data.channel)}.`
        );
      } else {
        toast.error('Not delivered', data.error || 'The provider rejected the message.');
      }
    } catch (err) {
      toast.error('Could not resend the invoice', err.message);
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    setBusy('new');
    try {
      await api.post('/billing/invoices', {
        accountName: form.accountName,
        email: form.email,
        amountCents: Math.round(Number(form.amount || 0) * 100),
        currency: form.currency,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        dueAt: form.dueAt || undefined,
        status: form.status,
        notes: form.notes,
      });
      setOpen(false);
      setForm(BLANK);
      load();
      toast.success('Invoice created');
    } catch (err) {
      toast.error('Could not create the invoice', err.message);
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      await api.patch(`/billing/invoices/${editing.id}`, {
        accountName: form.accountName,
        email: form.email,
        // A bill built from lines owns its total: sending one by hand would be
        // rejected, and it must not stop a note or a due date from being saved.
        ...(invoiceItems.length ? {} : { amountCents: Math.round(Number(form.amount || 0) * 100) }),
        currency: form.currency,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        dueAt: form.dueAt || undefined,
        status: form.status,
        notes: form.notes,
      });
      setEditing(null);
      setForm(BLANK);
      load();
      toast.success('Invoice updated', `${editing.invoiceNo} saved.`);
    } catch (err) {
      toast.error('Could not save the invoice', err.message);
    } finally {
      setBusy('');
    }
  };

  // Only accounts the dunning system is actually acting on belong in the table:
  // a current account with no warnings is not news.
  const dunning = accounts.filter((account) => account.state !== 'current');

  // A gap the test found that repair can close. It decides whether the dialog's
  // action looks like the next step or just an option.
  const stripeGap =
    !!stripeTest &&
    stripeTest.checks.some(
      (entry) =>
        ['webhook-endpoint', 'webhook-ledger', 'webhook-subscriptions'].includes(entry.id) && entry.state !== 'pass'
    );

  // What the strip says before anyone presses a button. Healthy and
  // unconfigured both stay quiet — a platform with no Stripe key does not have a
  // webhook problem, and a working endpoint is not news.
  const hookAttention = !!webhook && webhook.state !== 'ok' && webhook.state !== 'all_events' && webhook.state !== 'unconfigured';
  const hookTone =
    webhook?.state === 'missing' || webhook?.state === 'not_registered' || webhook?.state === 'disabled' || webhook?.state === 'unreadable'
      ? 'bad'
      : 'warn';
  const hookTitle = {
    missing: 'Stripe is not sending every event this platform needs',
    not_registered: 'No Stripe webhook points at this install',
    disabled: 'The Stripe webhook is switched off',
    unreadable: 'Stripe would not list webhook endpoints',
    unreachable: 'Could not reach Stripe to read the webhook',
  }[webhook?.state] || 'Stripe webhook';
  // What the missing events actually cost, named on the screen. "invoice.paid is
  // missing" means nothing to an operator; "a plan payment will not reach the
  // customer's history" means they can decide whether to fix it now.
  const hookImpact = !!webhook
    ? [
        webhook.missingPayments?.length ? 'an invoice paid through Stripe will never be marked paid' : '',
        webhook.missingLedger?.length ? 'card payments for a plan will not be recorded against the customer' : '',
        webhook.missingSubscriptions?.length ? 'the customer portal will not learn about lapsed subscriptions' : '',
      ]
        .filter(Boolean)
        .join('; ')
    : '';

  const fields = (
    <div className="stack">
      <div className="grid two">
        <Input label="Account" value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} placeholder="Hudson & Vale" />
        <Input
          label="Billing email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="billing@example.com"
          hint="Needed to resend the invoice."
        />
      </div>
      <div className="grid two">
        <Input
          label="Amount"
          type="number"
          min="0"
          step="0.01"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          disabled={invoiceItems.length > 0}
          hint={invoiceItems.length ? 'The sum of the lines below.' : 'Major units; stored as integer cents.'}
        />
        <Select label="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
          <option value="USD">USD</option>
          <option value="CAD">CAD</option>
          <option value="EUR">EUR</option>
        </Select>
      </div>
      <div className="grid two">
        <Input label="Period start" type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
        <Input label="Period end" type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
      </div>
      <div className="grid two">
        <Input label="Due date" type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} hint="Defaults to 14 days." />
        <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="draft">Draft</option>
          <option value="open">Open</option>
          <option value="overdue">Overdue</option>
          <option value="paid">Paid</option>
          <option value="void">Void</option>
        </Select>
      </div>
      <Textarea label="Notes" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
    </div>
  );

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Invoices per currency — edit, resend or settle an invoice by hand"
        actions={
          <div className="row wrap" style={{ gap: 8 }}>
            <Button variant="ghost" icon="mail" loading={busy === 'sweep'} onClick={runReminders} disabled={!summary?.reminders?.enabled}>
              Run reminders now
            </Button>
            <Button variant="primary" icon="plus" onClick={() => { setForm(BLANK); setOpen(true); }}>New invoice</Button>
          </div>
        }
      />

      {hookAttention ? (
        <div className={`inline-notice ${hookTone}`}>
          <Icon name="alert" size={18} />
          <div className="notice-text">
            <strong>{hookTitle}</strong>
            <span>{
              webhook.state === 'missing' && hookImpact
                ? `${webhook.detail} Until it is fixed, ${hookImpact}.`
                : webhook.detail
            }</span>
          </div>
          {webhook.repairable ? (
            <Button variant="primary" size="sm" loading={repairing} onClick={repairStripe}>
              Add missing events
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" loading={testing} onClick={testStripe}>
            Test connection
          </Button>
        </div>
      ) : null}

      <div className="grid stats">
        <Stat label="Open" value={summary?.openCount ?? '—'} foot="Issued, unpaid" />
        <Stat label="Overdue" value={summary?.overdueCount ?? '—'} foot="Past due date" tone={summary?.overdueCount ? 'var(--danger)' : undefined} />
        <Stat label="Paid" value={summary?.paidCount ?? '—'} foot="Settled" />
        <Stat label="Currencies" value={summary?.currencies ?? '—'} foot="Reported separately" />
      </div>

      {summary?.byCurrency?.length ? (
        <Card title="Outstanding by currency" subtitle="Open plus overdue, per currency — never summed across">
          <div className="row wrap" style={{ gap: 10 }}>
            {summary.byCurrency.map((row) => (
              <div key={row.currency} className="panel" style={{ padding: '10px 14px', minWidth: 170 }}>
                <div className="tiny dim">{row.currency}</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>{money(row.openCents, row.currency)}</div>
                <div className="tiny dim">
                  {row.openCount} open{row.overdueCents ? ` · ${money(row.overdueCents, row.currency)} overdue` : ''}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card
        title="Automatic reminders"
        subtitle={
          summary?.reminders?.enabled
            ? `After the due date at ${(summary.reminders.scheduleDays || []).join(', ')} days, at most one per invoice per ${summary.reminders.gapHours}h`
            : 'Off — set REMINDER_ENABLED=true to resume'
        }
        actions={
          summary?.reminders?.lastSentAt ? <span className="tiny dim">Last sent {relativeTime(summary.reminders.lastSentAt)}</span> : null
        }
      >
        <div className="row wrap" style={{ gap: 26 }}>
          <div>
            <div className="tiny dim">Sent</div>
            <div style={{ fontWeight: 600 }}>{summary?.reminders?.sent ?? '—'}</div>
          </div>
          <div>
            <div className="tiny dim">Failed</div>
            <div style={{ fontWeight: 600, color: summary?.reminders?.failed ? 'var(--danger)' : undefined }}>
              {summary?.reminders?.failed ?? '—'}
            </div>
          </div>
          <div>
            <div className="tiny dim">Paused invoices</div>
            <div style={{ fontWeight: 600 }}>{summary?.reminders?.paused ?? '—'}</div>
          </div>
          <div>
            <div className="tiny dim">Sweep</div>
            <div style={{ fontWeight: 600 }}>every {summary?.reminders?.sweepMinutes ?? '—'} min</div>
          </div>
          <p className="tiny dim" style={{ maxWidth: '52ch', margin: 0 }}>
            Reminders go to the billing email as HTML with the amount and the due date. An invoice that becomes
            paid or is paused stops immediately, and a sweep will not send the same day twice.
          </p>
        </div>
      </Card>

      <Card
        title="Escalation"
        subtitle={
          accountSummary?.enabled
            ? `Final notice at ${accountSummary.finalNoticeDays} days past due, service suspended ${accountSummary.graceDays} ${accountSummary.graceDays === 1 ? 'day' : 'days'} later — then restored automatically when paid`
            : 'Off — set ESCALATION_ENABLED=true to warn and suspend again'
        }
        actions={
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            {accountSummary?.nextSuspension ? (
              <span className="tiny dim">Next suspension {day(accountSummary.nextSuspension)}</span>
            ) : null}
            <Button size="sm" variant="ghost" loading={testing} onClick={testStripe}>
              Test Stripe connection
            </Button>
          </div>
        }
      >
        <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
          <Badge tone={summary?.payments?.configured ? 'success' : 'neutral'}>
            {summary?.payments?.configured ? `Cards on · Stripe ${summary.payments.mode}` : 'Card payment off'}
          </Badge>
          <span className="tiny dim">
            {summary?.payments?.configured
              ? `Notices carry a Pay now button to a Stripe page, and Stripe calls ${summary.payments.webhookPath} to mark the invoice paid.`
              : 'Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Settings → Vault to put a Pay now button in the notices.'}
          </span>
        </div>

        <div className="row wrap" style={{ gap: 26, marginBottom: dunning.length ? 14 : 0 }}>
          <div>
            <div className="tiny dim">Warned</div>
            <div style={{ fontWeight: 600 }}>{accountSummary?.scheduled ?? '—'}</div>
          </div>
          <div>
            <div className="tiny dim">Suspended</div>
            <div style={{ fontWeight: 600, color: accountSummary?.suspended ? 'var(--danger)' : undefined }}>
              {accountSummary?.suspended ?? '—'}
            </div>
          </div>
          <div>
            <div className="tiny dim">Final notices sent</div>
            <div style={{ fontWeight: 600 }}>{summary?.reminders?.finalNotices ?? '—'}</div>
          </div>
          <p className="tiny dim" style={{ maxWidth: '56ch', margin: 0 }}>
            A final notice names the exact day service stops and goes out instead of the last reminder, so nobody is
            warned twice. Suspension switches off the account's extensions and blocks its sign-in; the owner account is
            never suspended. Payment restores everything on the next sweep.
          </p>
        </div>

        {dunning.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="align-right">Balance</th>
                  <th>Warned</th>
                  <th>Stops / stopped</th>
                  <th>Switched off</th>
                  <th>State</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {dunning.map((account) => (
                  <tr key={account.id}>
                    <td className="tiny">
                      {account.name || account.email}
                      {account.name ? <div className="tiny dim">{account.email}</div> : null}
                    </td>
                    <td className="align-right tiny mono nowrap">{money(account.overdueCents, account.currency)}</td>
                    <td className="tiny dim nowrap">{account.finalNoticeAt ? day(account.finalNoticeAt) : '—'}</td>
                    <td className="tiny nowrap">
                      {account.state === 'suspended' ? (
                        <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{day(account.suspendedAt)}</span>
                      ) : (
                        day(account.suspendOn)
                      )}
                    </td>
                    <td className="tiny dim nowrap">
                      {account.extensionsOff
                        ? `${account.extensionsOff} ext${account.loginsBlocked ? ` · ${account.loginsBlocked} login` : ''}`
                        : '—'}
                    </td>
                    <td>
                      <Badge tone={account.state === 'suspended' ? 'danger' : 'warning'}>{account.state}</Badge>
                    </td>
                    <td className="align-right">
                      {account.state === 'suspended' || account.overdueCents === 0 ? (
                        <Button size="sm" variant="ghost" icon="check" loading={busy === account.id} onClick={() => reinstate(account)}>
                          {account.overdueCents > 0 ? 'Reinstate anyway' : 'Reinstate'}
                        </Button>
                      ) : (
                        <span className="tiny dim">sweep will suspend</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="tiny dim">No account is in dunning. Everything current is either paid or within its due date.</div>
        )}
      </Card>

      {stripeTest ? (
        <Modal
          title="Stripe connection"
          subtitle={`Checked ${clockTime(stripeTest.checkedAt)} · ${
            stripeTest.mode === 'live' ? 'live mode' : stripeTest.mode === 'test' ? 'test mode' : 'no key'
          }`}
          onClose={() => setStripeTest(null)}
          footer={
            <>
              <Button
                variant={stripeGap ? 'primary' : 'ghost'}
                loading={repairing}
                onClick={repairStripe}
              >
                Add missing events
              </Button>
              <Button variant="ghost" onClick={() => setStripeTest(null)}>
                Close
              </Button>
            </>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <Badge tone={stripeTest.ok ? 'success' : 'danger'}>
                {stripeTest.ok ? 'Connected' : 'Needs attention'}
              </Badge>
              <span className="tiny dim">{stripeTest.summary}</span>
            </div>
            {stripeTest.checks.map((entry) => (
              <div key={entry.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <Badge tone={entry.state === 'pass' ? 'success' : entry.state === 'warn' ? 'warning' : 'danger'}>
                  {entry.state === 'pass' ? 'Pass' : entry.state === 'warn' ? 'Check' : 'Fail'}
                </Badge>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{entry.label}</div>
                  <div className="tiny dim">{entry.detail}</div>
                </div>
              </div>
            ))}
            <div className="tiny dim">
              Webhook to register: <span className="mono">{stripeTest.webhookUrl}</span>
            </div>
          </div>
        </Modal>
      ) : null}

      <Card
        title="Monthly billing"
        subtitle={rent ? `${rent.label} — one invoice per account, plan and number rent together` : 'Plans and rented numbers on one monthly invoice'}
        actions={
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="tiny dim">
              {rent?.uninvoiced?.lines ? `${rent.uninvoiced.lines} line(s) not yet billed` : 'All rent is billed'}
            </span>
            <Button size="sm" variant="ghost" loading={busy === 'rentrun'} disabled={!rent?.enabled} onClick={billAllRent}>
              Bill this month
            </Button>
          </div>
        }
      >
        <div className="row wrap" style={{ gap: 26, alignItems: 'flex-start' }}>
          <div>
            <div className="tiny dim">Unbilled</div>
            <div style={{ fontWeight: 600 }}>
              {money(rent?.uninvoiced?.totalCents ?? 0, rent?.invoices?.[0]?.currency || 'USD')}
            </div>
          </div>
          <div>
            <div className="tiny dim">Invoices this month</div>
            <div style={{ fontWeight: 600 }}>{rent?.invoices?.length ?? 0}</div>
          </div>
          <p className="tiny dim" style={{ maxWidth: '58ch', margin: 0 }}>
            {rent?.enabled
              ? 'Each month every subscriber gets one invoice: the plan fee and the rent for each number they hold, as separate lines. A plan already collected by a card subscription is shown as included, so only the rest is due.'
              : 'Automatic monthly invoicing is off (RENT_INVOICING_ENABLED=false). The ledger still records what each number costs.'}
          </p>
        </div>
      </Card>

      <Card
        title="Invoices"
        bodyClass="tight"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: '', label: 'All' },
              { value: 'open', label: 'Open' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'paid', label: 'Paid' },
              { value: 'draft', label: 'Draft' },
            ]}
          />
        }
      >
        {loading ? (
          <div style={{ padding: 16 }}><Loading rows={5} /></div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Account</th>
                  <th>Period</th>
                  <th className="align-right">Amount</th>
                  <th>Due</th>
                  <th>Sent</th>
                  <th>Reminders</th>
                  <th>Status</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="tiny mono nowrap">{invoice.invoiceNo}</td>
                    <td className="tiny">
                      {invoice.accountName}
                      {invoice.email ? <div className="tiny dim">{invoice.email}</div> : null}
                    </td>
                    <td className="tiny dim nowrap">{day(invoice.periodStart)} – {day(invoice.periodEnd)}</td>
                    <td className="align-right tiny mono nowrap">
                      {money(invoice.amountCents, invoice.currency)}
                      {invoice.itemCount ? <div className="tiny dim">{invoice.itemCount} lines</div> : null}
                      {invoice.rentPeriod ? <div className="tiny dim">rent {invoice.rentPeriod}</div> : null}
                    </td>
                    <td className="tiny dim nowrap" title={invoice.dueAt || ''}>{day(invoice.dueAt)}</td>
                    <td className="tiny dim nowrap">
                      {invoice.lastSentAt ? (
                        <span title={invoice.lastProvider ? `Delivered via ${via(invoice.lastProvider)}` : ''}>
                          {relativeTime(invoice.lastSentAt)}
                          {invoice.lastProvider ? <div className="tiny dim">via {via(invoice.lastProvider)}</div> : null}
                          {invoice.lastSendError ? (
                            <div style={{ color: 'var(--danger)' }} title={invoice.lastSendError}>
                              retry failed
                            </div>
                          ) : null}
                        </span>
                      ) : invoice.lastSendError ? (
                        <span style={{ color: 'var(--danger)' }} title={invoice.lastSendError}>
                          not delivered
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="tiny dim nowrap">
                      <div className="row wrap" style={{ gap: 6 }}>
                        {invoice.remindersPaused ? <Badge tone="warning">paused</Badge> : null}
                        {invoice.accountState === 'suspended' ? <Badge tone="danger">suspended</Badge> : null}
                        {invoice.finalNoticeAt ? (
                          <Badge tone="danger">final notice</Badge>
                        ) : invoice.remindersPaused || invoice.accountState === 'suspended' ? null : invoice.reminderCount ? (
                          <span title={invoice.lastRemindedAt ? `Last ${day(invoice.lastRemindedAt)}` : ''}>
                            {invoice.reminderCount} sent
                            {invoice.lastRemindedAt ? ` · ${relativeTime(invoice.lastRemindedAt)}` : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </div>
                    </td>
                    <td><Badge tone={TONE[invoice.status]}>{invoice.status}</Badge></td>
                    <td className="align-right">
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="ghost" icon="edit" onClick={() => openEdit(invoice)}>
                          Edit
                        </Button>
                        {['open', 'overdue'].includes(invoice.status) && invoice.email && !invoice.remindersPaused ? (
                          <Button size="sm" variant="ghost" icon="mail" loading={busy === invoice.id} onClick={() => sendReminder(invoice)}>
                            Remind
                          </Button>
                        ) : null}
                        {invoice.status !== 'void' ? (
                          <Button size="sm" variant="ghost" icon="mail" loading={busy === invoice.id} onClick={() => resend(invoice)}>
                            Resend
                          </Button>
                        ) : null}
                        {invoice.status !== 'paid' ? (
                          <Button size="sm" variant="ghost" icon="check" loading={busy === invoice.id} onClick={() => setStatus(invoice, 'paid')}>
                            Mark paid
                          </Button>
                        ) : (
                          <span className="tiny dim">paid {day(invoice.paidAt)}</span>
                        )}
                        {invoice.status === 'draft' ? (
                          <Button size="sm" variant="ghost" loading={busy === invoice.id} onClick={() => setStatus(invoice, 'open')}>
                            Issue
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="card" title="No invoices" action={<Button variant="primary" onClick={() => setOpen(true)}>Create one</Button>}>
            Amounts are stored in minor units, so totals cannot drift when they are summed.
          </Empty>
        )}
      </Card>

      {open ? (
        <Modal
          title="New invoice"
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy === 'new'}
                disabled={!form.accountName.trim() || !form.periodStart || !form.periodEnd}
                onClick={create}
              >
                Create invoice
              </Button>
            </>
          }
        >
          {fields}
        </Modal>
      ) : null}

      {editing ? (
        <Modal
          title={`Edit ${editing.invoiceNo}`}
          subtitle="Every field is editable; marking it paid records the payment timestamp"
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'save'} onClick={save}>
                Save changes
              </Button>
            </>
          }
        >
          {fields}

          <div className="panel stack" style={{ gap: 10, marginTop: 14 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'baseline' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="field-label">What this bill covers</div>
                <div className="tiny dim">
                  {invoiceItems.length
                    ? (() => {
                        const lines = invoiceItems.reduce((total, item) => total + Number(item.amountCents || 0), 0);
                        const covered = invoiceItems
                          .filter((item) => item.settledBy === 'subscription')
                          .reduce((total, item) => total + Number(item.amountCents || 0), 0);
                        // One bill, two facts: what it covers and what is left
                        // to collect. A plan the card already paid is not due.
                        return covered
                          ? `${invoiceItems.length} line(s) totaling ${money(lines, editing.currency)}: ${money(
                              covered,
                              editing.currency
                            )} already collected by the subscription, ${money(
                              editing.amountCents,
                              editing.currency
                            )} due.`
                          : `${invoiceItems.length} line(s), adding up to ${money(
                              editing.amountCents,
                              editing.currency
                            )}.`;
                      })()
                    : 'No breakdown yet — this invoice is one amount.'}
                </div>
              </div>
              {editing.accountId && !['void', 'paid'].includes(editing.status) ? (
                <Button size="sm" variant="ghost" icon="download" loading={busy === 'rent'} onClick={() => pullRent(editing)}>
                  Pull number rent
                </Button>
              ) : null}
            </div>
            {invoiceItems.map((item) => (
              <div key={item.id} className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <Badge tone={item.kind === 'number_rent' ? 'info' : 'neutral'}>{item.kind.replace('_', ' ')}</Badge>
                <span className="tiny" style={{ flex: 1, minWidth: 180 }}>{item.description}</span>
                <span className="tiny mono" style={item.settledBy === 'subscription' ? { opacity: 0.65 } : undefined}>
                  {item.settledBy === 'subscription' ? 'Included' : money(item.amountCents, editing.currency)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  loading={busy === `item:${item.id}`}
                  onClick={() => removeLine(item)}
                >
                  Remove
                </Button>
              </div>
            ))}
            {editing.status !== 'void' ? (
              <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Input
                    label="Add a line"
                    value={lineForm.description}
                    onChange={(e) => setLineForm({ ...lineForm, description: e.target.value })}
                    placeholder="Equipment rental"
                  />
                </div>
                <div style={{ width: 130 }}>
                  <Input
                    label="Amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={lineForm.amount}
                    onChange={(e) => setLineForm({ ...lineForm, amount: e.target.value })}
                  />
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === 'line'}
                  disabled={!lineForm.description.trim() || !lineForm.amount}
                  onClick={addLine}
                >
                  Add line
                </Button>
              </div>
            ) : null}
          </div>

          <div className="panel stack" style={{ gap: 10, marginTop: 14 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="field-label">Payment reminders</div>
                <div className="tiny dim">
                  {editing.finalNoticeAt
                    ? `Final notice sent ${day(editing.finalNoticeAt)} — service stops if the balance is not paid.`
                    : editing.remindersPaused
                      ? 'Paused — no reminder is sent until this is resumed.'
                      : `Automatic after the due date at ${(summary?.reminders?.scheduleDays || []).join(', ')} days, then a final notice at ${summary?.escalation?.finalNoticeDays ?? '—'}.`}
                </div>
              </div>
              <Button size="sm" variant="ghost" loading={busy === editing.id} onClick={() => toggleReminders(editing)}>
                {editing.remindersPaused ? 'Resume reminders' : 'Pause reminders'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="mail"
                disabled={!editing.email || ['paid', 'void', 'draft'].includes(editing.status) || editing.remindersPaused || !!editing.finalNoticeAt}
                loading={busy === editing.id}
                onClick={() => sendReminder(editing)}
              >
                Send reminder now
              </Button>
            </div>
            <div className="tiny dim">
              {editing.lastSentAt
                ? `Last invoice email ${relativeTime(editing.lastSentAt)}${
                    editing.lastProvider ? ` via ${via(editing.lastProvider)}` : ''
                  }.`
                : 'This invoice has not been emailed yet.'}
              {editing.lastSendError ? (
                <span style={{ color: 'var(--danger)' }}> The last attempt failed: {editing.lastSendError}</span>
              ) : null}
            </div>
            {editing.payUrl ? (
              <div className="row wrap" style={{ gap: 8 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div className="field-label">Payment link</div>
                  <div className="tiny mono truncate" title={editing.payUrl}>{editing.payUrl}</div>
                  <div className="tiny dim">Opens a Stripe page for this invoice. The final notice carries it as a Pay now button.</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(editing.payUrl);
                      toast.success('Payment link copied');
                    } catch {
                      toast.error('Could not copy the link', 'Select the text and copy it by hand.');
                    }
                  }}
                >
                  Copy link
                </Button>
              </div>
            ) : null}
            <div className="stack" style={{ gap: 6 }}>
              {history === null ? (
                <Loading rows={2} />
              ) : history.length ? (
                history.map((row) => (
                  <div key={row.id} className="row wrap" style={{ gap: 8 }}>
                    <Badge tone={row.status === 'sent' ? 'success' : row.status === 'failed' ? 'danger' : 'neutral'}>
                      {row.status}
                    </Badge>
                    <span className="tiny">
                      {row.kind === 'final' ? (row.status === 'skipped' ? 'final notice passed over' : 'final notice') : `${row.stageDays}d past due`}
                    </span>
                    <span className="tiny dim truncate">{row.to}</span>
                    {row.status !== 'skipped' && row.provider ? (
                      <Badge tone={row.provider === 'console' ? 'neutral' : 'info'}>via {via(row.provider)}</Badge>
                    ) : null}
                    <span className="tiny dim right mono">
                      {day(row.at)} {clockTime(row.at)}
                    </span>
                    {row.error ? <span className="tiny" style={{ color: 'var(--danger)', width: '100%' }}>{row.error}</span> : null}
                  </div>
                ))
              ) : (
                <span className="tiny dim">No reminder has been sent for this invoice yet.</span>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
