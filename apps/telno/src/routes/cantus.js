import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
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
}
