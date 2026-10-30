#!/usr/bin/env node
/**
 * Prove a softphone registers, end to end, over the public URL.
 *
 * A browser softphone is three things that each look fine alone: a session from
 * the platform, a ticket the switch will accept, and a line that actually
 * registers. A ticket handed out but never registered is the failure that reads
 * as "the phone just doesn't ring", so this connects the socket the browser
 * connects and then asks the switch whether it sees the line.
 *
 * Two details are what make a headless check possible at all, and both were
 * learned the hard way:
 *
 *   - the media socket is `/api/softphone/line`, while `/api/softphone/ws` is
 *     the operator's control socket. `status.socketUrl` is the label the console
 *     prints, not the path the browser dials;
 *   - the route is behind the session gate (the browser has its cookie), so the
 *     upgrade needs the session token too, not only the ticket.
 *
 *   node scripts/softphone-check.mjs <base-url> <email> <password> [extension]
 */

import WebSocket from 'ws';

const [base, email, password, extension = '101'] = process.argv.slice(2);
if (!base || !email || !password) {
  process.stderr.write('usage: softphone-check.mjs <base-url> <email> <password> [ext]\n');
  process.exit(2);
}
const root = base.replace(/\/$/, '');

const login = await fetch(`${root}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(15_000),
});
if (!login.ok) {
  process.stderr.write(`login failed: ${login.status} ${(await login.text()).slice(0, 200)}\n`);
  process.exit(1);
}
const { token } = await login.json();

const session = await fetch(`${root}/api/softphone/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ extension }),
  signal: AbortSignal.timeout(15_000),
});
const body = await session.json();
if (!session.ok) {
  process.stderr.write(`session refused: ${session.status} ${JSON.stringify(body).slice(0, 300)}\n`);
  process.exit(1);
}

const line = body.extension?.extension || body.line?.extension || extension;
const socket = new URL('/api/softphone/line', root);
socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
socket.searchParams.set('ticket', body.ticket);
socket.searchParams.set('ext', String(line));

const ws = new WebSocket(socket, { headers: { authorization: `Bearer ${token}` } });
let first = null;
ws.on('message', (data) => {
  if (first === null) first = String(data).slice(0, 200);
});

const closed = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ code: 0, reason: 'still open after 4s' }), 4_000);
  ws.on('open', () => {
    process.stdout.write(`socket open at ${socket.origin}${socket.pathname} (line ${line})\n`);
  });
  ws.on('close', (code, reason) => {
    clearTimeout(timer);
    resolve({ code, reason: String(reason || '') });
  });
  ws.on('error', (error) => {
    clearTimeout(timer);
    resolve({ code: -1, reason: error.message });
  });
});

const status = await fetch(`${root}/api/softphone/status`, { headers: { authorization: `Bearer ${token}` } });
const phone = await status.json();

process.stdout.write(
  `ticket ${String(body.ticket || '').length} chars, ttl ${body.expiresIn}s · ` +
    `switch connected=${phone.switch?.connected} mode=${phone.switch?.mode} calls=${phone.switch?.calls}\n` +
    `first frame: ${first || '(none)'}\n` +
    `close: code=${closed.code} ${closed.reason}\n`
);

ws.close();
process.exit(closed.code === 0 || closed.code === 1000 || closed.code === 1005 ? 0 : 1);
