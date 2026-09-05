#!/usr/bin/env node
// Update this machine's brain FROM THE the host, with no git.
//
// The owner, 2026-08-24: "full brain in the server, the git is just a backup."
// The owner, 2026-09-04: "forget about github, github should be just a backup, the repo and the memory
//                    should all run locally syncing fetching etc."
//
// WHY THIS EXISTS. The locked-down client machine cannot reach GitHub, blocked on the corporate WiFi. It
// reaches the brain server fine over Tailscale, so reads and writes already worked, but the code,
// the certificate, the memories and the index all still arrived only through the repo. If the
// certificate were ever regenerated, that machine would be locked out permanently with no delivery
// path left, since Taildrop is dead on that link too. A machine should need nothing but a token
// and the tailnet.
//
// GITHUB IS NOW WRITE-ONLY, AND ONLY FROM the host. No other machine pulls from it or pushes to it.
// The repo is a disaster copy in case the server is lost, nothing more. Every machine syncs here.
//
// WHY A FULL LOCAL COPY RATHER THAN LIVE CALLS. Recall already falls back to the server when a
// machine holds no index, but that costs a round trip per turn and dies with the tailnet. Holding
// the real files locally means recall runs at local speed and keeps working offline.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH:
//   vault.json           the server refuses to serve it and this never asks
//   anything outside the server's published manifest
//
// WRITES STILL GO THROUGH THE the host. Never hand-create a file in memory/ on a machine that syncs:
// this tool treats anything the server does not list as deleted and moves it to .sync-trash/.
// Write memories with POST /memory so the server owns them, then they come back here.
//
// Usage:
//   node tools/pull-from-server.mjs           update what has changed
//   node tools/pull-from-server.mjs --check   report only, change nothing
//   node tools/pull-from-server.mjs --quiet   for the timer: log to file, print nothing, exit 0
//   node tools/pull-from-server.mjs --force   ignore the cheap version probe, compare every file

