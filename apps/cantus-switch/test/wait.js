/**
 * Wait for a condition instead of sleeping for a guess.
 *
 * These tests drive real UDP sockets, a real relay and real timers, so "120 ms
 * was enough on this machine" is not a test, it is a bet. A suite that fails
 * once in fifty runs for no reason teaches everyone to re-run it, and that is
 * exactly how a real regression gets waved through. Each wait here polls until
 * the state it is about actually holds and only fails at a deadline that a
 * genuine fault can reach.
 */

export async function waitUntil(predicate, { timeout = 4000, interval = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // The predicate's value is the wait's value, so a caller can ask for "the
    // registration message" and get the message rather than `true`.
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
