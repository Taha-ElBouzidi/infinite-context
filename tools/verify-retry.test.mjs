// The session start says "brain verify FAILED" only for a real failure. A verify that ran out of time is reported as
// not finished (it takes about 25 s on the host, the limit it runs under; a timeout read as FAILED reached HAVOK on
// 2026-11-03). A fast failure is checked once more after VERIFY_RETRY_MS: one that ran during a push or an index
// rebuild passes a moment later. A slow failure is not retried, so the session start stays inside its time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWithRetry, VERIFY_RETRY_MS, VERIFY_RETRY_IF_UNDER_MS } from './session-setup.mjs';

const runner = (answers) => { const calls = []; return { calls, run: () => { calls.push(1); return answers.shift(); } }; };

test('a pass needs one run and no wait', () => {
  const r = runner([{ ok: true, ms: 20000 }]); const waits = [];
  assert.equal(verifyWithRetry(r.run, (ms) => waits.push(ms)).ok, true);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a fast failure followed by a pass is a pass: the brain was busy, not broken', () => {
  const r = runner([{ ok: false, ms: 2000 }, { ok: true, ms: 2000 }]); const waits = [];
  const v = verifyWithRetry(r.run, (ms) => waits.push(ms));
  assert.equal(v.ok, true);
  assert.equal(v.retried, true);
  assert.deepEqual(waits, [VERIFY_RETRY_MS]);
});

test('two fast failures are a failure', () => {
  const r = runner([{ ok: false, ms: 2000 }, { ok: false, ms: 2000 }]);
  const v = verifyWithRetry(r.run, () => {});
  assert.equal(v.ok, false);
  assert.equal(v.timedOut, undefined);
  assert.equal(r.calls.length, 2);
});

test('a verify that ran out of time is not a failure and is not retried', () => {
  const r = runner([{ ok: false, timedOut: true, ms: 25000 }]); const waits = [];
  const v = verifyWithRetry(r.run, (ms) => waits.push(ms));
  assert.equal(v.ok, false);
  assert.equal(v.timedOut, true);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a slow failure is not retried: a second run would not fit the session start', () => {
  const r = runner([{ ok: false, ms: VERIFY_RETRY_IF_UNDER_MS + 1 }]);
  const v = verifyWithRetry(r.run, () => {});
  assert.equal(v.ok, false);
  assert.equal(r.calls.length, 1);
});

test('a retried run fits in the dispatcher limit of 30 s', () => {
  assert.ok(VERIFY_RETRY_IF_UNDER_MS * 2 + VERIFY_RETRY_MS < 30000);
});
