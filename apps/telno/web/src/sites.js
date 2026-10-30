/**
 * One product, seven doors.
 *
 * The estate answers on seven domains and each of them is somebody's first
 * impression, so which page a visitor lands on is a decision, not a redirect
 * accident. The rules:
 *
 *   telno.services   the product, the price, the signup — and the address mail
 *                    is sent from
 *   telno.online     buy it now: a plan, a card, a working extension
 *   telno.mobi       the phone in a pocket: the softphone, the native app
 *   telno.digital    numbers as records: the registry and the lookup
 *   telno.tel        handsets: sign in, or let a desk phone provision itself
 *   telno.directory  the phonebook itself — no landing page in front of it
 *   telno.network    the estate: every layer and whether it is up (CHRIST)
 *
 * Every door serves the same application; this file only decides what it says
 * when it opens. A host that is not listed falls back to the brand's own copy,
 * which is what a local port, a preview URL and an operator's own domain get.
 */

export const SITES = {
  'telno.services': {
    role: 'product',
    eyebrow: 'Telno Services',
    headline: 'The phone system your business answers with.',
    lede:
      'One number for calls, fax, text and video, with voice agents that pick up after hours and campaigns whose calls are graded against their own goal. Plans are monthly, numbers are yours, and every message we send comes from this domain.',
    primary: { label: 'See the plans', to: '#pricing' },
    secondary: { label: 'Open the console', to: '/login' },
  },
  'telno.online': {
    role: 'signup',
    eyebrow: 'Start online',
    headline: 'A working extension before your coffee goes cold.',
    lede:
      'Pick a plan, pay by card, and your first number is live in minutes — no sales call, no installer, no waiting for a port. Add your team when you are ready.',
    primary: { label: 'Choose a plan', to: '#pricing' },
    secondary: { label: 'I already have an account', to: '/login' },
  },
  'telno.mobi': {
    role: 'mobile',
    eyebrow: 'Telno Mobi',
    headline: 'Your desk phone, in your pocket.',
    lede:
      'Answer the office line from anywhere with encrypted audio and video in the browser, or the native app on your phone. Calls ring wherever you are, and the console shows which device picked up.',
    primary: { label: 'Open the softphone', to: '/softphone' },
    secondary: { label: 'See the plans', to: '#pricing' },
  },
  'telno.digital': {
    role: 'numbers',
    eyebrow: 'Telno Digital',
    headline: 'Every number you own, on the record.',
    lede:
      'Numbers are registry records, not rows buried in a PBX. Look one up, claim one, port one in, and see exactly what it is and who answers it.',
    primary: { label: 'Look up a number', to: '#lookup' },
    secondary: { label: 'Get your own number', to: '#pricing' },
  },
  'telno.tel': {
    role: 'phones',
    eyebrow: 'Telno · Phones',
    headline: 'Sign in, and the phone rings.',
    lede:
      'This is the domain your handsets already know: the softphone lives here, and a desk phone pointed at it provisions itself by MAC address on first boot. Sign in to reach your line, voicemail and call history.',
    primary: { label: 'Sign in', to: '/login' },
    secondary: { label: 'Open the softphone', to: '/softphone' },
  },
  'telno.directory': {
    role: 'directory',
    // No hero: the phonebook is the page. Anything that would sit in front of it
    // is a click between a caller and the number they came for.
    directory: '/d/telno.directory',
  },
  'telno.network': {
    role: 'network',
    eyebrow: 'Telno Network',
    headline: 'The estate, layer by layer.',
    lede:
      'Cantus carries the calls, a SIP border meets the carriers, and the agents speak on top of them. This door shows what is up right now — served by the board itself, not a marketing page about it.',
    primary: { label: 'See the plans', to: '#pricing' },
    secondary: { label: 'Open the console', to: '/login' },
    // Served by CHRIST, not this app; the entry exists so the map is complete.
    upstream: 'christ',
  },
};

/** `Example.TEL:8090` → `example.tel`. */
export function hostOf(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/**
 * The site this request belongs to, or null for the brand's default.
 *
 * `?site=telno.mobi` previews a door without owning its DNS — the deployer and
 * the tests use it, and it is the only reason a host can be named in a query.
 */
export function siteFor(host, search = '') {
  const asked = new URLSearchParams(search).get('site');
  const key = hostOf(asked || host);
  return SITES[key] ? { ...SITES[key], host: key } : null;
}

/** Where a domain's front door goes, for hosts that are not a landing page. */
export function entryPath(host) {
  const site = SITES[hostOf(host)];
  return site?.directory || null;
}
