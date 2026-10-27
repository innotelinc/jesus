import { db_ } from '../db/index.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import {
  applyCheckoutSession,
  checkoutForAccount,
  checkoutForInvoice,
  paymentPage,
  tokenValid,
  verifyWebhook,
} from '../lib/payments.js';
import { billingAccount, reinstateAccount } from '../lib/escalation.js';
import {
  activateFromSession,
  applySubscriptionEvent,
  invoiceSubscriptionId,
  markSubscriptionPastDue,
} from '../lib/subscriptions.js';

/**
 * The public side of billing: the link in an email, and Stripe calling back.
 *
 * Nothing here needs a session — a customer paying a bill has one thing in
 * common with a stranger: neither has a login. The signed token is the whole
 * authority, and it names exactly one invoice or one account.
 */

const WHY = {
  stripe_not_configured: {
    heading: 'Online payment is not switched on yet',
    message:
      'This invoice can still be paid by bank transfer — reply to the message that brought you here and we will send the details.',
    tone: 'warn',
  },
  payments_disabled: {
    heading: 'Online payment is turned off',
    message: 'Reply to the message that brought you here and we will send payment details.',
    tone: 'warn',
  },
  not_payable: {
    heading: 'This invoice does not need paying',
    message: 'It is already settled, or it has been voided. If that is not what you expected, reply to the message that brought you here.',
    tone: 'good',
  },
  amount_too_small: {
    heading: 'This balance is too small to pay online',
    message: 'Card processors have a minimum charge. Reply to the message that brought you here and we will settle it another way.',
    tone: 'info',
  },
  nothing_owed: {
    heading: 'Nothing is owed on this account',
    message: 'There is no open balance, so there is nothing to pay. If service is still off, reply to the message that brought you here.',
    tone: 'good',
  },
};

const problemPage = (error) => {
  const copy = WHY[error] || {
    heading: 'We could not open the payment page',
    message: 'Nothing has been charged. Please try the link again in a moment, or reply to the message that brought you here.',
    tone: 'warn',
  };
  return { ...copy, status: error === 'not_found' ? 404 : 503 };
};

