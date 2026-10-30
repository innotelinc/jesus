/**
 * The estate's front door, rendered from `domains.json`.
 *
 * Seven domains, seven jobs, one file that says which is which. The Caddyfile in
 * `deploy/` is generated from this map and tested against it, so the thing that
 * answers on the wire and the thing a reader believes are never two documents:
 * adding a host means editing `domains.json` and running `node cli.js edge`.
 *
 * The proxy is the only process in the estate that terminates TLS. Everything
 * behind it speaks plain HTTP on the container network, which is why each host
 * block is one line of intent — upstream, and the one redirect a domain needs.
 */

import { readFileSync } from 'node:fs';

export const HEADER = 'generated from christ/domains.json by `node cli.js edge` — do not edit by hand';

/**
 * Refuse a map that would leave a host unrouted or ambiguous.
 *
 * Called by the loader and by the renderer: a hand-built document in a test is
 * held to the same rules as the file, and a malformed host is a build failure
 * rather than a domain that resolves to nothing.
 */
export function validate(doc) {
  const hosts = Array.isArray(doc?.hosts) ? doc.hosts : [];
  const seen = new Set();
  for (const entry of hosts) {
    if (!entry.host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(entry.host)) {
      throw new Error(`domains.json: ${JSON.stringify(entry.host)} is not a hostname`);
    }
    if (seen.has(entry.host)) throw new Error(`domains.json: ${entry.host} is declared twice`);
    seen.add(entry.host);
    if (!entry.upstream || !/^[a-z0-9.-]+:\d+$/.test(entry.upstream)) {
      throw new Error(`domains.json: ${entry.host} has no usable upstream (got ${entry.upstream})`);
    }
  }
  if (!hosts.length) throw new Error('domains.json: no hosts declared');
  return { ...doc, hosts };
}

/** Load the map, refusing a file that would leave a host unrouted. */
export function loadDomains(path) {
  return validate(JSON.parse(readFileSync(path, 'utf8')));
}

/** `www` for a host, or '' when the host is already a www. */
const wwwOf = (host) => (host.startsWith('www.') ? '' : `www.${host}`);

/**
 * One host's block: the site address, then either a redirect or a proxy.
 *
 * A redirect domain gets `redir / <path> 302` only for the root: the phonebook
 * has paths of its own and rewriting them would break every link into it.
 */
function hostBlock(entry, { httpOnly = false } = {}) {
  // With TLS off a bare hostname still means :443 in Caddy, so the HTTP render
  // says `http://` out loud. That is the whole difference between the two
  // renders: one word in front of each name.
  const prefix = httpOnly ? 'http://' : '';
  const names = [entry.host, wwwOf(entry.host)]
    .filter(Boolean)
    .map((name) => `${prefix}${name}`)
    .join(', ');
  const lines = [`${names} {`, '\timport edge'];
  if (entry.redirect) {
    lines.push(`\tredir / ${entry.redirect} 302`);
    lines.push('\treverse_proxy ' + entry.upstream);
  } else {
    // The upstream answer is kept even when it is an error: a 502 from the
    // estate is the honest answer, and a proxy that swaps it for a branded page
    // hides a service that is down. Caddy keeps the Host header and adds the
    // X-Forwarded-* pair, which is what the app reads to know its own origin.
    lines.push(`\treverse_proxy ${entry.upstream}`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * The whole Caddyfile.
 *
 * `httpOnly` renders the same map with TLS off, which is how a box whose DNS
 * does not point at it yet is tested with Host headers: the routing decision is
 * the part being verified, and it is the same routing decision either way.
 */
export function renderCaddyfile(document, { httpOnly = false } = {}) {
  const doc = validate(document);
  const hosts = doc.hosts;
  const parts = [
    `# CHRIST edge — ${HEADER}.`,
    '#',
    '# One block per host in christ/domains.json. TLS is automatic for every name',
    '# here, which is why the box has to be able to reach Let\'s Encrypt on 80/443',
    '# and why the DNS records have to point at it.',
    '',
    '{',
    `\temail ${doc.acmeEmail || 'ops@telno.services'}`,
    '\tadmin off',
    // TLS is on unless this is the HTTP-only render; there is no third mode,
    // because "serve HTTP and hope for a certificate" is not a state.
    ...(httpOnly ? ['\tauto_https off'] : []),
    '\tservers {',
    '\t\ttrusted_proxies static private_ranges',
    '\t}',
    '}',
    '',
    '# Shared by every host: compression, the headers a public site should carry,',
    '# no server banner, and one probe that never touches an upstream — so the',
    '# edge answers while a service behind it is restarting.',
    '(edge) {',
    '\tencode zstd gzip',
    '\theader {',
    '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"',
    '\t\tX-Content-Type-Options nosniff',
    '\t\tReferrer-Policy strict-origin-when-cross-origin',
    '\t\t-Server',
    '\t}',
    '\trespond /healthz 200 "edge ok"',
    '}',
    '',
  ];
  for (const entry of hosts) parts.push(hostBlock(entry, { httpOnly }), '');
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

/** Which upstream a host resolves to, for tests and for the board. */
export function upstreamFor(doc, host) {
  const wanted = String(host || '').toLowerCase().replace(/:\d+$/, '');
  const bare = wanted.startsWith('www.') ? wanted.slice(4) : wanted;
  return doc.hosts.find((entry) => entry.host === bare);
}
