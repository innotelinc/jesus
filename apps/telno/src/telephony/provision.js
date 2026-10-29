import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db_ } from '../db/index.js';
import { config } from '../config.js';
import { callerIdString } from '../lib/scif.js';

/**
 * The database is the source of truth; the switch's routing document is
 * generated from it, never hand-edited.
 *
 * There is no `.conf` tree and no dialplan language any more. What is produced
 * is one JSON document — validated by Cantus (`apps/cantus/lib/Cantus/Router.pm`
 * and `apps/cantus-switch/src/router.js` validate the same schema) — plus the
 * line and trunk inventory the switch registers. A route is a glob on the
 * dialled address, an optional predicate, and an ordered list of actions; the
 * first match wins and evaluation is offline-testable.
 *
 *   node -e "…" > routes.json && perl -Ilib apps/cantus/bin/cantus route-test routes.json --to 100@telno.local
 */

const safe = (value, fallback = '') =>
  String(value ?? '')
    .replace(/[^A-Za-z0-9_.@*+-]/g, '')
    .slice(0, 96) || fallback;

const digits = (value) => String(value ?? '').replace(/\D/g, '');
const plain = (value) => String(value ?? '').replace(/[\r\n"]/g, ' ').slice(0, 80);

/** Where the generated switch documents live (shared with the switch volume). */
export const switchDir = () => String(config.telephony.configDir || join(config.dataDir, 'cantus')).replace(/\/+$/, '');

/** Every extension, trunk and number the switch has to know about. */
export function inventory() {
  const extensions = db_.all('SELECT * FROM extensions WHERE enabled = 1 ORDER BY extension');
  const trunks = db_.all('SELECT * FROM trunks WHERE enabled = 1 ORDER BY name');
  const flows = db_.all('SELECT * FROM ivr_flows WHERE enabled = 1 ORDER BY extension');
  const dids = db_.all(
    `SELECT n.id AS number_id, n.e164, n.fax_mode, e.extension, e.display_name
       FROM numbers n
       JOIN extensions e ON e.number_id = n.id
      WHERE e.enabled = 1`
  );
  const agents = db_.all(
    `SELECT name, number_id, record_inbound, record_outbound
       FROM voice_agents
      WHERE status = 'active' AND number_id IS NOT NULL`
  );
  return {
    extensions,
    trunks,
    flows,
    dids,
    policy: new Map(agents.map((agent) => [agent.number_id, agent])),
  };
}

/** The line inventory the switch registers, one entry per extension. */
export function generateLines() {
  const { extensions, trunks } = inventory();
  return {
    domain: config.telephony.domain,
    lines: extensions.map((ext) => ({
      ext: String(ext.extension),
      displayName: plain(ext.display_name),
      // A DID that belongs to this extension is another name the switch answers
      // for, which is how an inbound carrier call reaches the right line.
      numbers: db_.all('SELECT e164 FROM numbers WHERE id = ?', [ext.number_id]).map((row) => String(row.e164)),
      voicemail: !!ext.voicemail,
      dnd: ext.dnd === 1,
      forwardTo: ext.forward_to ? String(ext.forward_to) : '',
      callername: callerIdString(ext),
    })),
    trunks: trunks.map((trunk) => ({
      name: String(trunk.name),
      // A trunk is a Cantus endpoint on the carrier gateway. The gateway speaks
      // Cantus to us and whatever it likes to the carrier; that boundary is the
      // one place a PSTN protocol still exists, and it is not in this platform.
      endpoint: `${safe(trunk.name, 'trunk')}@${safe(trunk.host, 'gateway.invalid')}`,
      numbers: trunk.from_user ? [digits(trunk.from_user)] : [],
      from: digits(trunk.from_user),
      enabled: true,
    })),
  };
}

/**
 * The routing document.
 *
 * Order matters and it is the whole dial plan: a specific DID beats an
 * extension pattern, an extension beats the generic internal pattern, and
 * anything unmatched is rejected rather than answered into silence.
 */
export function generateRoutes() {
  const { extensions, trunks, flows, dids, policy } = inventory();
  const routes = [];
  const extensionNumbers = new Set(extensions.map((ext) => String(ext.extension)));
  const parkedLines = new Set(
    config.parking.enabled && config.apns.enabled && config.apns.ringOnDial
      ? db_.all('SELECT DISTINCT extension FROM push_devices').map((row) => String(row.extension))
      : []
  );

  // ---- inbound DIDs ---------------------------------------------------------
  for (const did of dids) {
    const number = digits(did.e164);
    if (!number) continue;
    const agent = did.number_id ? policy.get(did.number_id) : null;
    const inboundScif = extensions.some((ext) => ext.scif && String(ext.extension) === String(did.extension));
    const actions = [];
    // A SCIF line is never recorded, whatever the agent policy says. The route
    // is where recording actually happens, so this is the check that matters.
    if (agent?.record_inbound && !inboundScif) {
      actions.push({ record: { name: `inbound-${safe(agent.name, 'agent')}-${number}` } });
    }
    if (did.extension) {
      actions.push({ bridge: { to: String(did.extension), timeout: 25 } });
      actions.push({ play: { file: 'voicemail-greeting' } });
      actions.push({ record: { name: `vm-${safe(did.extension)}-${number}` } });
      actions.push({ reject: 0 });
    } else {
      actions.push({ play: { file: 'no-service' } });
      actions.push({ reject: 2 });
    }
    // Carriers differ on what they put in the request URI for a North American
    // number: some send eleven digits, some ten. Both names are answered.
    for (const name of number.length === 11 && number.startsWith('1') ? [number, number.slice(1), `+${number}`] : [number, `+${number}`]) {
      routes.push({ name: `did-${name}`, when: { to: `${name}*` }, then: actions });
    }
  }

  // ---- extensions ----------------------------------------------------------
  for (const ext of extensions) {
    const number = String(ext.extension);
    const actions = [];
    if (ext.dnd === 1) {
      actions.push({ reject: 1 }); // BUSY: do-not-disturb is a busy signal, not silence
    } else if (ext.forward_to) {
      actions.push({ forward: { to: String(ext.forward_to) } });
    } else {
      actions.push({ bridge: { to: number, timeout: 25 } });
      // Nobody answered: the line's greeting, a recorded message, and a normal
      // release. Parking comes first for a line with a phone that can be woken.
      if (ext.voicemail) {
        actions.push({ play: { file: 'voicemail-greeting' } });
        actions.push({ record: { name: `vm-${safe(number)}` } });
      }
      actions.push({ reject: 0 });
    }
    routes.push({ name: `line-${number}`, when: { to: `${number}@*` }, then: actions });
  }

  // ---- IVR flows -----------------------------------------------------------
  for (const flow of flows) {
    const number = String(flow.extension);
    let options = [];
    try {
      options = JSON.parse(flow.options || '[]');
    } catch {
      options = [];
    }
    // Answer, play the menu, and wait. The digits are separate routes; the
    // `timeout` event is what the switch raises when nobody presses one.
    routes.push({
      name: `ivr-${number}`,
      when: { to: `${number}@*` },
      then: [{ answer: {} }, { play: { file: `ivr-${number}`, timeout: 5 } }],
    });
    for (const option of options) {
      const digit = safe(option.digit, '').slice(0, 1);
      const target = safe(option.target, '');
      if (!digit || !target) continue;
      // A digit press is its own route: same address, `event` says which key.
      routes.push({
        name: `ivr-${number}-${digit}`,
        when: { to: `${number}@*`, event: digit },
        then: [{ bridge: { to: target, timeout: 25 } }, { reject: 0 }],
      });
    }
    routes.push({
      name: `ivr-${number}-timeout`,
      when: { to: `${number}@*`, event: 'timeout' },
      then: flow.timeout_dest ? [{ bridge: { to: String(flow.timeout_dest) } }, { reject: 0 }] : [{ reject: 0 }],
    });
  }

  // ---- internal dialling ---------------------------------------------------
  routes.push({
    name: 'internal-1xx',
    when: { to: '1??@*' },
    then: [{ bridge: { to: '*', timeout: 25 } }, { reject: 1 }],
  });

  // Retrieving a call that waits in a numbered parking space. The app dials the
  // space the push named, which is an ordinary number to the switch.
  if (parkedLines.size) {
    routes.push({
      name: 'park-retrieve',
      when: { to: '7???@*' },
      then: [{ answer: {} }],
    });
  }

  // ---- outbound ------------------------------------------------------------
  if (trunks.length) {
    const recorderExtensions = extensions
      .filter((ext) => ext.number_id && policy.get(ext.number_id)?.record_outbound && !ext.scif)
      .map((ext) => String(ext.extension));
    routes.push({
      name: 'outbound',
      when: { to: '+*' },
      then: [
        ...(recorderExtensions.length ? [{ record: { name: 'outbound' } }] : []),
        // `trunk`, not `bridge`: this call has to leave the switch. A bridge
        // rings lines, so the outbound route used to ring a line named after
        // the number and give up with `no-answer`.
        { trunk: { to: '*' } },
        { reject: 1 },
      ],
    });
    routes.push({ name: 'national', when: { to: '1??????????@*' }, then: [{ trunk: { to: '*' } }] });
  }

  const scif = extensions.filter((ext) => ext.scif).map((ext) => String(ext.extension));
  return {
    version: 1,
    // The document names its own domain so a reader can tell which box it came
    // from without asking the switch.
    domain: config.telephony.domain,
    // Recorded in the document because it is a policy a reader should be able to
    // see; the enforcement is the recorder list above, which never includes a
    // SCIF line in the first place.
    notes: scif.length ? [`SCIF lines never record: ${scif.join(', ')}`] : [],
    default: { reject: 3 },
    routes,
  };
}

/** Both documents, as files the switch can load on its next boot. */
export function generateConfigs() {
  return {
    'routes.json': `${JSON.stringify(generateRoutes(), null, 2)}\n`,
    'lines.json': `${JSON.stringify(generateLines(), null, 2)}\n`,
  };
}

/** Write the generated documents where the switch reads them. */
export function writeConfigs() {
  const dir = switchDir();
  mkdirSync(dir, { recursive: true });
  const files = generateConfigs();
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  // Prompts and recordings are shared with the switch: a prompt written here is
  // playable there, and a recording written there is readable here.
  for (const sub of ['prompts', 'recordings']) {
    mkdirSync(join(config.dataDir, sub), { recursive: true });
  }
  return { written: true, dir, files: Object.keys(files) };
}

/** True when the switch has already loaded a routing document. */
export const routesExist = () => existsSync(join(switchDir(), 'routes.json'));
