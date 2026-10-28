import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { normalizeNumber, formatNumber } from '../lib/e164.js';
import { resolveNumber } from '../lib/registry.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import * as v from '../lib/validate.js';
import { logEvent } from '../lib/audit.js';
import { syncNumberToListing } from '../lib/profile.js';
import { applyAfterChange } from '../telephony/index.js';
import * as voipms from '../lib/carriers/voipms.js';
import {
  chargesForNumber,
  daysUntil,
  isRented,
  monthPeriod,
  nextPeriod,
  numberViewCost,
  parseBillingDate,
  recordRentalCharge,
  rentalCosts,
  rentalCostsForAccount,
  voidFutureCharges,
} from '../lib/rentals.js';

/**
 * The number provider, as the console sees it.
 *
 * Buying a DID is two writes in two places that can disagree: the carrier holds
 * the number and bills for it, and this database holds the line, its owner and
 * what it costs. The order that keeps those honest is carrier first, then row —
 * a failed insert is recoverable, an unrecorded purchase is not — and the
 * inventory endpoint exists to find the cases where they drifted anyway.
 *
 * The provider is optional. With no credentials every route here answers a plain
 * "not connected" and the console keeps working with operator-entered numbers.
 */

const numberCostView = (row) => ({
  id: row.id,
  e164: row.e164,
  display: formatNumber(row.e164),
  status: row.status,
  source: row.source,
  accountId: row.account_id || '',
  ...numberViewCost(row),
  // Renews in N days is what an operator acts on; the date itself is the proof.
  renewsInDays: daysUntil(row.next_billing_at),
});

const accountByEmail = (email) => {
  if (!email) return null;
  const row = db_.get('SELECT id, email, name FROM accounts WHERE email = ?', [email]);
  if (!row) throw notFound(`No account with the email ${email}`);
  return row;
};

/** A DID already rented on this platform cannot be bought twice. */
const heldHere = (e164) =>
  db_.get("SELECT * FROM numbers WHERE e164 = ? AND provider <> '' AND released_at IS NULL", [e164]);

