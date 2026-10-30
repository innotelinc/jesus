#!/usr/bin/env node
/**
 * christ — one command for the whole estate.
 *
 *   select  what you want → which containers that is
 *   souls   compile the agent souls → the agent document
 *   wire    the estate declaration → the switch's lines, trunk and routes
 *   board   what is running, right now
 *   check   board, but exits non-zero when the voice plane is not up
 *   up      start the front door
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadCatalog, resolve, composeCommand, explain } from './lib/catalog.js';
import { loadSouls, agentsDocument, writeAgentsDocument } from './lib/souls.js';
import { buildPlan, apply } from './lib/wire.js';
import { loadSystem, board } from './lib/board.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const command = args[0];
const flags = new Map();
const positional = [];
for (let index = 1; index < args.length; index += 1) {
  const token = args[index];
  if (token.startsWith('--')) {
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) flags.set(key, inline);
    else if (args[index + 1] && !args[index + 1].startsWith('--')) flags.set(key, args[++index]);
    else flags.set(key, true);
  } else positional.push(token);
}

const estate = JSON.parse(readFileSync(join(HERE, 'estate.json'), 'utf8'));
const catalog = loadCatalog(join(HERE, 'catalog.json'));
const switchUrl = flags.get('url') || process.env.CANTUS_URL || 'http://127.0.0.1:8188';
const token = flags.get('token') || process.env.CANTUS_CONTROL_TOKEN || '';

/**
 * The Stasis application the agent runtime actually registered.
 *
 * dograh mints a unique name per telephony configuration (two configs on one
 * PBX must never share one — Asterisk hands the app to the most recent socket
 * and the other goes deaf). The estate's `agentApp` is therefore only a
 * default: the dial plan has to carry the real name, and the only place that
 * knows it is the runtime. Absent runtime, absent name, and the default stands.
 */
