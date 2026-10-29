/**
 * One switch, two halves, and what happens when the second one refuses.
 *
 * Encryption is two settings — the gateway's SDES offer and the sub-account's
 * own at the carrier — and every call is refused with `488` unless they agree.
 * So the flip is ordered: the carrier first, because it is the half that can
 * refuse our calls, and then the gateway.
 *
 * The case this file exists for is the one left over: the carrier took the
 * change and the gateway did not. Retrying once covers the transient case (a
 * cold socket, a container just woken by the request). If it still refuses, the
 * carrier is put back where it was, so the estate ends up entirely on the old
 * setting rather than half on each — a mismatch is silent in the logs and
 * obvious only as every call failing, which is the worst way to find out.
 *
 * Both dependencies are injected so the ordering, the retry and the rollback can
 * be exercised without a carrier account or a gateway.
 */

/** Wait for the gateway to acknowledge; it re-registers the trunk as it does. */
const GATEWAY_ATTEMPTS = 2;

/**
 * @param {object} options
 * @param {boolean} options.enabled              what the operator asked for
 * @param {{configured: boolean, set: (b: boolean) => Promise<{before: boolean|null, ms: number}>}} options.carrier
 * @param {{set: (b: boolean) => Promise<void>}} options.gateway
 */
export async function flip({ enabled, carrier, gateway }) {
  let carrierResult;
  // What the carrier held before this flip, so a failed gateway step can be
  // undone instead of leaving the two halves disagreeing.
  let before = null;

  try {
    const changed = await carrier.set(enabled);
    before = typeof changed?.before === 'boolean' ? changed.before : null;
    // The carrier is slow enough that a switch needs to say how slow, or an
    // operator assumes it hung and clicks it again.
    carrierResult = { ok: true, ms: changed?.ms ?? 0, before };
  } catch (error) {
    carrierResult = { ok: false, error: error.message };
    // A carrier that is configured and did not move is the one case where our
    // side must not move either: if its sub-account still demands encryption and
    // we stop offering it, every call fails until somebody notices. An
    // unconfigured carrier is different — that is a local test.
    if (carrier.configured) {
      return {
        carrier: carrierResult,
        gateway: { ok: false, skipped: true, error: 'not changed, because the carrier was not changed' },
        rolledBack: false,
      };
    }
  }

  let lastError = '';
  for (let attempt = 1; attempt <= GATEWAY_ATTEMPTS; attempt += 1) {
    try {
      await gateway.set(enabled);
      return {
        carrier: carrierResult,
        gateway: { ok: true, enabled, attempts: attempt },
        rolledBack: false,
      };
    } catch (error) {
      lastError = error.message;
    }
  }

  // The gateway will not move. Put the carrier back rather than leave a
  // mismatch nothing announces.
  const gatewayResult = { ok: false, error: lastError, attempts: GATEWAY_ATTEMPTS };
  if (!carrierResult.ok || before === null || before === enabled) {
    // Nothing changed at the carrier (or it never had a flag we understood), so
    // there is nothing to undo and the estate is still consistent.
    return { carrier: carrierResult, gateway: gatewayResult, rolledBack: false };
  }

  try {
    const undone = await carrier.set(before);
    return {
      carrier: { ...carrierResult, rolledBack: true, restored: before, rollbackMs: undone?.ms ?? 0 },
      gateway: gatewayResult,
      rolledBack: true,
    };
  } catch (error) {
    // Both halves are now unrecoverable by this process. Say it plainly: the
    // only remaining signal is the MISMATCH on the card.
    return {
      carrier: { ...carrierResult, rolledBack: false, error: `${carrierResult.error || ''} rollback to ${before ? 'on' : 'off'} failed: ${error.message}`.trim() },
      gateway: gatewayResult,
      rolledBack: false,
    };
  }
}
