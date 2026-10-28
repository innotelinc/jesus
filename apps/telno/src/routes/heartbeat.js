import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { deviceTokenHash } from '../lib/security.js';
import { DEVICE_STATES, normalizeIp } from '../lib/devices.js';
import { notFound, unauthorized } from '../lib/errors.js';
import * as v from '../lib/validate.js';

/**
 * Public device check-in.
 *
 * A device holds its own `dv_…` token (issued once, at provisioning time) and
 * presents it on every heartbeat. The token identifies the device, so a
 * compromised phone cannot report for another one, and no operator session is
 * involved: firmware can post this from a cron job or a phone's XML config.
 */
export default async function heartbeatRoutes(app) {
  app.post(
    '/devices/heartbeat',
    // A fleet checking in every few minutes is normal traffic, not abuse; the
    // limit only stops a runaway retry loop.
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body || {};
      const header = request.headers['x-device-token'];
      const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secret = String((Array.isArray(header) ? header[0] : header) || bearer || '').trim();
      if (!secret) throw unauthorized('A device token is required in x-device-token');

      const row = db_.get('SELECT * FROM devices WHERE token_hash = ?', [deviceTokenHash(secret)]);
      if (!row) throw unauthorized('That device token is not recognized');

      const status = body.status === undefined
        ? 'online'
        : v.oneOf(body.status, DEVICE_STATES, 'status');
      const ip = body.ip === undefined ? null : normalizeIp(body.ip);
      const firmware = body.firmware === undefined
        ? null
        : v.str(body.firmware, { name: 'firmware', max: 40, required: false });

      // A check-in is the only thing that moves last_seen_at: an operator
      // editing a row never fakes liveness.
      const seen = now();
      db_.run(
        `UPDATE devices
            SET status = ?, last_seen_at = ?,
                ip = COALESCE(?, ip),
                firmware = COALESCE(?, firmware),
                updated_at = ?
          WHERE id = ?`,
        [status, seen, ip || null, firmware, seen, row.id]
      );

      const fresh = db_.get(
        `SELECT d.*, s.name AS site_name, e.extension
           FROM devices d
           LEFT JOIN sites s ON s.id = d.site_id
           LEFT JOIN extensions e ON e.id = d.extension_id
          WHERE d.id = ?`,
        [row.id]
      );

      return {
        ok: true,
        device: {
          id: fresh.id,
          name: fresh.name,
          site: fresh.site_name || '',
          extension: fresh.extension || '',
          status: fresh.status,
          lastSeenAt: fresh.last_seen_at,
        },
        // What the device should schedule next, and when it would be considered
        // silent, so a firmware profile can be generated from this response.
        checkInSec: config.devices.checkInSec,
        staleAfterSec: config.devices.staleAfterSec,
        serverTime: seen,
      };
    }
  );

  // A device that is being retired or replaced can drop its own credential.
  app.delete('/devices/heartbeat', async (request, reply) => {
    const header = request.headers['x-device-token'];
    const secret = String((Array.isArray(header) ? header[0] : header) || '').trim();
    if (!secret) throw unauthorized('A device token is required in x-device-token');
    const row = db_.get('SELECT id FROM devices WHERE token_hash = ?', [deviceTokenHash(secret)]);
    if (!row) throw notFound('That device token is not recognized');
    db_.run("UPDATE devices SET token_hash = '', status = 'offline', updated_at = ? WHERE id = ?", [now(), row.id]);
    reply.status(200);
    return { ok: true };
  });
}
