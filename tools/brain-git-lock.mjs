// One queue for every program that indexes, commits or pushes the brain repository on this machine.
//
// The owner, 2026-10-31, after one agent's save failed because another save was committing at the same moment: "we gotta
// fix this add a queue system or a stack or parallel async or anything". Before this, each writer (save-brain.mjs, the
// brain server's memory queue, its vault store) only retried git's own index.lock for a few seconds. A commit holds
// that lock for as long as the pre-commit gate runs (25 s and more), so a second save gave up and its memory was never
// committed (reproduced by the test in the 2026-10-31 session: save B failed, b.md never reached the remote).
//
// Now a writer takes this lock first and keeps it through index, commit and push; the others wait their turn instead
// of failing. The lock is a file created with O_EXCL, holding the owner's pid, host, purpose and start time. A holder
// that died (its pid is gone) or held it longer than any real save is cleared, so a crash never blocks the brain.
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK = join(BRAIN, '.git', 'havok-write.lock');
// Longer than any honest hold: build-index up to 180 s, commit up to 240 s, push up to 120 s.
const STALE_MS = 10 * 60 * 1000;
// How long a writer waits for its turn before it reports a failure.
const WAIT_MS = 15 * 60 * 1000;
// A lock file with no readable owner is a writer caught between create and write; after this it is garbage.
const UNREADABLE_GRACE_MS = 5000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// When this machine last started. A lock from an earlier start is dead whatever its pid says: after the nightly
// restart Windows often gives the dead owner's pid to another program, and every writer waited 10 minutes (audit
// 2026-11-01, tools/brain-git-lock.test.mjs). Uptime drifts a little against the clock, hence the margin.
const BOOT = Date.now() - os.uptime() * 1000;
const BOOT_MARGIN_MS = 60000;

function tryTake(by) {
  const me = JSON.stringify({ pid: process.pid, host: os.hostname(), by, at: new Date().toISOString(), boot: Math.round(BOOT) });
  try {
    const fd = openSync(LOCK, 'wx');
    try { writeSync(fd, me); } finally { closeSync(fd); }
    return me;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let raw = '', holder = null, age = 0;
  try { raw = readFileSync(LOCK, 'utf8'); holder = JSON.parse(raw); } catch { /* half written or just released */ }
  try { age = Date.now() - statSync(LOCK).mtimeMs; } catch { return null; }
  const earlierBoot = holder && Number(holder.boot) > 0 && Math.abs(Number(holder.boot) - BOOT) > BOOT_MARGIN_MS;
  const dead = holder && holder.host === os.hostname() && (earlierBoot || !alive(holder.pid));
  if (dead || age > STALE_MS || (!holder && age > UNREADABLE_GRACE_MS)) {
    // Only remove the very lock that was judged dead: another waiter may already have replaced it.
    try { if (readFileSync(LOCK, 'utf8') === raw) unlinkSync(LOCK); } catch { /* gone already */ }
  }
  return null;
}

function release(token) {
  try { if (readFileSync(LOCK, 'utf8') === token) unlinkSync(LOCK); } catch { /* already cleared as stale */ }
}

function holderText() {
  try { const h = JSON.parse(readFileSync(LOCK, 'utf8')); return h.by + ' (pid ' + h.pid + ', since ' + h.at + ')'; } catch { return 'unknown'; }
}

const pause = (n) => Math.min(250 * n, 2000) + Math.floor(Math.random() * 200);

export function withBrainLockSync(by, fn, waitMs = WAIT_MS) {
  const until = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let token = null;
  for (let n = 1; !(token = tryTake(by)); n += 1) {
    if (Date.now() > until) throw new Error('brain write lock still held after ' + Math.round(waitMs / 1000) + ' s by ' + holderText());
    Atomics.wait(nap, 0, 0, pause(n));
  }
  try { return fn(); } finally { release(token); }
}

export async function withBrainLock(by, fn, waitMs = WAIT_MS) {
  const until = Date.now() + waitMs;
  let token = null;
  for (let n = 1; !(token = tryTake(by)); n += 1) {
    if (Date.now() > until) throw new Error('brain write lock still held after ' + Math.round(waitMs / 1000) + ' s by ' + holderText());
    await new Promise((r) => setTimeout(r, pause(n)));
  }
  try { return await fn(); } finally { release(token); }
}