export default async function carrierRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  /**
   * Connection state, defaults and this month's rent in one read.
   *
   * The balance is fetched live, so this answers "can I buy a number right now"
   * rather than "was it configured at boot".
   */
  app.get('/provider/voipms', async (request) => {
    const status = await voipms.providerStatus();
    const period = monthPeriod();
    const held = db_.all(
      "SELECT * FROM numbers WHERE provider = 'voipms' AND released_at IS NULL ORDER BY e164"
    );
    const costs = rentalCosts({ period });
    const account = v.str(request.query?.account, { name: 'account', max: 160, required: false });
    const own = account
      ? (() => {
          const target = accountByEmail(account);
          return { account: target.email, ...rentalCostsForAccount(target.id, { period }) };
        })()
      : null;

    return {
      ...status,
      period,
      held: held.length,
      heldNumbers: held.map(numberCostView),
      // What the platform pays this month for numbers, and who carries it.
      costs: {
        period: costs.period,
        totalCents: costs.totalCents,
        currency: costs.currency,
        accounts: costs.accounts.length,
        unassigned: costs.unassigned.length,
      },
      account: own,
    };
  });

  /** Available DIDs, searched by area code (or any prefix) and state/province. */
  app.get('/provider/voipms/search', async (request) => {
    const query = request.query || {};
    const country = v.oneOf(String(query.country || 'US').toUpperCase(), ['US', 'CA'], 'country');
    const region = v.str(query.region || query.state, { name: 'region', max: 2, required: false }).toUpperCase();
    const search = v.str(query.q || query.query, { name: 'q', max: 20, required: true });
    const searchType = v.oneOf(query.type || 'starts', ['starts', 'contains', 'ends'], 'type');
    const limit = v.integer(query.limit, { name: 'limit', min: 1, max: 200, required: false, fallback: 25 });

    const result = await voipms.searchNumbers({ country, region, query: search, searchType, limit });
    const unavailable = new Set(
      db_.all("SELECT e164 FROM numbers WHERE provider = 'voipms' AND released_at IS NULL").map((row) => row.e164)
    );
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, alreadyHeld: unavailable.has(item.e164) })),
    };
  });

  /**
   * Order one or more DIDs.
   *
   * Each DID is bought at the carrier, then recorded here with its price and its
   * account. A failure on one DID is reported against that DID and the rest are
   * still attempted: a batch that stops halfway leaves numbers paid for and
   * unrecorded, which is the worse outcome.
   */
  app.post('/provider/voipms/numbers', { preHandler: requireWrite }, async (request, reply) => {
    const body = request.body || {};
    const raw = Array.isArray(body.dids) ? body.dids : body.did ? [body.did] : [];
    if (!raw.length) throw badRequest('Name at least one number to order');
    if (raw.length > 10) throw badRequest('Order at most ten numbers at a time');

    const account = accountByEmail(v.email(body.account, { required: false }));
    const routing = v.str(body.routing, { name: 'routing', max: 120, required: false });
    const pop = body.pop === undefined ? undefined : v.integer(body.pop, { name: 'pop', min: 1, max: 100 });
    const dialTime = body.dialTime === undefined ? undefined : v.integer(body.dialTime, { name: 'dialTime', min: 5, max: 600 });
    const cnam = body.cnam === undefined ? undefined : v.bool(body.cnam, false);
    const billingType = body.billingType === undefined ? undefined : v.integer(body.billingType, { name: 'billingType', min: 1, max: 2 });
    const currency = (v.str(body.currency, { name: 'currency', max: 3, required: false }) || '').toUpperCase();
    // 0 is allowed and means "not priced yet": the console then asks for a price
    // rather than inventing one.
    const monthlyCostCents = v.integer(body.monthlyCostCents, {
      name: 'monthlyCostCents',
      min: 0,
      max: 10_000_00,
      required: false,
      fallback: undefined,
    });

    const ordered = [];
    const failed = [];
    const actor = request.account?.email || request.apiKey?.label || 'api';

    // Order of refusals matters to whoever is reading them: what they typed,
    // then whether the carrier is connected at all, then a missing routing
    // target. Answering "routing required" to a deployment with no provider
    // would send an operator chasing the wrong problem.
    const wanted = [];
    for (const entry of raw) {
      const parsed = normalizeNumber(entry);
      if (!parsed.ok) {
        failed.push({ did: String(entry), error: parsed.reason || 'not a usable number' });
        continue;
      }
      if (heldHere(parsed.e164)) {
        failed.push({ did: parsed.e164, error: 'already rented on this platform' });
        continue;
      }
      wanted.push(parsed.e164);
    }
    if (!wanted.length) {
      reply.status(400);
      return { ordered: [], failed, period: monthPeriod(), message: 'No numbers were ordered — see the failures for why' };
    }

    voipms.assertConfigured();
    // The vault is asked as well as the environment: a routing target entered in
    // Settings → Numbers from VoIP.ms is the intended way to set this without a
    // redeploy.
    if (!routing && !voipms.voipmsRouting()) {
      throw badRequest(
        'VoIP.ms needs to know where the DID rings. Store VOIPMS_ROUTING in Settings → Numbers from VoIP.ms (for example account:100001_telno) or pass a routing value with the order.'
      );
    }

    for (const e164 of wanted) {
      try {
        await voipms.orderNumber(e164, { routing, pop, dialTime, cnam, billingType, note: account?.email || '' });
      } catch (err) {
        failed.push({ did: e164, error: err.message, code: err.code || 'provider_error' });
        continue;
      }

      // What the carrier says about the DID it just sold. Best effort: the
      // number is already bought, so a read failure must not lose the record.
      let info = null;
      try {
        info = await voipms.numberInfo(e164);
      } catch {
        info = null;
      }

      // The price is the operator's, defaulting to the deployment's rate: the
      // carrier reports what it charges us for the DID, not what it should cost
      // this customer, so it is never used as the billed amount.
      const cost = monthlyCostCents === undefined ? config.voipms.monthlyCostCents : monthlyCostCents;
      const resolved = resolveNumber(e164, {
        source: 'voipms',
        status: 'active',
        carrier: 'voip.ms',
        lineType: 'voip',
        region: info?.description || '',
        // A rented line is somebody's private number until they list it, so it
        // never lands in the worldwide directory by being bought.
        visibility: 'unlisted',
      });

      const stamp = now();
      const nextBilling =
        parseBillingDate(info?.nextBillingAt) ||
        (() => {
          // No date from the carrier: the next period boundary is the honest
          // answer, and it is what the charge sweep will act on.
          const period = nextPeriod();
          return `${period}-01T00:00:00.000Z`;
        })();

      db_.run(
        `UPDATE numbers
            SET provider = 'voipms', provider_ref = ?, status = 'active',
                monthly_cost_cents = ?, cost_currency = ?, rented_at = ?, next_billing_at = ?,
                account_id = ?, carrier = 'voip.ms', updated_at = ?
          WHERE id = ?`,
        [
          voipms.providerDid(e164),
          cost,
          currency || config.voipms.currency,
          stamp,
          nextBilling,
          account?.id || null,
          stamp,
          resolved.id,
        ]
      );

      const row = db_.get('SELECT * FROM numbers WHERE id = ?', [resolved.id]);
      // The month it was bought in is rent that is already owed.
      recordRentalCharge(row, { period: monthPeriod() });
      // Bought for a customer who already asked to be listed: the number they
      // now hold joins their directory entry instead of sitting unlisted.
      if (account) syncNumberToListing(row.id);

      logEvent({ actor, action: 'provider.number_ordered', subject: e164, detail: JSON.stringify({ account: account?.email || '', cost: row.monthly_cost_cents }), ip: request.ip });
      ordered.push({ ...numberCostView(row), charges: chargesForNumber(row.id, 3) });
    }

    const applied = await applyAfterChange(request);
    reply.status(ordered.length ? 201 : 400);
    return {
      ordered,
      failed,
      applied: applied || null,
      period: monthPeriod(),
      message: ordered.length
        ? `${ordered.length} number(s) bought and recorded`
        : 'No numbers were ordered — see the failures for why',
    };
  });

  /**
   * Release a DID back to the carrier.
   *
   * The order matters in reverse: cancel at the carrier first, and only then
   * retire the line. Retiring first would leave the platform believing a number
   * was free while the carrier kept billing for it.
   */
  app.delete('/provider/voipms/numbers/:value', { preHandler: requireWrite }, async (request) => {
    const row = db_.get(
      "SELECT * FROM numbers WHERE (id = ? OR e164 = ?) AND provider <> ''",
      [request.params.value, request.params.value]
    );
    if (!row) throw notFound('No rented number matches that');
    if (row.released_at) throw conflict(`${row.e164} was already released on ${row.released_at.slice(0, 10)}`);

    const comment = v.str(request.body?.comment, { name: 'comment', max: 200, required: false });
    await voipms.releaseNumber(row.e164, { comment: comment || `Released from the Telno console by ${request.account?.email || 'api'}` });

    const stamp = now();
    db_.run(
      `UPDATE numbers
          SET status = 'retired', released_at = ?, account_id = NULL, updated_at = ?
        WHERE id = ?`,
      [stamp, stamp, row.id]
    );
    // Rent already incurred stays on the account's record; nothing after this
    // month is charged again.
    const voided = voidFutureCharges(row.id);

    logEvent({ actor: request.account?.email || request.apiKey?.label || 'api', action: 'provider.number_released', subject: row.e164, detail: JSON.stringify({ voided }), ip: request.ip });
    const applied = await applyAfterChange(request);
    const fresh = db_.get('SELECT * FROM numbers WHERE id = ?', [row.id]);
    return { number: numberCostView(fresh), voidedCharges: voided, applied: applied || null };
  });

  /**
   * What the carrier holds against what this platform has recorded.
   *
   * Numbers bought in the provider's own portal (or from before this platform
   * was pointed at it) show up as `unknownLocally`; rows whose DID the carrier
   * no longer has show up as `missingAtProvider`. Neither is changed by reading.
   */
  app.get('/provider/voipms/inventory', async () => {
    const provider = await voipms.inventory();
    const providerSet = new Set(provider.map((item) => item.e164).filter(Boolean));
    const local = db_.all("SELECT * FROM numbers WHERE provider = 'voipms' ORDER BY e164");
    const localSet = new Set(local.map((row) => row.e164));

    return {
      provider: provider.length,
      local: local.length,
      unknownLocally: provider.filter((item) => item.e164 && !localSet.has(item.e164)),
      missingAtProvider: local.filter((row) => !row.released_at && !providerSet.has(row.e164)).map(numberCostView),
      releasedStillHeld: local
        .filter((row) => row.released_at && providerSet.has(row.e164))
        .map(numberCostView),
      checkedAt: now(),
    };
  });

  /**
   * Rent, per account, for a month. This is the ledger the bill reads: what a
   * customer's lines cost, whether we recorded it automatically or by hand.
   */
  app.get('/provider/voipms/costs', async (request) => {
    const period = v.str(request.query?.period, { name: 'period', max: 7, required: false }) || monthPeriod();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('period must look like 2026-10');

    const account = v.str(request.query?.account, { name: 'account', max: 160, required: false });
    if (account) {
      const target = accountByEmail(account);
      return { account: target.email, ...rentalCostsForAccount(target.id, { period }) };
    }
    return rentalCosts({ period });
  });

  /** One rented line's rent history, newest month first. */
  app.get('/provider/voipms/numbers/:value/charges', async (request) => {
    const row = db_.get('SELECT * FROM numbers WHERE id = ? OR e164 = ?', [request.params.value, request.params.value]);
    if (!row) throw notFound('Number not found');
    return {
      number: numberCostView(row),
      rented: isRented(row),
      charges: chargesForNumber(row.id),
    };
  });
}
