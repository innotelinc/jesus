import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { installAuth } from './plugins/auth.js';
import { HttpError } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'web', 'dist');

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.isProd ? 'warn' : 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  // Softphone presence/intent channel. Registered at the root because the
  // upgrade happens before any route prefix is applied.
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  // Per-route limits only: the public directory must stay fast and cheap.
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  // Audio and attachments arrive as a raw request body. The type decides the
  // stored extension, so only formats the platform understands are accepted.
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'application/pdf', 'image/png', 'image/jpeg', 'image/tiff'],
    { parseAs: 'buffer', bodyLimit: config.mediaMaxBytes },
    (request, body, done) => done(null, body)
  );

  installAuth(app);

  // Baseline security headers. CSP is applied only for the built SPA so the
  // Vite dev server and its HMR websocket keep working.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    // The softphone needs the microphone and camera, and neither leaves the
    // page: geolocation stays off.
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self), display-capture=(self)');
    if (config.isProd) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
          // wss: is the switch's secure WebSocket; a TURN relay is reached over
          // UDP by the peer connection, not by fetch, so nothing else opens up.
          "script-src 'self'; connect-src 'self' wss:; font-src 'self' data:; " +
          "media-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'self'"
      );
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (error.validation) {
      return reply.status(400).send({
        error: { code: 'validation_failed', message: error.message, details: error.validation },
      });
    }
    if (error.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    request.log.error(error);
    return reply.status(error.statusCode || 500).send({
      error: {
        code: 'internal_error',
        message: config.isProd ? 'Something went wrong' : error.message,
      },
    });
  });

  await app.register(registerRoutes, { prefix: '/api' });

  if (existsSync(dist)) {
    // `wildcard: true` matters: with per-file routes a hashed asset built after
    // startup is not registered, and the SPA fallback would answer a .js request
    // with index.html — the browser then refuses it as a bad MIME type.
    await app.register(fastifyStatic, { root: dist, wildcard: true, index: ['index.html'] });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
      }
      if (request.method !== 'GET') {
        return reply.status(405).send({ error: { code: 'method_not_allowed', message: 'Method not allowed' } });
      }
      // A stale page asking for an old hashed asset must get a 404, never
      // index.html: the browser rejects the HTML as a module script. Scoped to
      // /assets/ because /d/<host> paths legitimately end in a TLD.
      if (request.url.startsWith('/assets/')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Asset not found' } });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
      }
      return reply
        .status(404)
        .type('text/plain')
        .send('UI not built yet. Run `npm run build`, or use `npm run dev:web` for the dev server.');
    });
  }

  app.get('/healthz', async () => ({ ok: true, uptime: Math.round(process.uptime()) }));

  return app;
}
