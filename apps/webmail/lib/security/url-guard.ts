import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blockedAddressRanges = new BlockList();
blockedAddressRanges.addAddress('0.0.0.0');
blockedAddressRanges.addAddress('127.0.0.1');
blockedAddressRanges.addSubnet('10.0.0.0', 8);
blockedAddressRanges.addSubnet('172.16.0.0', 12);
blockedAddressRanges.addSubnet('192.168.0.0', 16);
blockedAddressRanges.addSubnet('169.254.0.0', 16);
blockedAddressRanges.addAddress('::', 'ipv6');
blockedAddressRanges.addAddress('::1', 'ipv6');
blockedAddressRanges.addSubnet('fc00::', 7, 'ipv6');
blockedAddressRanges.addSubnet('fe80::', 10, 'ipv6');

const BLOCKED_HOSTNAMES = new Set(['localhost']);
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.localdomain'];

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function isBlockedIpAddress(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const family = isIP(normalized);
  if (family === 4) return blockedAddressRanges.check(normalized, 'ipv4');
  if (family === 6) return blockedAddressRanges.check(normalized, 'ipv6');
  return false;
}

/**
 * Returns true only when the URL targets a public host reachable over http(s).
 * Rejects loopback / RFC-1918 / link-local / ULA addresses, special hostname
 * suffixes (.local, .internal, .arpa, ...), URLs with embedded credentials,
 * and any hostname whose DNS resolves to a blocked address.
 *
 * Note: there is a TOCTOU window between this lookup and the eventual fetch().
 * Callers that need rebinding-safe behavior must additionally pin the resolved
 * IP at connect time (e.g. via a custom undici dispatcher).
 */
export async function isPublicHttpUrl(urlString: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return false;
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

  if (isBlockedIpAddress(hostname)) return false;
  if (isIP(hostname)) return true;

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) return false;
    return records.every((record) => !isBlockedIpAddress(record.address));
  } catch {
    return false;
  }
}
