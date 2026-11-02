// node --test tools/brain-git-lock.test.mjs
// Audit 2026-11-01. A lock left by a save that was running when the machine restarted (a machine that restarts
// every night) names a process id that Windows often hands to another program after the restart. The owner then looked
// alive and every writer waited the full 10 minutes. Runs a copy of brain-git-lock.mjs in a temp folder with its own
// .git folder; the real lock is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, hostname, uptime } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

async function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gitlock-'));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, '.git'));
  copyFileSync(join(HERE, 'brain-git-lock.mjs'), join(root, 'tools', 'brain-git-lock.mjs'));
  const mod = await import(pathToFileURL(join(root, 'tools', 'brain-git-lock.mjs')).href);
  return { root, mod };
}

test('a lock from before the last restart is cleared even when its process id is alive again', async () => {
  const { root, mod } = await sandbox();
  try {
    const lastBoot = Date.now() - uptime() * 1000;
    // This test's own pid stands in for an unrelated program that got the dead owner's pid after the restart.
    writeFileSync(mod.LOCK, JSON.stringify({ pid: process.pid, host: hostname(), by: 'save-brain: before the restart', at: new Date(lastBoot - 3600e3).toISOString(), boot: lastBoot - 86400e3 }));
    const t = Date.now();
    const got = mod.withBrainLockSync('test', () => 'in', 3000);
    assert.equal(got, 'in');
    assert.ok(Date.now() - t < 2500, 'waited ' + (Date.now() - t) + ' ms');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live holder from this boot is still waited for', async () => {
  const { root, mod } = await sandbox();
  try {
    writeFileSync(mod.LOCK, JSON.stringify({ pid: process.pid, host: hostname(), by: 'live', at: new Date().toISOString(), boot: Date.now() - uptime() * 1000 }));
    assert.throws(() => mod.withBrainLockSync('test', () => 'in', 1200), /still held/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the lock written by a writer carries the boot time', async () => {
  const { root, mod } = await sandbox();
  try {
    const { readFileSync } = await import('node:fs');
    const seen = mod.withBrainLockSync('test', () => JSON.parse(readFileSync(mod.LOCK, 'utf8')));
    assert.ok(Math.abs(seen.boot - (Date.now() - uptime() * 1000)) < 60000, JSON.stringify(seen));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
