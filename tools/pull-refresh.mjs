#!/usr/bin/env node
// PULL ONLY. Keeps SERVER's working copy current so its index reflects work other machines
// pushed straight to git instead of going through POST /memory.
//
// Why this exists, and why it is not sync-brain.mjs on a short timer:
// brain-server.mjs has no pull logic at all. A memory written through the server is instantly
// visible to every machine, because the server reindexes and every recall hits the server. But
// a machine that commits directly to git is invisible here until HavokBrainSync runs at 08:00
// or 20:00. Up to twelve hours blind.
//
// sync-brain.mjs cannot fill that gap. Its own header records that running it every five
// minutes, with pushing, twice swallowed in-progress work under a junk commit message. So this
// tool NEVER commits, NEVER pushes, and NEVER merges.
//
//   node tools/pull-refresh.mjs [--verbose]
//
// Exit 0 always. Anything unexpected is logged and swallowed, because this runs unattended on
// a timer and a crash loop is worse than a stale index.

import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.pull-refresh.log');
const VERBOSE = process.argv.includes('--verbose');

const stamp = () => new Date().toISOString();
function log(line) {
  const l = `${stamp()}\t${line}`;
  if (VERBOSE) console.log(l);
  try { appendFileSync(LOG, l + '\n'); } catch { /* a full disk must not crash the timer */ }
}

function git(args, timeout = 60000) {
  return execFileSync('git', ['-C', BRAIN, ...args], {
    encoding: 'utf8', timeout, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  if (!existsSync(join(BRAIN, '.git'))) { log('SKIP no .git'); process.exit(0); }

  // 1. A dirty tree means a session is mid-write. Touching git under it is how work gets lost.
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean);
  if (dirty.length) { log(`SKIP dirty tree, ${dirty.length} changed file(s)`); process.exit(0); }

  const before = git(['rev-parse', 'HEAD']);

  // 2. Fetch is always safe: it touches no working file.
  try {
    git(['fetch', '--quiet', 'origin'], 90000);
  } catch (e) {
    log(`SKIP fetch failed: ${String(e.message).split('\n')[0].slice(0, 120)}`);
    process.exit(0);
  }

  const remote = git(['rev-parse', 'origin/master']);
  if (remote === before) { log('ok already current'); process.exit(0); }

  // 3. Are we behind, ahead, or diverged? Only a pure fast-forward is safe to take.
  // `--left-right --count A...B` prints "<left> <right>": left = in A not B (ahead of origin),
  // right = in B not A (behind origin). Getting this order wrong makes the tool refuse every
  // legitimate pull and attempt one when diverged. It was wrong here until a test caught it.
  const [ahead, behind] = git(['rev-list', '--left-right', '--count', `HEAD...origin/master`])
    .split(/\s+/).map(Number);
  if (ahead > 0 && behind > 0) {
    log(`SKIP diverged, ${ahead} local / ${behind} remote. Needs a human.`);
    process.exit(0);
  }
  if (ahead > 0) { log(`SKIP ${ahead} unpushed local commit(s), nothing to pull`); process.exit(0); }

  // 4. --ff-only can only move the pointer forward. It can never merge and never rewrite.
  try {
    git(['merge', '--ff-only', 'origin/master'], 60000);
  } catch (e) {
    log(`SKIP ff-only refused: ${String(e.message).split('\n')[0].slice(0, 120)}`);
    process.exit(0);
  }

  const after = git(['rev-parse', 'HEAD']);
  if (after === before) { log('ok no movement'); process.exit(0); }

  // 5. Reindex ONLY when memory changed. The index is expensive and rebuilding it for a
  //    tooling-only commit is pure waste.
  const changed = git(['diff', '--name-only', `${before}..${after}`]).split('\n').filter(Boolean);
  const memoryTouched = changed.some((f) => f.startsWith('memory/'));
  const n = git(['rev-list', '--count', `${before}..${after}`]);

  if (!memoryTouched) {
    log(`ok pulled ${n} commit(s) ${before.slice(0, 7)}..${after.slice(0, 7)}, no memory change, index untouched`);
    process.exit(0);
  }

  try {
    execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], {
      cwd: BRAIN, timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(`WARN pulled ${n} but reindex FAILED: ${String(e.message).split('\n')[0].slice(0, 120)}`);
    process.exit(0);
  }

  // The rebuild may legitimately change index files. Leave them uncommitted: this tool does not
  // commit, and the server's next write or the twice-daily sync will carry them.
  const memFiles = changed.filter((f) => f.startsWith('memory/')).length;
  log(`ok pulled ${n} commit(s) ${before.slice(0, 7)}..${after.slice(0, 7)}, ${memFiles} memory file(s), reindexed`);
} catch (e) {
  log(`ERROR ${String(e.message).split('\n')[0].slice(0, 160)}`);
}
process.exit(0);
