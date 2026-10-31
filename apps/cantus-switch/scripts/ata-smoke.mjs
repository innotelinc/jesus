#!/usr/bin/env node
/**
 * A real phone, registering on the deployed switch.
 *
 * `docker compose --profile core up -d switch` proves a container starts. This
 * proves the thing a container is for: a client registers on the line socket at
 * `102`, the switch rings `101`, the phone answers, and audio crosses in both
 * directions. It talks to the deployed box over the same WebSocket and control
 * API a softphone uses — no in-process shortcuts — so a failure here is a
 * deployment failure, not a unit-test failure.
 *
 *   node scripts/ata-smoke.mjs [http://127.0.0.1:8188] [token]
 *
 * The token defaults to CANTUS_CONTROL_TOKEN from the environment, then from
 * `christ/.env` in the tree this app belongs to. Exit status 0 means registered,
 * answered, and heard.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || process.env.CANTUS_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const token = process.argv[3] || process.env.CANTUS_CONTROL_TOKEN || envFromFile('CANTUS_CONTROL_TOKEN');
const FRAME_MS = 20;
const RUN_MS = 1400;

function envFromFile(name) {
  const file = join(here, '..', '..', '..', 'christ', '.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split('\n').find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

function wsUrl(ext) {
  return `${base.replace(/^http/, 'ws')}/ws/line?ext=${ext}&token=${encodeURIComponent(token)}`;
}

function say(ok, message) {
  console.log(`[ata] ${ok ? 'ok  ' : 'FAIL'} ${message}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

/** One line socket, with the media counters the switch sends and the ones we send. */
function phone(ext) {
  const state = { ext, registered: false, messages: [], receivedBytes: 0, peak: 0, heard: 0 };
  const socket = new WebSocket(wsUrl(ext));
  socket.binaryType = 'arraybuffer';
  state.socket = socket;
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      const bytes = Buffer.from(event.data);
      state.receivedBytes += bytes.length;
      for (let i = 0; i + 1 < bytes.length; i += 2) state.peak = Math.max(state.peak, Math.abs(bytes.readInt16LE(i)));
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    state.messages.push(message);
    if (message.type === 'registered') state.registered = true;
    if (message.type === 'answered') state.answered = true;
    if (message.type === 'ended') state.ended = true;
  });
  state.ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`line ${ext}: socket error`)), { once: true });
  });
  state.send = (message) => socket.send(JSON.stringify(message));
  return state;
}

/** A 1 kHz tone: audible, and unlike silence, measurable on the far end. */
function tone(phase, hz = 1000, amp = 6000, samples = 160, rate = 8000) {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.trunc(amp * Math.sin(phase + (2 * Math.PI * hz * i) / rate)), i * 2);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { label, timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ata = phone('101');
const caller = phone('102');

try {
  await Promise.all([ata.ready, caller.ready]);
  await waitFor(() => ata.registered && caller.registered, { label: 'both lines to register' });
  say(true, 'ext 101 and 102 registered on the deployed switch');
  await waitFor(
    async () => {
      const lines = await api('/v1/lines');
      return lines.find((line) => line.ext === '101')?.registered > 0;
    },
    { label: '/v1/lines to report 101 online' }
  );
  say(true, 'the switch reports 101 online');

  caller.send({ type: 'call', to: '101' });
  let callId;
  await waitFor(
    async () => {
      const calls = await api('/v1/calls');
      const ringing = calls.find((call) => call.state === 'ringing' && call.to.startsWith('101'));
      callId = ringing?.id;
      return !!callId;
    },
    { label: 'the call to ring 101' }
  );
  say(true, `call ${callId} is ringing 101`);

  // Answer as the phone would. The socket protocol is the fast path; the
  // control API is the same action from a client whose message name this
  // script does not know, and either is a real answer.
  const offer = ata.messages.find((message) => message.callId === callId);
  if (offer) ata.send({ type: 'answer', callId });
  else await api(`/v1/calls/${callId}/answer`, { method: 'POST' });

  await waitFor(async () => (await api(`/v1/calls/${callId}`)).state === 'answered', { label: 'the call to answer' });
  say(true, '101 answered');

  // Both ends speak, so both ends have to hear.
  let phase = 0;
  const timers = [ata, caller].map((end) =>
    setInterval(() => {
      phase += (2 * Math.PI * 1000 * 160) / 8000;
      try {
        end.socket.send(tone(phase));
      } catch {
        /* the call ended under us; the verdict below says so */
      }
    }, FRAME_MS)
  );
  await sleep(RUN_MS);
  for (const timer of timers) clearInterval(timer);

  say(ata.receivedBytes > 0, `101 heard ${ata.receivedBytes} octets, peak ${ata.peak}`);
  say(caller.receivedBytes > 0, `102 heard ${caller.receivedBytes} octets, peak ${caller.peak}`);
  const audible = ata.peak > 0 && caller.peak > 0;
  say(audible, 'the call was audible in both directions');

  const detail = await api(`/v1/calls/${callId}`);
  say(detail.legs.some((leg) => leg.state === 'answered'), `legs: ${detail.legs.map((leg) => `${leg.ext || leg.role}:${leg.state}`).join(', ')}`);

  await api(`/v1/calls/${callId}`, { method: 'DELETE' }).catch(() => {});
  say(ata.receivedBytes > 0 && caller.receivedBytes > 0 && audible, 'RESULT: registered, answered, audible');
  process.exitCode = ata.receivedBytes > 0 && caller.receivedBytes > 0 && audible ? 0 : 1;
} catch (err) {
  say(false, err.message);
  process.exitCode = 1;
} finally {
  for (const end of [ata, caller]) {
    try {
      end.socket.close();
    } catch {
      /* already closed */
    }
  }
}