async function runtimeAgentApp() {
  const base = process.env.DOGRAH_URL;
  const key = process.env.DOGRAH_API_TOKEN;
  if (!base || !key) return '';
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/api/v1/organizations/telephony-configs`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return '';
    const data = await response.json();
    const configs = Array.isArray(data)
      ? data
      : data.configurations || data.configs || data.items || data.telephony_configs || [];
    // The list hides credentials; the detail does not. Only the ARI
    // configuration can be this switch's, so the others are not asked.
    for (const config of configs) {
      const provider = String(config?.provider || '').toLowerCase();
      if (provider && provider !== 'ari') continue;
      const detail = await fetch(`${base.replace(/\/$/, '')}/api/v1/organizations/telephony-configs/${config.id}`, {
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(8_000),
      });
      if (!detail.ok) continue;
      const body = await detail.json();
      const name = body?.credentials?.stasis_app_name || body?.configuration?.credentials?.stasis_app_name;
      if (name) return String(name);
    }
  } catch {
    /* an unreachable runtime is not a wiring failure; the default still applies */
  }
  return '';
}

function souls() {
  const { souls: compiled, byFile, byExt } = loadSouls(join(HERE, 'souls'));
  return { compiled, byFile, byExt, doc: agentsDocument(estate, { byFile, byExt }) };
}

async function main() {
  if (!command || command === 'help' || flags.has('help')) {
    process.stdout.write(`christ — one AI voice system, in containers you choose

  node cli.js select <capability…>   what you want → which containers that is
  node cli.js souls                  compile souls → agents.json
  node cli.js wire [--dry-run]       apply the estate to the switch
  node cli.js seed                   give the platform its first line and the DID
  node cli.js board                  what is running right now
  node cli.js check                  like board, but exits 1 when the switch is down
  node cli.js up                     start the front door on :${process.env.PORT || 8001}

capabilities: ${[...catalog.byId.keys()].join(', ')}
`);
    return 0;
  }

  if (command === 'select') {
    const resolution = resolve(catalog, positional.length ? positional : ['voice']);
    if (flags.has('json')) {
      process.stdout.write(`${JSON.stringify({ ...resolution, command: composeCommand(resolution) }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(explain(resolution, catalog));
    process.stdout.write(`\nrun:\n  ${composeCommand(resolution)}\n`);
    return 0;
  }

  if (command === 'souls') {
    const { doc, compiled } = souls();
    const path = writeAgentsDocument(doc, join(HERE, 'out'));
    process.stdout.write(`compiled ${compiled.length} soul${compiled.length === 1 ? '' : 's'} → ${path}\n`);
    for (const agent of doc.agents) {
      process.stdout.write(`  ${agent.ext}  ${agent.name.padEnd(16)} ari=${agent.ari.padEnd(8)} voice=${agent.voice || '—'}  ${agent.prompt.length} chars\n`);
    }
    if (doc.unwired.length) process.stdout.write(`  not wired: ${doc.unwired.join(', ')}\n`);
    return 0;
  }

  if (command === 'wire') {
    // The agent runtime mints its own Stasis application name (two configs on
    // one PBX must never share one), so the estate's `agentApp` is only a
    // default. `--agent-app` is how the real name reaches the dial plan without
    // being baked into a repository that a second install also uses.
    const agentApp = flags.get('agent-app') || (await runtimeAgentApp());
    const plan = buildPlan(agentApp ? { ...estate, agentApp } : estate);
    const target = join(HERE, 'switch');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'routes.json'), `${JSON.stringify(plan.routes, null, 2)}\n`);
    writeFileSync(join(target, 'lines.json'), `${JSON.stringify({ domain: plan.routes.domain, lines: plan.lines, trunks: plan.trunks }, null, 2)}\n`);
    // The platform generates its own document from its own database, so the AI
    // plane's branches are handed to it as data rather than left to be
    // overwritten the first time somebody saves a setting. Lines stay out: their
    // secrets belong to whoever owns the inventory.
    const estateDir = flags.get('estate-dir') || process.env.ESTATE_DIR || join(HERE, 'state', 'estate');
    mkdirSync(estateDir, { recursive: true });
    const platformRoutes = plan.routes.routes.filter((route) => !route.name.startsWith('line-'));
    writeFileSync(
      join(estateDir, 'estate-routes.json'),
      `${JSON.stringify({ version: 1, domain: plan.routes.domain, default: plan.routes.default, routes: platformRoutes }, null, 2)}\n`
    );
    process.stdout.write(
      `plan: ${plan.routes.routes.length} routes, ${plan.lines.length} lines, ${plan.trunks.length} trunk(s)  did ${estate.did}@${plan.routes.domain}\n` +
        `wrote ${join(target, 'routes.json')} and ${join(target, 'lines.json')}\n` +
        `handed ${platformRoutes.length} AI-plane route(s) to the platform: ${join(estateDir, 'estate-routes.json')}\n`
    );
    if (flags.has('dry-run')) {
      for (const route of plan.routes.routes) {
        process.stdout.write(`  ${route.name.padEnd(28)} ${JSON.stringify(route.when).slice(0, 72)}\n`);
      }
      process.stdout.write('dry run: nothing sent to the switch\n');
      return 0;
    }
    const result = await apply(plan, { baseUrl: switchUrl, token, routesOnly: flags.has('routes-only') });
    process.stdout.write(
      `applied to ${switchUrl}${flags.has('routes-only') ? ' (routes only)' : ''}: ${result.loadedRoutes}/${result.routes} routes loaded, ${result.lines} lines, ${result.trunks} trunk(s)` +
        `${result.linesMissing.length ? `, not registered: ${result.linesMissing.join(', ')}` : ''}\n`
    );
    if (result.linesMissing.length) process.stdout.write('  (a line with no phone attached is normal; it rings out to voicemail)\n');
    return 0;
  }

  if (command === 'seed') {
    // The platform's first line, without a browser.
    //
    // Telno's first-run gate wants a person who owns a line. On a box nobody is
    // sitting at, that describes a demo that cannot make a call: the switch has
    // lines and no platform does. This does the same two writes the setup
    // wizard does, through the platform's own API, so the inventory and the
    // switch agree afterwards — the DID lands on the line the estate names.
    const base = String(flags.get('telno') || process.env.TELNO_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
    const email = flags.get('email') || process.env.ADMIN_EMAIL || 'admin@estate.local';
    const password = flags.get('password') || process.env.ADMIN_PASSWORD || '';
    if (!password) throw new Error('seed: ADMIN_PASSWORD (or --password) is required');
    const line = estate.lines?.find((entry) => entry.numbers?.includes(estate.did)) || estate.lines?.[0] || {};

    const post = async (path, body, token) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* a non-JSON error body is still worth printing */
      }
      if (!response.ok) throw new Error(`POST ${path} → ${response.status}: ${parsed?.message || parsed?.error || text}`);
      return parsed;
    };

    const session = await post('/api/auth/login', { email, password });
    const seeded = await post(
      '/api/setup/line',
      { extension: String(line.ext || '101'), displayName: line.displayName || 'Front desk', number: estate.did },
      session.token
    );
    process.stdout.write(
      `seeded ${base}: line ${seeded.extension?.extension}${seeded.number?.e164 ? ` on ${seeded.number.e164}` : ''}` +
        `${seeded.applied ? `, ${seeded.applied.reloaded ? 'applied to the switch' : 'switch not reloaded'}` : ''}\n`
    );
    return 0;
  }

  if (command === 'board' || command === 'check') {
    const system = loadSystem(join(HERE, 'system.json'));
    const { doc } = souls();
    const live = await board({ system, estate, agents: doc.agents, switchUrl, token });
    process.stdout.write(`${live.name} — ${live.tagline}\n${live.at}\n\n`);
    for (const layer of live.layers) {
      process.stdout.write(`${layer.name.toUpperCase()}\n`);
      for (const project of layer.projects) {
        const state = project.state.padEnd(24);
        process.stdout.write(`  ${state} ${project.id.padEnd(18)} ${project.url || ''}\n`);
      }
      process.stdout.write('\n');
    }
    if (live.switch?.reachable) {
      process.stdout.write(
        `switch ${live.switch.id} · ${live.switch.routeCount} routes · ${live.switch.calls?.active ?? 0} active / ${live.switch.calls?.total ?? 0} total\n`
      );
      if (live.wiring) process.stdout.write(`did ${live.wiring.did} → line ${live.wiring.officeHours?.line || '—'} in hours, agent ${live.wiring.afterHours?.agent || '—'} after\n`);
    } else {
      process.stdout.write(`switch unreachable at ${live.switch?.url}: ${live.switch?.error}\n`);
    }
    if (command === 'check' && !live.switch?.reachable) return 1;
    return 0;
  }

  if (command === 'up') {
    await import('./server.js');
    return 0;
  }

  process.stderr.write(`christ: unknown command '${command}' — try 'node cli.js help'\n`);
  return 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`christ: ${error.message}\n`);
    process.exit(1);
  });
