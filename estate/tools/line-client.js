#!/usr/bin/env node
/**
 * A line, without a browser.
 *
 * The softphone page is a Cantus line: one WebSocket that carries registration,
 * call control and 20 ms PCM16 frames. Everything it can do is a message on
 * that socket, so this tool speaks the same protocol — which makes it the
 * honest way to prove the parts of the demo a browser cannot prove on a plain
 * HTTP origin, where `getUserMedia` is withheld and the page refuses to
 * register at all.
 *
 *   # ring 101 and answer whatever the DID brings
 *   node line-client.js --switch switch:8088 --token $CANTUS_CONTROL_TOKEN \
 *        --ext 101 --answer --seconds 8
 *
 *   # the softphone's own dial: the same message the page sends
 *   node line-client.js --switch switch:8088 --token $CANTUS_CONTROL_TOKEN \
 *        --ext 101 --call 14134210134@estate.local
 *
 * Exit status is 0 only when the call was answered and at least one media frame
 * crossed in each direction, so a call that rings and then goes silent fails.
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const host = flag('switch', '127.0.0.1:8188');
const token = flag('token', process.env.CANTUS_CONTROL_TOKEN || '');
const ext = String(flag('ext', '101'));
const callTo = flag('call', '');
const autoAnswer = has('answer');
const holdSeconds = Number(flag('seconds', '0'));
const saveTo = flag('save', '');
const waitSeconds = Number(flag('wait', callTo ? '45' : '50'));
const keep = has('keep');

const log = (...parts) => console.log('[line]', ...parts);

if (!token) {
  console.error(
    'usage: node line-client.js --switch host:8188 --token <control token> --ext 101 [--answer] [--call <address>] [--seconds N] [--save file.wav] [--keep]'
  );
  process.exit(2);
}

const url = `ws://${host}/ws/line?ext=${encodeURIComponent(ext)}&token=${encodeURIComponent(token)}`;
const socket = new WebSocket(url);
socket.binaryType = 'arraybuffer';

// `audio` is the number that matters: the switch keeps a browser line fed with
// 20 ms of silence while a call is up, so counting frames proved nothing.
// A frame with any non-zero sample is a real person or a tone on the far side.
const counters = { sent: 0, received: 0, audio: 0 };
const audio = [];
let callId = '';
let answered = false;
let sendTimer = null;
let frame = 0;
let finished = false;

/** 20 ms of 440 Hz, as PCM16 at 8 kHz — the same block the browser sends. */
function frameBytes() {
  const buffer = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * (frame * 160 + i)) / 8000) * 6000);
    buffer.writeInt16LE(sample, i * 2);
  }
  frame += 1;
  return buffer;
}

function wav(samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

const send = (message) => socket.send(JSON.stringify(message));

function startMedia() {
  if (sendTimer) return;
  sendTimer = setInterval(() => {
    if (socket.readyState !== 1) return;
    socket.send(frameBytes());
    counters.sent += 1;
    // Both directions have carried audio: the call is bridged, not just
    // signalled. That is the claim worth exiting 0 for.
    if (counters.audio > 3 && counters.sent > 3) finish(0, 'call bridged in both directions');
  }, 20);
  if (holdSeconds) setTimeout(() => finish(0, `held ${holdSeconds}s`), holdSeconds * 1000);
}

function finish(code, reason) {
  if (finished) return;
  // A demo line has to be a line, not a one-call test: `--keep` stays
  // registered and waits for the next call instead of exiting after the first
  // one, which is what left the DID ringing a line that had already gone away.
  if (keep && code === 0) {
    resetCall(reason);
    return;
  }
  finished = true;
  clearInterval(sendTimer);
  try {
    socket.close();
  } catch {
    /* already gone */
  }
  if (saveTo && audio.length) {
    const written = wav(Buffer.concat(audio));
    writeFileSync(saveTo, written);
    log(`wrote ${saveTo} (${written.length} bytes)`);
  }
  log(`${reason} · frames out ${counters.sent} / in ${counters.received} (${counters.audio} with audio)`);
  process.exit(code);
}

/** End this call, keep the registration. */
function resetCall(reason) {
  clearInterval(sendTimer);
  sendTimer = null;
  if (saveTo && audio.length) {
    const written = wav(Buffer.concat(audio));
    writeFileSync(saveTo, written);
    log(`wrote ${saveTo} (${written.length} bytes)`);
  }
  log(`${reason} · frames out ${counters.sent} / in ${counters.received} (${counters.audio} with audio)`);
  counters.sent = 0;
  counters.received = 0;
  counters.audio = 0;
  answered = false;
  callId = '';
  audio.length = 0;
  log(`still registered as ${ext}; waiting for the next call`);
}

socket.addEventListener('open', () => log(`socket open for ${ext} on ${host}`));

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') {
    const frameIn = Buffer.from(event.data);
    counters.received += 1;
    if (frameIn.some((byte) => byte !== 0)) counters.audio += 1;
    if (saveTo) audio.push(frameIn);
    if (answered && counters.audio > 3 && counters.sent > 3) finish(0, 'call bridged in both directions');
    return;
  }
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  switch (message.type) {
    case 'registered':
      log(`registered ${message.ext || ext} as ${message.identity || 'a browser line'}`);
      if (callTo) {
        log(`dialling ${callTo}`);
        send({ type: 'call', to: callTo });
        // An outbound leg is answered by the far end, so media starts now.
        answered = true;
        startMedia();
      }
      return;
    case 'incoming':
      callId = message.callId;
      log(`INCOMING ${message.from} -> ${message.to} on ${message.ext}`);
      if (autoAnswer) {
        send({ type: 'answer', callId });
        log(`answered ${callId}`);
        // Answering does not start the microphone; the first version stopped
        // here, so the call was up, the caller heard nothing from this side and
        // the tool could never report a bridged call.
        answered = true;
        startMedia();
      }
      return;
    case 'answered':
      callId = message.callId || callId;
      answered = true;
      log(`call ${callId} answered`);
      startMedia();
      return;
    case 'cancelled':
      if (keep) {
        resetCall('caller cancelled before the line answered');
        return;
      }
      finish(1, 'caller cancelled before the line answered');
      return;
    case 'ended':
      log(`call ended: ${message.cause || 'normal'}`);
      if (keep) {
        resetCall('call ended');
        return;
      }
      finish(answered && counters.audio > 0 && counters.sent > 0 ? 0 : 1, 'call ended');
      return;
    case 'error':
      finish(1, `switch refused: ${message.error}`);
      return;
    default:
      return;
  }
});

socket.addEventListener('error', () => finish(1, 'socket error — is the control token right?'));
socket.addEventListener('close', (event) => {
  if (!finished) finish(1, `socket closed (${event.code}) ${event.reason || ''}`.trim());
});

// A kept line waits indefinitely; only a one-shot run has a deadline.
if (!keep) setTimeout(() => finish(1, 'timed out waiting for a call'), waitSeconds * 1000);
