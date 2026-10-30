/**
 * Capability selection: "I want AI" in, a container set out.
 *
 * The estate is split so that nobody pays for what they do not run: a switch is
 * a few megabytes, a platform is a database and a server, an agent stack is
 * several containers and a model. Remembering which of those depends on which
 * is the kind of knowledge that rots. The catalog holds it instead, and this
 * module resolves a list of wishes into the exact profiles Compose needs.
 *
 * `core` is always in the answer: the front door and the switch are the floor,
 * and a selection that leaves them out would produce a dashboard with nothing
 * behind it.
 */

import { readFileSync } from 'node:fs';

export const CORE = 'core';

export function loadCatalog(path) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog?.capabilities)) throw new Error('catalog.json: capabilities must be an array');
  const byId = new Map();
  for (const capability of catalog.capabilities) {
    if (!capability?.id) throw new Error('catalog.json: every capability needs an id');
    if (byId.has(capability.id)) throw new Error(`catalog.json: capability '${capability.id}' is declared twice`);
    byId.set(capability.id, capability);
  }
  return { ...catalog, byId };
}

/**
 * Resolve capabilities to services, dependencies first, duplicates once.
 *
 * A cycle is a catalog bug and is named rather than silently broken: two
 * capabilities that each require the other would otherwise resolve to whichever
 * one the traversal happened to finish first.
 */
export function resolve(catalog, wanted) {
  const names = (Array.isArray(wanted) ? wanted : [wanted]).map((name) => String(name).trim()).filter(Boolean);
  if (!names.length) throw new Error(`say what you want: ${[...catalog.byId.keys()].join(', ')}`);

  const unknown = names.filter((name) => !catalog.byId.has(name));
  if (unknown.length) {
    throw new Error(`unknown capabilit${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')} — available: ${[...catalog.byId.keys()].join(', ')}`);
  }

  const capabilities = [];
  const services = [];
  const external = [];
  const env = new Set();
  const stack = [];
  const seenCapability = new Set();
  const seenService = new Set();

  const visit = (id) => {
    if (stack.includes(id)) throw new Error(`catalog cycle: ${[...stack, id].join(' → ')}`);
    if (seenCapability.has(id)) return;
    const capability = catalog.byId.get(id);
    if (!capability) throw new Error(`catalog.json: '${id}' is referenced but not declared`);
    stack.push(id);
    for (const dependency of capability.requires || []) visit(dependency);
    for (const bundled of capability.capabilities || []) visit(bundled);
    stack.pop();

    seenCapability.add(id);
    // A bundle ("ai") is a wish, not a unit of work: it expands into the
    // capabilities that actually own something, and asking for its profile
    // would give Compose a profile no service declares.
    if ((capability.services || []).length || (capability.external || []).length) capabilities.push(id);
    for (const capabilityService of capability.services || []) {
      if (seenService.has(capabilityService)) continue;
      seenService.add(capabilityService);
      services.push(capabilityService);
    }
    for (const item of capability.external || []) {
      if (!external.some((entry) => entry.name === item.name)) external.push(item);
    }
    for (const name of capability.env || []) env.add(name);
  };

  for (const name of names) visit(name);

  // A capability that names services but never declared where they live is a
  // catalog mistake; catch it here rather than in a compose error at boot.
  for (const service of services) {
    if (!catalog.services?.[service] && catalog.services) throw new Error(`catalog.json: service '${service}' is not described`);
  }

  return {
    capabilities,
    services,
    external,
    env: [...env].sort(),
    profiles: [CORE, ...capabilities.filter((id) => id !== CORE)],
  };
}

/** The command that starts exactly this selection. */
export function composeCommand(resolution, { detach = true, build = true } = {}) {
  const profiles = resolution.profiles.map((profile) => `--profile ${profile}`).join(' ');
  const flags = [detach ? '-d' : '', build ? '--build' : ''].filter(Boolean).join(' ');
  return `docker compose ${profiles} up ${flags}`.replace(/\s+/g, ' ').trim();
}

/** A short human answer: what runs, what it needs from you, what stays outside. */
export function explain(resolution, catalog) {
  const lines = [];
  lines.push(`capabilities: ${resolution.capabilities.join(', ')}`);
  lines.push(`containers:   ${resolution.services.length ? resolution.services.join(', ') : '(none — every part of this selection is external)'}`);
  if (resolution.external.length) {
    lines.push('attached:');
    for (const item of resolution.external) {
      lines.push(`  ${item.name}  (${item.path})${item.env?.length ? `  → set ${item.env.join(', ')}` : ''}`);
      if (item.note) lines.push(`    ${item.note}`);
    }
  }
  if (resolution.env.length) lines.push(`required env: ${resolution.env.join(', ')}`);
  const about = resolution.capabilities
    .map((id) => catalog.byId.get(id))
    .filter(Boolean)
    .map((capability) => `- ${capability.name}: ${capability.about}`);
  if (about.length) lines.push('', ...about);
  return `${lines.join('\n')}\n`;
}
