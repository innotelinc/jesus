import {
  PAYMENT_METHODS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATES,
  addCustomerNote,
  addTicketNote,
  createTicket,
  crmOverview,
  customerDetail,
  listCustomers,
  listTickets,
  recordPayment,
  ticketDetail,
  updateCustomer,
  updateTicket,
} from '../lib/crm.js';
import * as v from '../lib/validate.js';
import { db_ } from '../db/index.js';

/**
 * The operator's customer panel.
 *
 * Staff only, and by construction: customers never see this surface. The auth
 * hook already restricts a customer session to their own paths, and `crm` is
 * not one of them, so a signed-in subscriber reaching here gets 403 rather than
 * a redacted view. Reads also require the `registry:read` scope, so an API key
 * minted for the directory cannot read the customer list.
 */
export default async function crmRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');
  const actorOf = (request) => request.account?.email || request.apiKey?.label || 'api';

  app.get('/crm/overview', async () => crmOverview());

  app.get('/crm/meta', async () => ({
    categories: TICKET_CATEGORIES,
    priorities: TICKET_PRIORITIES,
    states: TICKET_STATES,
    paymentMethods: PAYMENT_METHODS,
    plans: db_.all(
      "SELECT DISTINCT plan_slug AS slug, plan_name AS name FROM subscriptions WHERE plan_slug <> '' ORDER BY plan_name"
    ),
    assignees: db_
      .all("SELECT DISTINCT assignee FROM tickets WHERE assignee <> '' ORDER BY assignee")
      .map((row) => row.assignee),
  }));

  /* ------------------------------------------------------------ customers -- */

  app.get('/crm/customers', async (request) =>
    listCustomers({
      q: v.str(request.query.q, { name: 'q', required: false, max: 120 }),
      state: v.str(request.query.state, { name: 'state', required: false, max: 20 }),
      plan: v.str(request.query.plan, { name: 'plan', required: false, max: 40 }),
      sort: v.str(request.query.sort, { name: 'sort', required: false, max: 20 }),
      limit: v.integer(request.query.limit, { name: 'limit', required: false, min: 1, max: 100, fallback: 25 }),
      offset: v.integer(request.query.offset, { name: 'offset', required: false, min: 0, fallback: 0 }),
    })
  );

  app.get('/crm/customers/:id', async (request) => customerDetail(request.params.id));

  app.patch('/crm/customers/:id', { preHandler: requireWrite }, async (request) => ({
    customer: updateCustomer(request.params.id, request.body || {}, actorOf(request)),
  }));

  app.post('/crm/customers/:id/notes', { preHandler: requireWrite }, async (request, reply) => {
    reply.status(201);
    return { note: addCustomerNote(request.params.id, request.body?.body, actorOf(request)) };
  });

  /**
   * Money that arrived outside the card flow. A payment that covers an open
   * invoice settles it, with the payment itself as the receipt — which is what
   * makes a manual transfer show up on the customer's own bill.
   */
  app.post('/crm/customers/:id/payments', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const payment = recordPayment({
      accountId: request.params.id,
      invoiceId: v.str(body.invoiceId, { name: 'invoiceId', required: false, max: 60 }),
      amountCents: v.integer(body.amountCents, { name: 'amountCents', min: -100_000_000, max: 100_000_000 }),
      method: v.oneOf(body.method || 'manual', PAYMENT_METHODS, 'method'),
      reference: v.str(body.reference, { name: 'reference', required: false, max: 120 }),
      note: v.str(body.note, { name: 'note', required: false, max: 500 }),
      receivedAt: v.str(body.receivedAt, { name: 'receivedAt', required: false, max: 40 }),
      actor: actorOf(request),
    });
    reply.status(201);
    return { payment };
  });

  /* -------------------------------------------------------------- tickets -- */

  app.get('/crm/tickets', async (request) =>
    listTickets({
      state: v.str(request.query.state, { name: 'state', required: false, max: 20 }),
      priority: v.str(request.query.priority, { name: 'priority', required: false, max: 20 }),
      category: v.str(request.query.category, { name: 'category', required: false, max: 30 }),
      assignee: v.str(request.query.assignee, { name: 'assignee', required: false, max: 120 }),
      q: v.str(request.query.q, { name: 'q', required: false, max: 120 }),
      accountId: v.str(request.query.account, { name: 'account', required: false, max: 60 }),
      limit: v.integer(request.query.limit, { name: 'limit', required: false, min: 1, max: 100, fallback: 25 }),
      offset: v.integer(request.query.offset, { name: 'offset', required: false, min: 0, fallback: 0 }),
    })
  );

  app.get('/crm/tickets/:id', async (request) => ticketDetail(request.params.id));

  app.post('/crm/tickets', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const created = createTicket({
      accountId: v.str(body.accountId, { name: 'accountId', required: false, max: 60 }),
      subject: v.str(body.subject, { name: 'subject', min: 3, max: 160 }),
      description: v.str(body.description, { name: 'description', required: false, max: 4000 }),
      category: v.oneOf(body.category || 'support', TICKET_CATEGORIES, 'category'),
      priority: v.oneOf(body.priority || 'normal', TICKET_PRIORITIES, 'priority'),
      assignee: v.str(body.assignee, { name: 'assignee', required: false, max: 120 }),
      numberId: v.str(body.numberId, { name: 'numberId', required: false, max: 60 }),
      dueAt: v.str(body.dueAt, { name: 'dueAt', required: false, max: 40 }),
      actor: actorOf(request),
    });
    reply.status(201);
    return created;
  });

  app.patch('/crm/tickets/:id', { preHandler: requireWrite }, async (request) => {
    const body = request.body || {};
    const patch = {};
    if (body.subject !== undefined) patch.subject = v.str(body.subject, { name: 'subject', min: 3, max: 160 });
    if (body.category !== undefined) patch.category = v.oneOf(body.category, TICKET_CATEGORIES, 'category');
    if (body.priority !== undefined) patch.priority = v.oneOf(body.priority, TICKET_PRIORITIES, 'priority');
    if (body.state !== undefined) patch.state = v.oneOf(body.state, TICKET_STATES, 'state');
    if (body.assignee !== undefined) patch.assignee = v.str(body.assignee, { name: 'assignee', required: false, max: 120 });
    if (body.dueAt !== undefined) patch.dueAt = v.str(body.dueAt, { name: 'dueAt', required: false, max: 40 });
    if (body.numberId !== undefined) patch.numberId = v.str(body.numberId, { name: 'numberId', required: false, max: 60 });
    return updateTicket(request.params.id, patch, actorOf(request));
  });

  app.post('/crm/tickets/:id/notes', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    reply.status(201);
    return addTicketNote(request.params.id, {
      body: v.str(body.body, { name: 'body', min: 1, max: 4000 }),
      kind: v.oneOf(body.kind || 'note', ['note', 'internal'], 'kind'),
      actor: actorOf(request),
    });
  });
}
