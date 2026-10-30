/**
 * What the console says when the switch is unreachable, and what a call leaves
 * behind when it is not.
 *
 * Both are regressions that only showed up on a live box. The status pill read
 * "AMI: fetch failed" — a transport nobody speaks any more and a message with no
 * host and no cause, which sends an operator to look at Docker when the actual
 * answer was "nothing is listening at switch:8088". And the switch's opening
 * event wrote a disposition the column's CHECK constraint rejects, so every
 * inbound call threw instead of being recorded: the history stayed empty and the
 * dashboard said no calls had ever arrived.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CantusClient, transportError } from '../src/telephony/cantus.js';

/** A fetch that fails the way undici does: a bare message, the reason in cause. */
function refusingFetch(code = 'ECONNREFUSED') {
  return async () => {
    const cause = Object.assign(new Error(code === 'ECONNREFUSED' ? 'connect ECONNREFUSED 172.18.0.5:8088' : code), { code });
    throw new TypeError('fetch failed', { cause });
  };
}

test('a refused switch is named, with its host and cause', async () => {
  const client = new CantusClient({ baseUrl: 'http://switch:8088', fetchImpl: refusingFetch() });
  await assert.rejects(
    () => client.status(),
    (err) => {
      assert.match(err.message, /cannot reach the switch at switch:8088/);
      assert.match(err.message, /nothing is listening there/);
      assert.match(err.message, /ECONNREFUSED/);
      // The original is kept, so a log can still show the stack.
      assert.equal(err.cause.cause.code, 'ECONNREFUSED');
      assert.equal(err.code, 'ECONNREFUSED');
      return true;
    }
  );
});

test('a name that does not resolve says so instead', () => {
  const err = transportError('http://switch:8088', 'GET', '/v1/status', new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }));
  assert.match(err.message, /that name does not resolve/);
  assert.match(err.message, /ENOTFOUND/);
});

test('a call that rings is recorded, and answered calls keep their numbers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telno-calls-'));
  process.env.DATA_DIR = dir;
  process.env.DB_FILE = join(dir, 'telno.db');
  process.env.TELEPHONY_SIMULATE = 'true';
  try {
    // Imported after the environment is set: the config is read at import.
    const { onEvent } = await import('../src/telephony/index.js');
    const { db_ } = await import('../src/db/index.js');

    // The switch says which way the call went; a leg to an extension without it
    // is an internal one, which is why the event carries it.
    onEvent({ type: 'call.incoming', callId: 'c-1', direction: 'inbound', from: '14134210134', to: '101@estate.local' });
    const ringing = db_.get('SELECT * FROM calls WHERE call_id = ?', ['c-1']);
    assert.ok(ringing, 'the inbound call left a row');
    assert.equal(ringing.from_number, '14134210134');
    assert.equal(ringing.to_number, '101@estate.local');
    assert.equal(ringing.extension, '101');
    assert.equal(ringing.direction, 'inbound');

    onEvent({ type: 'call.answered', callId: 'c-1', ext: '101' });
    onEvent({ type: 'call.ended', callId: 'c-1', cause: 'normal' });
    const ended = db_.get('SELECT * FROM calls WHERE call_id = ?', ['c-1']);
    assert.equal(ended.disposition, 'answered');
    assert.ok(ended.answered_at);
    assert.equal(db_.all('SELECT id FROM calls WHERE call_id = ?', ['c-1']).length, 1, 'one row per leg, not one per event');

    // A call nobody picked up is a no-answer, not a missing row.
    onEvent({ type: 'call.incoming', callId: 'c-2', direction: 'inbound', from: '14134210134', to: '102@estate.local' });
    onEvent({ type: 'call.ended', callId: 'c-2', cause: 'no-answer' });
    assert.equal(db_.get('SELECT disposition FROM calls WHERE call_id = ?', ['c-2']).disposition, 'no-answer');

    // An outbound leg is outbound because the address it was asked for is a
    // number, and it keeps the number it dialled.
    onEvent({ type: 'call.originated', callId: 'c-3', from: '101', to: '14134210134@trunk' });
    const out = db_.get('SELECT * FROM calls WHERE call_id = ?', ['c-3']);
    assert.equal(out.direction, 'outbound');
    assert.equal(out.to_number, '14134210134@trunk');
  } finally {
    // Windows will not unlink a database that is still open, and the WAL file
    // holds the only useful bytes if it is. Closing first is also what a test
    // run on a shared box should do rather than leaving a handle per run.
    const { closeDb } = await import('../src/db/index.js');
    closeDb();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a locked temp file is not a failing assertion */
    }
    delete process.env.DATA_DIR;
    delete process.env.DB_FILE;
    delete process.env.TELEPHONY_SIMULATE;
  }
});
