import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db_, now } from '../db/index.js';
import { generateLines } from '../telephony/provision.js';

/**
 * The switch's view of this platform.
 *
 * A Cantus switch needs to know which lines exist and which numbers ring them.
 * That inventory lives here, in the database, so it is served here rather than
 * configured a second time on the switch. The switch polls it; a new extension
 * is dialable within half a minute without touching anything else.
 *
 * This is machine-to-machine and has no session: it is authenticated with the
 * shared control token, and it answers with nothing that is not already a line
 * name on the wire.
 */

function tokenMatches(request) {
  const expected = config.telephony.token;
  if (!expected) return false;
  const header = String(request.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const supplied = bearer || String(request.headers['x-cantus-token'] || '');
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export default async function cantusRoutes(app) {
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    if (!tokenMatches(request)) {
      reply.code(401).send({ error: 'unauthorized', message: 'this endpoint is for the switch, not a browser' });
    }
  });

  app.get('/cantus/lines', async () => {
    const inventory = generateLines();
    return {
      domain: inventory.domain,
      lines: inventory.lines.map((line) => ({
        ext: line.ext,
        displayName: line.displayName,
        numbers: line.numbers,
        voicemail: line.voicemail,
        dnd: line.dnd,
        forwardTo: line.forwardTo,
      })),
      trunks: inventory.trunks,
    };
  });

  app.get('/cantus/status', async () => ({
    domain: config.telephony.domain,
    switchUrl: config.telephony.url,
    application: 'telno',
  }));

  /**
   * A phone registered. The SIP border rings a handset and cannot store what it
   * learned about it — the inventory is this platform's, so the border reports
   * the contact here and the device row stops saying "provisioning" forever.
   * Keyed by extension, because that is the only identity a registrar knows; a
   * report for an extension no device carries is a 404, not a new row.
   */
  app.post('/cantus/devices/:ext/registered', async (request, reply) => {
    const ext = String(request.params.ext || '');
    const body = request.body || {};
    const row = db_.get(
      `SELECT d.id FROM devices d
         JOIN extensions e ON e.id = d.extension_id
        WHERE e.extension = ?`,
      [ext]
    );
    if (!row) {
      reply.status(404);
      return { error: 'unknown-device', ext };
    }
    const ip = String(body.ip || '').slice(0, 64);
    // A report without a MAC leaves the stored one alone: the border learns a
    // MAC only from a provisioning fetch, and blanking it would lose the row's
    // only hardware identity.
    const mac = String(body.mac || '').slice(0, 32);
    db_.run(
      `UPDATE devices
          SET ip = ?, mac = CASE WHEN ? = '' THEN mac ELSE ? END,
              status = 'online', last_seen_at = ?, updated_at = ?
        WHERE id = ?`,
      [ip, mac, mac, now(), now(), row.id]
    );
    return { ok: true, ext, device: row.id };
  });
}
