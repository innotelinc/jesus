import { db_, now } from '../db/index.js';
import { formatNumber } from './e164.js';
import { addListing, normalizeName } from './registry.js';
import { badRequest } from './errors.js';
import * as v from './validate.js';

/**
 * Who the customer is, and whether the world may see their number.
 *
 * A subscriber's first visit used to drop them straight onto a softphone with a
 * blank profile they could not edit — so the directory either knew nothing about
 * them or, worse, knew something an operator typed. This module makes the
 * customer the source: they confirm their details once, then state whether their
 * numbers may appear in the public directory. The choice is stored on the
 * account so it can be honored for numbers assigned later, and reversed on
 * request rather than being a one-way door.
 */

/** Kinds a customer may pick for their own listing. Emergency lines are ours. */
export const SELF_KINDS = ['person', 'business', 'service'];

const ownNumbers = (accountId) =>
  db_.all('SELECT * FROM numbers WHERE account_id = ? ORDER BY e164', [accountId]);

const lower = (value) => String(value || '').toLowerCase();

const listingFor = (numberId, email) =>
  db_.get('SELECT * FROM listings WHERE number_id = ? AND lower(email) = ?', [numberId, lower(email)]);

/** One view for the portal and the API: the facts, plus what they affect. */
export function profileView(account) {
  const numbers = ownNumbers(account.id).map((row) => {
    const listing = listingFor(row.id, account.email);
    return {
      id: row.id,
      e164: row.e164,
      display: formatNumber(row.e164),
      visibility: row.visibility,
      // True only for a listing this customer put there: an operator's entry on
      // the same number is not theirs to withdraw by switching the choice off.
      listed: !!listing,
    };
  });
  return {
    confirmed: !!account.profile_confirmed_at,
    confirmedAt: account.profile_confirmed_at || null,
    name: account.name || '',
    email: account.email || '',
    company: account.company || '',
    address: account.address || '',
    city: account.city || '',
    country: account.country || '',
    website: account.website || '',
    kind: account.listing_kind || 'business',
    directoryOptIn: !!account.directory_opt_in,
    numbers,
  };
}

/**
 * Write (or refresh) this customer's listing on one of their numbers.
 *
 * Matched by email first and name second: a listing the operator created from
 * the same name is the customer's own entry, and confirming details should
 * correct it rather than create a duplicate beside it.
 */
export function upsertListing(number, account) {
  const name = String(account.company || account.name || account.email || '').trim();
  const nameNorm = normalizeName(name);
  if (!nameNorm) return null;
  const fields = {
    name,
    nameNorm,
    kind: SELF_KINDS.includes(account.listing_kind) ? account.listing_kind : 'business',
    address: account.address || '',
    city: account.city || '',
    country: account.country || '',
    website: account.website || '',
    email: account.email || '',
  };
  const existing =
    listingFor(number.id, account.email) ||
    db_.get('SELECT * FROM listings WHERE number_id = ? AND name_norm = ?', [number.id, nameNorm]);
  if (existing) {
    db_.run(
      `UPDATE listings
          SET name = ?, name_norm = ?, kind = ?, address = ?, city = ?, country = ?,
              website = ?, email = ?, updated_at = ?
        WHERE id = ?`,
      [
        fields.name,
        fields.nameNorm,
        fields.kind,
        fields.address,
        fields.city,
        fields.country,
        fields.website,
        fields.email,
        now(),
        existing.id,
      ]
    );
    return { id: existing.id, created: false };
  }
  return addListing(number.id, fields);
}

/**
 * Apply the stored choice to the customer's numbers.
 *
 * Opting in publishes the number and writes the listing; opting out hides the
 * number and removes only the listings carrying the customer's own email, so a
 * number that was in the directory before they arrived is left to moderation.
 */
export function applyDirectoryChoice(account) {
  const numbers = ownNumbers(account.id);
  let listed = 0;
  let hidden = 0;
  for (const number of numbers) {
    if (account.directory_opt_in) {
      db_.run("UPDATE numbers SET visibility = 'public', updated_at = ? WHERE id = ?", [now(), number.id]);
      if (upsertListing(number, account)) listed += 1;
    } else {
      db_.run("UPDATE numbers SET visibility = 'private', updated_at = ? WHERE id = ?", [now(), number.id]);
      db_.run('DELETE FROM listings WHERE number_id = ? AND lower(email) = ?', [number.id, lower(account.email)]);
      hidden += 1;
    }
  }
  return { listed, hidden };
}

/**
 * A number handed to a customer who already said "list me" is published without
 * asking again. Called when an account is assigned a number, from the registry
 * and from the carrier order path.
 */
export function syncNumberToListing(numberId) {
  const number = db_.get('SELECT * FROM numbers WHERE id = ?', [numberId]);
  if (!number || !number.account_id) return null;
  const account = db_.get('SELECT * FROM accounts WHERE id = ?', [number.account_id]);
  if (!account || !account.profile_confirmed_at) return null;
  if (account.directory_opt_in) {
    db_.run("UPDATE numbers SET visibility = 'public', updated_at = ? WHERE id = ?", [now(), number.id]);
    return upsertListing(number, account);
  }
  // They opted out: a number they now hold stays private, and their old listing
  // cannot follow them onto it.
  db_.run("UPDATE numbers SET visibility = 'private', updated_at = ? WHERE id = ?", [now(), number.id]);
  db_.run('DELETE FROM listings WHERE number_id = ? AND lower(email) = ?', [number.id, lower(account.email)]);
  return null;
}

/**
 * Save a customer's confirmation.
 *
 * `directoryOptIn` is deliberately required by the route: the point of the step
 * is that the customer answers, so an absent answer is never read as "yes" or
 * "no" on their behalf.
 */
export function saveProfile(account, body = {}) {
  const name = v.str(body.name ?? account.name, { name: 'name', max: 120, min: 2 });
  if (!normalizeName(name)) throw badRequest('name needs at least one letter or number');
  const patch = {
    name,
    company: v.str(body.company, { name: 'company', max: 120, required: false }),
    address: v.str(body.address, { name: 'address', max: 200, required: false }),
    city: v.str(body.city, { name: 'city', max: 80, required: false }),
    country: v.str(body.country, { name: 'country', max: 2, required: false }).toUpperCase(),
    website: v.url(body.website),
    listing_kind: body.kind === undefined ? account.listing_kind || 'business' : v.oneOf(body.kind, SELF_KINDS, 'kind'),
    directory_opt_in: v.bool(body.directoryOptIn, !!account.directory_opt_in) ? 1 : 0,
    profile_confirmed_at: account.profile_confirmed_at || now(),
  };
  const columns = Object.keys(patch);
  db_.run(
    `UPDATE accounts SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
    [...Object.values(patch), account.id]
  );
  const fresh = db_.get('SELECT * FROM accounts WHERE id = ?', [account.id]);
  const applied = applyDirectoryChoice(fresh);
  return { profile: profileView(fresh), applied };
}
