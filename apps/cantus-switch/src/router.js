/**
 * Routing as a schema-checked document, evaluated deterministically (§12).
 *
 * This is the whole dialplan: one JSON document, validated at load and
 * evaluable offline. `bin/cantus route-test` in the reference stack can score
 * the same file, which is the point — the switch and the test agree because
 * they are reading the same rules, not two copies of them.
 */

const PREDICATES = new Set(['to', 'from', 'weekday', 'time', 'limit', 'event', 'verified']);
// `trunk` dials a number at a carrier gateway; `bridge` rings lines on this
// switch. An outbound PSTN route needs the former, and before it existed the
// generated route used `bridge` and rang nothing.
const ACTIONS = new Set(['answer', 'reject', 'forward', 'bridge', 'trunk', 'play', 'record', 'pause', 'noop', 'ari']);

export class RoutingError extends Error {
  constructor(errors) {
    super(`cantus: routing document invalid:\n  - ${errors.join('\n  - ')}`);
    this.errors = errors;
  }
}

export class Router {
  constructor({ doc, name = 'inline' } = {}) {
    this.name = name;
    this.doc = undefined;
    if (doc !== undefined) this.load(doc);
  }

  load(doc) {
    const parsed = typeof doc === 'string' ? JSON.parse(doc) : doc;
    const errors = [];
    if (!parsed || parsed.version !== 1) errors.push('version must be 1');
    if (!Array.isArray(parsed?.routes)) errors.push('routes must be an array');

    (parsed?.routes || []).forEach((route, index) => {
      const where = `route[${index}]`;
      if (!route || typeof route !== 'object' || Array.isArray(route)) {
        errors.push(`${where} is not an object`);
        return;
      }
      if (route.name === undefined) errors.push(`${where} needs a name`);
      for (const key of Object.keys(route.when || {})) {
        if (!PREDICATES.has(key)) errors.push(`${where}: unknown predicate '${key}'`);
      }
      if (!Array.isArray(route.then) || route.then.length === 0) {
        errors.push(`${where}: 'then' must be a non-empty array`);
      }
      for (const action of route.then || []) {
        if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).length !== 1) {
          errors.push(`${where}: each action is a single-key object`);
          continue;
        }
        const [key] = Object.keys(action);
        if (!ACTIONS.has(key)) errors.push(`${where}: unknown action '${key}'`);
        // `ari` hands the call to an application, which is how an agent — a
        // dograh workflow, a Pipecat pipeline — takes a call. Naming no app is
        // the one failure that would only ever show up on the first call, so it
        // is a load error instead.
        if (key === 'ari') {
          const value = action.ari;
          const app = typeof value === 'string' ? value : value?.app;
          if (!app || typeof app !== 'string') errors.push(`${where}: ari needs an app name`);
        }
      }
    });

    if (errors.length) throw new RoutingError(errors);
    this.doc = parsed;
    return this;
  }

  /**
   * `*` is any run of characters (including none), `?` is exactly one.
   *
   * `?` used to be escaped as a literal, while every generated document used
   * it as a wildcard — `1??????????@*` for a national number, `1??@*` for the
   * 1xx block, `7???@*` for a parking space. Those routes loaded without an
   * error and then matched nothing, so the dial plan read correctly and the
   * outbound calls fell through to "no route".
   */
  static globMatch(pattern, value) {
    if (pattern === undefined) return true;
    if (value === undefined || value === null) return false;
    const expression = String(pattern)
      .toLowerCase()
      .split('*')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
      .join('.*');
    return new RegExp(`^${expression}$`).test(String(value).toLowerCase());
  }

  static timeMatch(range, epoch = Date.now()) {
    if (range === undefined) return true;
    const [a, b] = String(range).split('-');
    if (b === undefined) return true;
    const date = new Date(epoch);
    const now = date.getHours() * 60 + date.getMinutes();
    const [h1, m1 = 0] = a.split(':').map(Number);
    const [h2, m2 = 0] = b.split(':').map(Number);
    return now >= h1 * 60 + m1 && now < h2 * 60 + m2;
  }

  static weekdayMatch(list, epoch = Date.now()) {
    if (list === undefined) return true;
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const day = names[new Date(epoch).getDay()];
    return (Array.isArray(list) ? list : [list]).some((entry) => String(entry).toLowerCase() === day);
  }

  matches(route, ctx) {
    const when = route.when || {};
    if (!Router.globMatch(when.to, ctx.to)) return false;
    if (!Router.globMatch(when.from, ctx.from)) return false;
    if (!Router.weekdayMatch(when.weekday, ctx.now)) return false;
    if (!Router.timeMatch(when.time, ctx.now)) return false;
    if (when.verified !== undefined) {
      const want = when.verified ? 1 : 0;
      if ((ctx.verified ?? 0) !== want) return false;
    }
    if (when.event !== undefined) {
      if (ctx.event === undefined || ctx.event !== when.event) return false;
    }
    if (when.limit !== undefined) {
      if ((ctx.calls ?? 0) >= when.limit) return false;
    }
    return true;
  }

  /**
   * First matching route wins; nothing is executed here, which is what makes an
   * offline evaluation exact.
   */
  decide(ctx = {}) {
    if (!this.doc) throw new Error('cantus: no routing document loaded');
    const context = { now: Date.now(), ...ctx };
    for (const route of this.doc.routes) {
      if (!this.matches(route, context)) continue;
      return { matched: true, route: route.name, actions: route.then };
    }
    const fallback = this.doc.default;
    if (fallback) return { matched: false, route: undefined, actions: [fallback] };
    return { matched: false, route: undefined, actions: [{ reject: 3 }] };
  }

  /**
   * Decide a keypress or a timeout. Only routes that name an `event` are
   * candidates: a DID route and a digit handler can be about the same address,
   * and a press must never re-run the route that answered the call.
   */
  decideEvent(ctx = {}) {
    if (!this.doc || ctx.event === undefined) return { matched: false, actions: [] };
    const context = { now: Date.now(), ...ctx };
    for (const route of this.doc.routes) {
      if (route.when?.event === undefined) continue;
      if (String(route.when.event) !== String(ctx.event)) continue;
      if (!this.matches({ ...route, when: { ...route.when, event: undefined } }, context)) continue;
      return { matched: true, route: route.name, actions: route.then };
    }
    return { matched: false, actions: [] };
  }

  static defaultDoc() {
    return {
      version: 1,
      default: { reject: 3 },
      routes: [{ name: 'answer-all', when: {}, then: [{ answer: {} }] }],
    };
  }
}

/** The action in a `then` list as `[name, argument]`. */
export function firstAction(actions) {
  const [action] = actions || [];
  if (!action) return ['noop', {}];
  const [name] = Object.keys(action);
  return [name, action[name]];
}