import {
  readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync, appendFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = join(BRAIN, 'server-cert.pem');
const CHECK = process.argv.includes('--check');
const QUIET = process.argv.includes('--quiet');
const FORCE = process.argv.includes('--force');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const LOG = join(BRAIN, '.pull-from-server.log');
const STATE = join(BRAIN, '.pull-from-server.state');

// Directories this tool is allowed to consider authoritative, meaning a local file in one of them
// that the server does not list is treated as deleted. Code directories are NOT in this list: a
// stray local tool is somebody's work in progress, not garbage.
//
// DELIBERATELY EMPTY since 2026-09-04, so nothing is ever swept. It held memory and index for a
// few hours the same day and that was withdrawn: the brain lives on the server, recall goes to
// the server, and no machine needs a copy of the memories on disk.
//
// Do not refill this without reading reference_git_timer_vs_server_sweep_race. A sweep on a
// machine that also runs git costs a race, permanent git dirt and a wedged pull.
const MIRRORED = [];

// If the server lists fewer memories than this, something is wrong with it and we do NOT sweep.
// Deleting 260 memories because a misconfigured server answered with an empty list is the one
// failure this tool must never have.
const MIN_MEMORIES_TO_TRUST = 50;

// A file the server does not list is only swept once it has had time to get there. a laptop client
// caught this on 2026-09-04: a machine running BOTH this mirror and a git timer has two writers,
// and the git one can deliver a memory the server has not ingested yet.
//
//   minute 0  another machine commits a memory, a laptop client git-pulls it into memory/
//   minute 1  this mirror sees a file the server does not list, and sweeps it
//
// MIN_MEMORIES_TO_TRUST does not catch that: it is one file, not a mass wipe, so it is silent.
// The real fix is that no machine should have a second writer, but correctness must not depend on
// every machine being configured right. Anything touched recently gets a grace period, which is
// long enough for the server to catch up through any path. A genuinely deleted memory was last
// written when it was synced, hours or days ago, so it still goes.
const SWEEP_GRACE_MS = 10 * 60 * 1000;

function out(s) {
  if (!QUIET) process.stdout.write(s + NL);
  try {
    if (existsSync(LOG) && statSync(LOG).size > 1024 * 1024) writeFileSync(LOG, '');
    appendFileSync(LOG, new Date().toISOString() + String.fromCharCode(9) + s + NL);
  } catch { /* a full disk must not crash the timer */ }
}
// In quiet mode nothing is a failure worth a red mark in Task Scheduler: the next run retries.
const done = (code) => process.exit(QUIET ? 0 : code);

const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
let token = '';
try { token = readFileSync(join(CONFIG_DIR, 'havok-server-token'), 'utf8').trim(); } catch { /* none */ }
if (!token) {
  out('NO TOKEN on this machine, at ' + join(CONFIG_DIR, 'havok-server-token') + '.');
  out('Ask the owner to arm a bootstrap, then collect it. Not calling with an empty credential, because');
  out('the 401 would look like the server being down.');
  done(1);
}

let base = process.env.HAVOK_SERVER_URL;
if (!base) {
  try { base = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url; } catch { /* none */ }
}
if (!base) { out('no server endpoint published, cannot update'); done(1); }
while (base.endsWith('/')) base = base.slice(0, -1);

// Token in a curl config on stdin, never argv.
function fetch(path, binary) {
  const conf = [
    'header = "Authorization: Bearer ' + token + '"',
    'url = "' + base + path + '"',
    'silent', 'connect-timeout = 5', 'max-time = 60',
  ];
  if (base.slice(0, 6).toLowerCase() === 'https:' && existsSync(CERT)) {
    conf.push('cacert = "' + CERT.split(BS).join('/') + '"');
  }
  return execFileSync('curl', ['-K', '-'], {
    input: conf.join(NL) + NL,
    encoding: binary ? null : 'utf8',
    windowsHide: true, timeout: 65000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

// ---- 1. Cheap probe first -----------------------------------------------------------------
// The manifest is ~35KB and makes the server hash every file. On a two-minute timer that is
// pure waste, since almost every run has nothing to do. /dist/version is a stat-only digest.
let remoteVersion = null;
if (!FORCE) {
  try {
    const v = JSON.parse(fetch('/dist/version') || '{}');
    if (v && v.version) {
      remoteVersion = v.version;
      let seen = '';
      try { seen = readFileSync(STATE, 'utf8').trim(); } catch { /* first run */ }
      if (seen === remoteVersion) {
        if (!QUIET) out('already current (version ' + remoteVersion + ', ' + v.files + ' files)');
        done(0);
      }
    }
  } catch { /* old server with no version route, or unreachable: fall through to the manifest */ }
}

let manifest;
try { manifest = JSON.parse(fetch('/dist')); }
catch { out('server unreachable at ' + base + ', nothing changed'); done(1); }
if (!manifest || !Array.isArray(manifest.files)) {
  out('the server did not return a manifest. If this is a 403, this machine may not be permitted.');
  done(1);
}

// ---- 2. What differs ------------------------------------------------------------------------
const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const stale = [];
for (const f of manifest.files) {
  let mine = null;
  try { mine = readFileSync(join(BRAIN, f.path)); } catch { /* missing counts as stale */ }
  if (!mine || sha16(mine) !== f.sha) stale.push({ ...f, missing: !mine });
}

// ---- 3. What the server has deleted ----------------------------------------------------------
// A superseded memory has to disappear everywhere, or two machines answer the same question
// differently and neither of them is obviously wrong. Only memory/ and index/ are swept.
const published = new Set(manifest.files.map((f) => f.path));
const memoryCount = manifest.files.filter((f) => f.path.slice(0, 7) === 'memory/').length;
const orphans = [];
const spared = [];
if (memoryCount >= MIN_MEMORIES_TO_TRUST) {
  for (const d of MIRRORED) {
    let names = [];
    try { names = readdirSync(join(BRAIN, d)); } catch { continue; }
    for (const n of names) {
      const rel = d + '/' + n;
      const isSyncable = n.slice(-3) === '.md' || n.slice(-5) === '.json';
      if (!isSyncable || published.has(rel)) continue;
      let age = Infinity;
      try { age = Date.now() - statSync(join(BRAIN, rel)).mtimeMs; } catch { /* unreadable, treat as old */ }
      if (age < SWEEP_GRACE_MS) {
        spared.push(rel + ' (' + Math.round(age / 1000) + 's old)');
        continue;
      }
      orphans.push(rel);
    }
  }
} else if (MIRRORED.length && manifest.files.length) {
  out('NOT sweeping deletions: the server listed only ' + memoryCount + ' memories, below the '
    + MIN_MEMORIES_TO_TRUST + ' needed to trust it. Files were updated, none removed.');
}

for (const p of spared) out('held back, too recent to be sure it is a deletion: ' + p);

if (!stale.length && !orphans.length) {
  if (remoteVersion) { try { writeFileSync(STATE, remoteVersion); } catch { /* not fatal */ } }
  if (!QUIET) out('already current: ' + manifest.files.length + ' files match the server');
  done(0);
}

if (!QUIET || CHECK) {
  if (stale.length) {
    out(stale.length + ' file(s) differ from the server:');
    for (const f of stale.slice(0, 40)) out('   ' + (f.missing ? 'MISSING ' : 'stale   ') + f.path);
    if (stale.length > 40) out('   ... and ' + (stale.length - 40) + ' more');
  }
  if (orphans.length) {
    out(orphans.length + ' local file(s) the server no longer has:');
    for (const p of orphans.slice(0, 40)) out('   deleted ' + p);
  }
}
if (CHECK) { out('--check: nothing changed'); done(1); }

// ---- 4. Apply -------------------------------------------------------------------------------
let fixed = 0;
for (const f of stale) {
  try {
    const buf = fetch('/dist/' + encodeURIComponent(f.path).split('%2F').join('/'), true);
    // Verify BEFORE replacing. A truncated download must never overwrite a working hook.
    if (sha16(buf) !== f.sha) { out('   ' + f.path + ': download does not match the published hash, left alone'); continue; }
    const dest = join(BRAIN, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    // The temp file MUST sit beside the destination. It used to be written to tmpdir(), which is
    // on C: while the brain is on D:, and renameSync across volumes fails with EXDEV. Because the
    // rename sat inside this try, that surfaced as "fetch failed" and looked like a network fault.
    const tmp = dest + '.tmp-' + process.pid;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
    fixed++;
  } catch (e) {
    out('   ' + f.path + ': update failed, left alone (' + String(e.message).split(NL)[0].slice(0, 80) + ')');
  }
}

// Removals go to .sync-trash/, never to unlink. If this tool is ever wrong about what the server
// holds, the cost must be a folder to inspect and not a lost memory.
let removed = 0;
if (orphans.length) {
  const stampSrc = new Date().toISOString();
  let stamp = '';
  for (const ch of stampSrc) stamp += (ch === ':' || ch === '.') ? '-' : ch;
  const trash = join(BRAIN, '.sync-trash', stamp);
  for (const rel of orphans) {
    try {
      const dest = join(trash, rel);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(BRAIN, rel), dest);
      removed++;
    } catch (e) {
      out('   ' + rel + ': could not move to trash, left in place (' + String(e.message).split(NL)[0].slice(0, 60) + ')');
    }
  }
  if (removed) out('moved ' + removed + ' removed file(s) to .sync-trash/' + stamp);
}

const okAll = fixed === stale.length && removed === orphans.length;
out('updated ' + fixed + ' of ' + stale.length + ' file(s), removed ' + removed + ' of '
  + orphans.length + ', from ' + base);

// Only record the version once everything actually landed, so a partial run retries next time.
if (remoteVersion && okAll) { try { writeFileSync(STATE, remoteVersion); } catch { /* not fatal */ } }

if (fixed && stale.some((f) => f.path.slice(0, 6) === 'hooks/')) {
  out('NOTE: hooks changed. A running Claude Code session loads hooks at start, so restart the');
  out('session or they will not take effect this turn.');
}
done(okAll ? 0 : 1);
