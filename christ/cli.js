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
    const plan = buildPlan(estate);
    const target = join(HERE, 'switch');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'routes.json'), `${JSON.stringify(plan.routes, null, 2)}\n`);
    writeFileSync(join(target, 'lines.json'), `${JSON.stringify({ domain: plan.routes.domain, lines: plan.lines, trunks: plan.trunks }, null, 2)}\n`);
    process.stdout.write(
      `plan: ${plan.routes.routes.length} routes, ${plan.lines.length} lines, ${plan.trunks.length} trunk(s)  did ${estate.did}@${plan.routes.domain}\n` +
        `wrote ${join(target, 'routes.json')} and ${join(target, 'lines.json')}\n`
    );
    if (flags.has('dry-run')) {
      for (const route of plan.routes.routes) {
        process.stdout.write(`  ${route.name.padEnd(28)} ${JSON.stringify(route.when).slice(0, 72)}\n`);
      }
      process.stdout.write('dry run: nothing sent to the switch\n');
      return 0;
    }
    const result = await apply(plan, { baseUrl: switchUrl, token });
    process.stdout.write(
      `applied to ${switchUrl}: ${result.loadedRoutes}/${result.routes} routes loaded, ${result.lines} lines, ${result.trunks} trunk(s)` +
        `${result.linesMissing.length ? `, not registered: ${result.linesMissing.join(', ')}` : ''}\n`
    );
    if (result.linesMissing.length) process.stdout.write('  (a line with no phone attached is normal; it rings out to voicemail)\n');
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
