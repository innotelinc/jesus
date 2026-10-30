/**
 * The board: what the system is, and what it is doing right now.
 *
 * Two different questions, kept apart. `system.json` answers the first — what
 * each project contributes and how it plugs in, transcribed from its own docs.
 * The probes and the switch answer the second: which of those are running, and
 * what the switch is holding in memory.
 *
 * A product that is not configured is not an error. Half the estate is a
 * separate stack by design; a board that painted missing pieces red would teach
 * people to ignore red.
 */

import { readFileSync } from 'node:fs';

export function loadSystem(file) {
  const system = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(system?.projects)) throw new Error('system.json: projects must be an array');
  for (const project of system.projects) {
    if (!project?.id) throw new Error('system.json: every project needs an id');
    if (!system.layers?.some((layer) => layer.id === project.layer)) {
      throw new Error(`system.json: ${project.id} names layer '${project.layer}', which is not declared`);
    }
  }
  return system;
}

/**
 * The URL a project answers on, from the environment first, then its default.
 *
 * A variable that is present but empty is a decision, not a missing value: the
 * compose file sets `TELNO_URL=` when the platform profile is off, and falling
 * back to a loopback default there would probe a port that nothing owns and
 * report a product as broken rather than absent.
 */
export function projectUrl(project, env = process.env) {
  if (project.urlEnv && Object.prototype.hasOwnProperty.call(env, project.urlEnv)) {
    return String(env[project.urlEnv] || '').replace(/\/$/, '');
  }
  return String(project.defaultUrl || '').replace(/\/$/, '');
}

export async function probe(project, env = process.env, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const url = projectUrl(project, env);
  if (!url) return { url: null, state: 'not configured' };
  try {
    const response = await fetchImpl(`${url}${project.healthPath || '/'}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { url, state: response.ok ? 'up' : `HTTP ${response.status}`, detail: '' };
  } catch (error) {
    // A DNS failure on Windows arrives as `TypeError: fetch failed` with the
    // real reason in `cause`; showing the class name told a reader nothing.
    const code = error.cause?.code || error.code || error.cause?.name || error.name || 'error';
    return { url, state: `unreachable (${code})`, detail: error.cause?.message || error.message };
  }
}

async function switchCall(base, path, token, fetchImpl, timeoutMs = 2500) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

/**
 * The whole picture, in one object, for the board and for `/api/board`.
 *
 * Every read is tolerant: a switch that is restarting leaves the last known
 * wiring on screen and reports `reachable: false`, rather than blanking the
 * page at the moment it is most useful.
 */
export async function board({
  system,
  estate,
  env = process.env,
  fetchImpl = fetch,
  switchUrl = env.CANTUS_URL || 'http://127.0.0.1:8188',
  token = env.CANTUS_CONTROL_TOKEN || '',
  agents = [],
} = {}) {
  const projects = await Promise.all(
    system.projects.map(async (project) => {
      const live = await probe(project, env, { fetchImpl });
      return { ...project, ...live };
    })
  );

  const layers = (system.layers || []).map((layer) => ({
    ...layer,
    projects: projects.filter((project) => project.layer === layer.id),
  }));

  const base = String(switchUrl).replace(/\/$/, '');
  let switched = null;
  let wiring = null;
  try {
    const [status, lines, routes] = await Promise.all([
      switchCall(base, '/v1/status', token, fetchImpl),
      switchCall(base, '/v1/lines', token, fetchImpl),
      switchCall(base, '/v1/routes', token, fetchImpl),
    ]);
    switched = {
      reachable: true,
      url: base,
      id: status?.id || '',
      domain: status?.domain || '',
      mode: status?.mode || '',
      uptimeSec: status?.uptimeSec ?? 0,
      calls: status?.calls || null,
      routeCount: status?.routes?.count ?? 0,
    };
    const registered = new Map((Array.isArray(lines) ? lines : []).map((line) => [String(line.ext), line]));
    wiring = {
      did: estate?.did || '',
      officeHours: estate?.officeHours || null,
      afterHours: estate?.afterHours || null,
      agentApp: estate?.agentApp || '',
      lines: (estate?.lines || []).map((line) => ({
        ext: String(line.ext),
        displayName: line.displayName || '',
        numbers: line.numbers || [],
        online: !!registered.get(String(line.ext))?.online,
        registered: registered.get(String(line.ext))?.registered ?? 0,
        lastChange: registered.get(String(line.ext))?.lastChange || null,
      })),
      agents: agents.map((agent) => ({ ext: agent.ext, name: agent.name, ari: agent.ari, voice: agent.voice })),
      trunk: estate?.trunk?.name || '',
      routeNames: Array.isArray(routes?.routes) ? routes.routes.map((route) => route.name) : [],
    };
  } catch (error) {
    switched = { reachable: false, url: base, error: error.message };
    wiring = estate
      ? {
          did: estate.did || '',
          officeHours: estate.officeHours || null,
          afterHours: estate.afterHours || null,
          agentApp: estate.agentApp || '',
          lines: (estate.lines || []).map((line) => ({ ext: String(line.ext), displayName: line.displayName || '', numbers: line.numbers || [], online: false, registered: 0 })),
          agents: agents.map((agent) => ({ ext: agent.ext, name: agent.name, ari: agent.ari, voice: agent.voice })),
          trunk: estate.trunk?.name || '',
          routeNames: [],
        }
      : null;
  }

  const tally = { up: 0, configured: 0, missing: 0 };
  for (const project of projects) {
    if (project.state === 'up') tally.up += 1;
    else if (project.state === 'not configured') tally.missing += 1;
    else tally.configured += 1;
  }

  return {
    at: new Date().toISOString(),
    name: system.name || 'CHRIST',
    tagline: system.tagline || '',
    domain: system.domain || estate?.domain || '',
    layers,
    projects,
    switch: switched,
    wiring,
    tally,
  };
}