export default async function payRoutes(app) {
  /**
   * The link from a notice. It creates a fresh Checkout Session every time:
   * Stripe sessions expire, links in an old email do not.
   */
  app.get('/public/pay/:kind/:ref', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { kind, ref } = request.params;
    const token = request.query?.t;
    if (!['invoice', 'account'].includes(kind) || !tokenValid(kind, ref, token)) {
      logEvent({ actor: 'public', action: 'billing.pay_link_refused', subject: String(ref).slice(0, 60), ip: request.ip });
      throw forbidden('This payment link is not valid');
    }

    const result =
      kind === 'invoice'
        ? await checkoutForInvoice(db_.get('SELECT * FROM invoices WHERE id = ?', [ref]))
        : await checkoutForAccount(billingAccount(db_.get('SELECT email FROM billing_accounts WHERE id = ?', [ref])?.email));

    if (!result.ok) {
      const page = problemPage(result.error);
      logEvent({
        actor: 'public',
        action: 'billing.pay_link_failed',
        subject: String(ref).slice(0, 60),
        detail: result.error,
        ip: request.ip,
      });
      return reply.status(page.status).type('text/html').send(paymentPage({ title: page.heading, ...page }));
    }
    // 303: the redirect must never be cached, and a refresh must not pay twice.
    return reply.header('cache-control', 'no-store').redirect(result.url, 303);
  });

  /** Where Stripe sends the customer back. Plain HTML: no console, no scripts. */
  app.get('/public/pay/return', async (request, reply) => {
    const status = String(request.query?.status || '');
    const page =
      status === 'paid'
        ? {
            heading: 'Payment received',
            message:
              'Thank you — your payment went through. The invoice is marked paid and any suspended service is restored automatically, usually within a few minutes. Keep the receipt Stripe emails you for your records.',
            tone: 'good',
            action: { label: 'Back to Telno', href: '/' },
          }
        : {
            heading: 'Payment canceled',
            message:
              'Nothing has been charged. The invoice is unchanged and any payment link in your email still works whenever you are ready.',
            tone: 'info',
            action: { label: 'Back to Telno', href: '/' },
          };
    return reply
      .header('cache-control', 'no-store')
      .type('text/html')
      .send(paymentPage({ title: page.heading, ...page }));
  });

  /**
   * Stripe's callback. The body has to be the exact bytes Stripe signed, so this
   * scope parses JSON as a buffer and nothing touches it before verification.
   */
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => done(null, body));

    scope.post('/public/stripe/webhook', async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body || '');
      const verified = verifyWebhook(raw.toString('utf8'), request.headers['stripe-signature']);
      if (!verified.ok) {
        // 400 makes Stripe retry; 200 would silence a real delivery problem.
        logEvent({ actor: 'stripe', action: 'billing.webhook_rejected', detail: verified.error, ip: request.ip });
        return reply.status(400).send({ error: { code: 'bad_signature', message: verified.error } });
      }

      let event = {};
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        throw badRequest('Webhook body is not JSON');
      }

      const session = event?.data?.object || {};
      const type = String(event?.type || '');

      // A standing instruction has its own lifecycle: status and period end live
      // on the subscription object, not on a checkout session.
      if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
        const result = applySubscriptionEvent(session, { deleted: type === 'customer.subscription.deleted' });
        logEvent({
          actor: 'stripe',
          action: 'portal.webhook_subscription',
          subject: session.id || '',
          detail: `${type}${result.ok ? '' : ` · ${result.error}`}`,
          ip: request.ip,
        });
        return { received: true, ...result };
      }
      if (type === 'invoice.payment_failed') {
        // Read from either shape: the endpoint's API version decides whether the
        // subscription is on the invoice itself or under its parent.
        const failedSubscription = invoiceSubscriptionId(session);
        const result = markSubscriptionPastDue(failedSubscription);
        logEvent({
          actor: 'stripe',
          action: 'portal.webhook_payment_failed',
          subject: failedSubscription || String(session.id || ''),
          detail: result.ok ? 'subscription marked past due' : result.error,
          ip: request.ip,
        });
        return { received: true, ...result };
      }

      if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
        return { received: true, ignored: type };
      }
      // Delayed methods can complete an unpaid session; only money counts.
      if (type === 'checkout.session.completed' && session.payment_status && session.payment_status !== 'paid') {
        return { received: true, awaitingPayment: session.payment_status };
      }

      // A subscription checkout creates an account's access, not an invoice.
      if (session.mode === 'subscription' || session?.metadata?.kind === 'subscription') {
        const activated = await activateFromSession(session);
        logEvent({
          actor: 'stripe',
          action: 'portal.subscription_activated',
          subject: String(session?.metadata?.subscriptionId || session.id || ''),
          detail: activated.ok ? `${activated.periodEnd ? `paid to ${activated.periodEnd.slice(0, 10)}` : 'active'}` : activated.error,
          ip: request.ip,
        });
        return { received: true, subscription: activated };
      }

      const applied = applyCheckoutSession(session);
      logEvent({
        actor: 'stripe',
        action: 'billing.webhook_paid',
        subject: applied.reference || session.id || '',
        detail: `${type} · ${applied.paid.length} invoice(s) paid${applied.paid.length ? `: ${applied.paid.join(', ')}` : ''}`,
        ip: request.ip,
      });

      // Paying is supposed to switch service back on by itself; doing it here
      // means the customer does not wait for the next sweep.
      const reinstated = [];
      const email = String(session?.customer_details?.email || session?.customer_email || '').trim();
      if (email) {
        const account = billingAccount(email);
        if (account && account.state === 'suspended' && account.overdueCents === 0) {
          const result = await reinstateAccount(account.email, { actor: 'stripe', reason: 'paid online' });
          if (result.action === 'reinstated') reinstated.push(account.email);
        }
      }

      return { received: true, paid: applied.paid, reinstated };
    });
  });
}
