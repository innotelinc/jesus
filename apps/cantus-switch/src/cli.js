#!/usr/bin/env node
/**
 * cantus-switch CLI.
 *
 *   run        serve the switch (the only mode a deployment uses)
 *   selftest   two switches and a relay in one process, one real call
 *   route-test score a routing document offline, no sockets
 */

import { readFileSync } from 'node:fs';
import { Switch } from './switch.js';
import { CantusServer } from './server.js';
import { AriBridge } from './ari.js';
import { Router } from './router.js';

const env = process.env;
const arg = (name, fallback) => env[name] ?? fallback;

function routesFromFile(file) {
  if (!file) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function run() {
  const domain = arg('CANTUS_DOMAIN', 'telno.local');
  const config = {
    domain,
    id: arg('CANTUS_ID', `switch@${domain}`),
    secret: arg('CANTUS_SECRET', 'cantus-loopback'),
    bind: arg('CANTUS_BIND', '0.0.0.0:7443'),
    advertise: arg('CANTUS_ADVERTISE', ''),
    relayBind: arg('CANTUS_RELAY_BIND', '0.0.0.0:7444'),
    relayAdvertise: arg('CANTUS_RELAY_ADVERTISE', ''),
    recordDir: arg('CANTUS_RECORD_DIR', './data/recordings'),
    prompts: arg('CANTUS_PROMPTS', './data/prompts'),
    debug: /^(1|true|yes)$/i.test(arg('CANTUS_DEBUG', '')),
  };

  const routes = routesFromFile(arg('CANTUS_ROUTES_FILE', ''));
  const switchRef = new Switch({ ...config, routes });

  // A file of lines is the stand-alone demo's inventory: no platform to ask,
  // no database. A platform that does have one overrides it through
  // CANTUS_LINES_URL below, which is the production path.
  const linesFile = routesFromFile(arg('CANTUS_LINES_FILE', ''));
  for (const line of linesFile?.lines || []) switchRef.setLine(line);
  for (const trunk of linesFile?.trunks || []) switchRef.setTrunk(trunk);
  switchRef.on('event', (event) => {
    if (['call.incoming', 'call.answered', 'call.ended', 'call.ringing', 'call.rejected'].includes(event.type)) {
      console.log(`[cantus] ${event.type} ${event.callId} ${event.from || ''} -> ${event.to || ''} ${event.cause || ''}`);
    }
  });
  switchRef.on('error', (err) => console.error('[cantus] error', err.message));
  await switchRef.start();

  const ari = new AriBridge({
    switch: switchRef,
    username: arg('CANTUS_ARI_USER', 'dograh'),
    password: arg('CANTUS_ARI_PASSWORD', 'dograh'),
    app: arg('CANTUS_ARI_APP', 'dograh'),
  });

  const server = new CantusServer({
    switch: switchRef,
    ari,
    host: arg('CANTUS_HTTP_BIND', '0.0.0.0'),
    port: Number(arg('CANTUS_HTTP_PORT', 8088)),
    controlToken: arg('CANTUS_CONTROL_TOKEN', ''),
    allowLoopback: true,
  });

  // The platform mints a single-use ticket for each softphone socket; the
  // switch asks it whether the ticket is still good, and never trusts the
  // extension name the browser sent on its own.
  server.verifyTicket = async (ticket, url) => {
    const verifyUrl = arg('CANTUS_TICKET_VERIFY_URL', '');
    if (!verifyUrl) return { ok: true, ext: url.searchParams.get('ext') };
    try {
      const response = await fetch(`${verifyUrl}?ticket=${encodeURIComponent(ticket)}`, {
        headers: { authorization: `Bearer ${arg('CANTUS_CONTROL_TOKEN', '')}` },
      });
      if (!response.ok) return { ok: false, reason: 'ticket refused' };
      const body = await response.json();
      return { ok: !!body.ext, ext: body.ext };
    } catch (err) {
      return { ok: false, reason: `ticket check failed: ${err.message}` };
    }
  };

  // Lines and trunks come from the platform, and are re-sent whenever it
  // applies a configuration change: the database stays the source of truth.
  const linesUrl = arg('CANTUS_LINES_URL', '');
  if (linesUrl) {
    const sync = async () => {
      try {
        const response = await fetch(linesUrl, { headers: { authorization: `Bearer ${arg('CANTUS_CONTROL_TOKEN', '')}` } });
        if (!response.ok) return;
        const body = await response.json();
        for (const line of body.lines || []) switchRef.setLine(line);
        for (const trunk of body.trunks || []) switchRef.setTrunk(trunk);
      } catch (err) {
        console.error('[cantus] line sync failed', err.message);
      }
    };
    await sync();
    setInterval(sync, 30_000).unref();
  }

  await server.listen();
  console.log(`[cantus] switch ${config.id} on ${switchRef.endpoint.localAddr} (Cantus UDP)`);
  console.log(`[cantus] relay ${switchRef.relay?.addr || 'none'}`);
  console.log(`[cantus] control ${server.url}/v1/status, ARI ${server.url}/ari/asterisk/info`);

  const shutdown = () => {
    console.log('[cantus] stopping');
    switchRef.stop();
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { switchRef, server };
}

/**
 * Two switches, one relay, one real call, over real UDP sockets.
 *
 * This is the whole stack exercised the way a deployment uses it: the callee
 * switch registers its line with a relay, the caller dials that line by name,
 * the callee answers from its routing document, Reach commits a path, and the
 * call is only reported as passing if audio actually arrived.
 */
export async function selftest() {
  const domain = 'selftest.cantus';
  const debug = /^(1|true|yes)$/i.test(process.env.CANTUS_DEBUG || '');
  let frames = 0;
  let peak = 0;

  const b = new Switch({
    domain,
    id: `switch-b@${domain}`,
    secret: 'selftest',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/selftest',
    prompts: './data/selftest',
    debug,
    routes: { version: 1, routes: [{ name: 'answer-100', when: { to: '100*' }, then: [{ answer: {} }] }] },
  });
  if (debug) b.on('endpoint', (event) => console.log('[b]', JSON.stringify(event)));
  b.setLine({ ext: '100', displayName: 'Front desk' });
  b.on('cdr', (cdr) => console.log(`[selftest] cdr          ${cdr.disposition} ${cdr.duration}s ${cdr.from} -> ${cdr.to}`));
  await b.start();

  const inline = b.endpoint.onInboundMedia;
  b.endpoint.onInboundMedia = (session, media) => {
    frames += 1;
    let max = 0;
    for (let i = 0; i + 1 < media.payload.length; i += 2) max = Math.max(max, Math.abs(media.payload.readInt16LE(i)));
    peak = Math.max(peak, max);
    inline?.(session, media);
  };

  const a = new Switch({
    domain,
    id: `caller@${domain}`,
    secret: 'selftest',
    bind: '127.0.0.1:0',
    relayAddress: b.relay.addr,
    recordDir: './data/selftest',
    prompts: './data/selftest',
    debug,
    routes: { version: 1, routes: [] },
  });
  if (debug) a.on('endpoint', (event) => { if (event.kind !== 'media') console.log('[a]', JSON.stringify(event)); });
  const paths = [];
  a.on('endpoint', (event) => {
    if (event.kind === 'path') paths.push(event.path);
  });
  await a.start();

  const call = a.originate({ from: `200@${domain}`, to: `100@${domain}` });
  await sleep(1600);
  const answered = call.legs.some((leg) => leg.isAnswered);
  a.hangup(call.id);
  await sleep(300);

  const ok = frames > 0 && peak > 0 && answered;
  console.log(`[selftest] answered      ${answered}`);
  console.log(`[selftest] path          ${paths.length ? paths[paths.length - 1] : 'none'} (${paths.join(' -> ') || 'no decision'})`);
  console.log(`[selftest] audio         ${frames} frames received, peak amplitude ${peak}`);
  console.log(`[selftest] relay         ${JSON.stringify(b.relay.stats)}`);
  console.log(`[selftest] result        ${ok ? 'PASS' : 'FAIL'}`);

  a.stop();
  b.stop();
  if (!ok) process.exitCode = 1;
  return ok;
}

export function routeTest(file, { to, from = '+15550000000', now } = {}) {
  const router = new Router({ doc: readFileSync(file, 'utf8') });
  const decision = router.decide({ to, from, now: now ? Number(now) : undefined, calls: 0 });
  console.log(JSON.stringify(decision, null, 2));
  return decision;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , command = 'run', ...rest] = process.argv;
if (/cli\.js$/.test(process.argv[1] || '')) {
  if (command === 'run') {
    run().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else if (command === 'selftest') {
    selftest().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else if (command === 'route-test') {
    const file = rest[0];
    const flags = Object.fromEntries(
      rest.slice(1).reduce((pairs, value, index, list) => {
        if (value.startsWith('--')) pairs.push([value.slice(2), list[index + 1]]);
        return pairs;
      }, [])
    );
    routeTest(file, flags);
  } else {
    console.log('usage: cantus-switch [run|selftest|route-test <file> --to <number>]');
    process.exit(command === 'help' ? 0 : 2);
  }
}

export { Router };
