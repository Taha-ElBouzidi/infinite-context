// Make this machine's index match the server's, and say so when it did not.
//
// The owner, 2026-08-22: "make the brain on this machine, and github only a copy backup, so later when
// this solution is perfected we can get a VPS and host it there."
//
// This is the read path of that. The server publishes a content hash of its index; a machine
// computes the same hash over its own copy and repairs any file whose hash differs. Divergence
// stops being something you discover by accident.
//
// WHY NOT JUST git pull
// A pull works and stays as the fallback, but it depends on GitHub being reachable and on the
// machine actually running it. This asks the machine that IS the source of truth, directly, which
// is the behaviour that has to exist before a VPS can host the brain.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not touch memory/. Only index/, which is generated output and therefore safe to
// overwrite wholesale. Overwriting a memory file from the network could destroy work that has not
// been committed yet, and no repair is worth that.
//
// On the HOST machine this is a no-op by design: the host IS the source, so there is nothing to
// sync from and pulling its own index back over itself could only ever do harm.
//
// Usage:
//   node tools/brain-sync.mjs           repair if needed
//   node tools/brain-sync.mjs --check   report only, change nothing
//   node tools/brain-sync.mjs --quiet   say nothing when already current

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const QUIET = process.argv.includes('--quiet');
const NL = '\n';
const say = (s) => process.stdout.write(s + NL);

// Must match the server's list exactly, or the two hashes can never agree.
const INDEX_FILES = ['keywords.json', 'embeddings.json', 'rules.json', 'contact.md', 'feedback.md', 'project.md', 'reference.md', 'user.md', 'translate-system.txt'];

const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

function localIndex() {
  const files = {};
  const whole = createHash('sha256');
  for (const name of INDEX_FILES) {
    let buf = null;
    try { buf = readFileSync(join(BRAIN, 'index', name)); } catch { continue; }
    const sha = sha16(buf);
    files[name] = { bytes: buf.length, sha };
    whole.update(name + ':' + sha + '|');
  }
  return { version: whole.digest('hex').slice(0, 16), files };
}

const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
let host = '';
try { host = (JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase(); } catch { /* none */ }
if (host && host === me) {
  if (!QUIET) say('this machine (' + me + ') IS the source of truth, nothing to sync');
  process.exit(0);
}

// Where the server is, and the token, both discovered rather than configured.
let base = process.env.HAVOK_SERVER_URL;
if (!base) {
  try { base = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url; } catch { /* none */ }
}
if (!base) { if (!QUIET) say('no server endpoint published, staying on the local copy'); process.exit(0); }
base = base.replace(/\/$/, '');

// SAME PRECEDENCE AS brain-client.mjs: env, then the token file, then the vault.
//
// This asked the VAULT and nothing else, which made it impossible to use on exactly the machines it
// matters most for. The locked-down client machine holds a recall-scoped token on purpose, because it is a
// company machine that must never read the owner's credentials, so /vault/* answers 403 by design. This
// then found no token, printed "staying on the local copy" and exited 0. It runs from
// hooks/pre-turn.mjs, so that machine silently skipped every sync on every turn while looking fine.
// Found 2026-08-24 by the the client company assistant, which had to read both files to work out why.
//
// The vault stays last rather than being dropped: the host has no token file requirement and this
// path has worked there for weeks.
const TOKEN_FILE = resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-server-token');
let token = (process.env.HAVOK_SERVER_TOKEN || '').trim();
if (!token) { try { token = readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* no file on this machine */ } }
if (!token) {
  try {
    token = execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'get', 'havok_server_token'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* no vault access on this machine, which is normal and not an error */ }
}
if (!token) {
  if (!QUIET) say('no server token on this machine: looked at HAVOK_SERVER_TOKEN, ' + TOKEN_FILE
    + ', and the vault. Staying on the local copy.');
  process.exit(0);
}

// Token in a curl config on stdin, never argv.
function fetchRaw(path, binary) {
  const conf = [
    'header = "Authorization: Bearer ' + token + '"',
    'url = "' + base + path + '"',
    'silent', 'connect-timeout = 3', 'max-time = 30',
  ];
  // PIN THE CERTIFICATE. This file had no cert handling of any kind, so once the server moved to
  // TLS with a self-signed certificate every fetch here failed validation and this reported
  // "server unreachable" while the server was answering fine. The host never noticed because it
  // short-circuits above as the source of truth, so the only machines affected were the ones this
  // tool exists for. Every other client pins: brain-client.mjs, pull-from-server.mjs, pre-turn.mjs.
  //
  // Forward slashes, because a curl config reads a backslash as an escape character.
  // NEVER --insecure: it accepts any certificate, which is worse than plaintext because it looks
  // encrypted while anything on the path could impersonate the server and take the token above.
  if (/^https:/i.test(base)) {
    const cert = join(BRAIN, 'server-cert.pem');
    if (existsSync(cert)) conf.push('cacert = "' + cert.split('\\').join('/') + '"');
    else if (!QUIET) say('WARNING: no server-cert.pem in this clone, so TLS cannot be verified and every fetch will fail');
  }
  conf.push('');
  const confText = conf.join(NL);
  // encoding null returns a Buffer. 'buffer' is NOT a valid encoding and throws
  // "Unknown encoding: buffer", which is how the first version of this failed every fetch. It
  // failed safely, leaving the stale files untouched rather than half-writing them, but it
  // repaired nothing.
  return execFileSync('curl', ['-K', '-'], {
    input: confText, encoding: binary ? null : 'utf8', windowsHide: true, timeout: 35000, stdio: ['pipe', 'pipe', 'ignore'],
  });
}

let remote;
try { remote = JSON.parse(fetchRaw('/index/version')); }
catch { if (!QUIET) say('server unreachable at ' + base + ', staying on the local copy'); process.exit(0); }
if (!remote || !remote.version) { if (!QUIET) say('server did not return a version, staying on the local copy'); process.exit(0); }

const local = localIndex();
if (local.version === remote.version) {
  if (!QUIET) say('index current: ' + local.version + ' (' + remote.memories + ' memories)');
  process.exit(0);
}

const stale = INDEX_FILES.filter((n) => (local.files[n] || {}).sha !== (remote.files[n] || {}).sha && remote.files[n]);
say('INDEX DIVERGED. local ' + local.version + ', server ' + remote.version);
for (const n of stale) {
  const l = local.files[n], r = remote.files[n];
  say('   ' + n.padEnd(22) + (l ? l.bytes + ' bytes' : 'MISSING').padStart(12) + '  ->  ' + r.bytes + ' bytes');
}
if (CHECK) { say('--check: nothing changed'); process.exit(1); }

let fixed = 0;
for (const n of stale) {
  try {
    const buf = fetchRaw('/index/' + n, true);
    // A truncated download must never replace a good file, so verify the hash BEFORE swapping,
    // and write through a temp file so a crash mid-write cannot leave a half-file behind.
    if (sha16(buf) !== remote.files[n].sha) { say('   ' + n + ': fetched copy does not match the published hash, left alone'); continue; }
    const dest = join(BRAIN, 'index', n);
    const tmp = dest + '.sync-tmp';
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
    fixed++;
  } catch (e) {
    say('   ' + n + ': fetch failed, left alone (' + String(e.message).split(NL)[0].slice(0, 60) + ')');
  }
}

const after = localIndex();
say('repaired ' + fixed + ' of ' + stale.length + ' file(s), now ' + after.version
  + (after.version === remote.version ? ' (matches the server)' : ' (STILL DIFFERS, investigate)'));

// REPORT stale CODE, never replace it.
//
// This tool only ever repaired index/ files, so a machine could run for weeks on old tools and
// hooks and nothing would say so. That is not hypothetical: the locked-down client machine cannot reach
// GitHub, brain-sync does not carry code, and today's brain-client.mjs therefore had no route to
// it at all. the owner asked why it could not write, and the answer was that the client on that machine
// predated the write command. Nothing anywhere told it.
//
// It REPORTS and stops there. Auto-replacing executable code every turn would mean one bad push
// reaching every machine instantly, and hooks changing underneath a session that already loaded
// them. Discovery is the missing piece; applying stays a decision.
//
// Rate limited to once an hour by a stamp file, because this runs on EVERY turn and the check costs
// a request plus hashing 46 local files.
try {
  const STAMP = resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-code-check');
  let last = 0;
  try { last = Number(readFileSync(STAMP, 'utf8').trim()) || 0; } catch { /* never run */ }
  if (Date.now() - last > 3600_000) {
    writeFileSync(STAMP, String(Date.now()), 'utf8');
    const manifest = JSON.parse(fetchRaw('/dist'));
    const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const old = [];
    for (const f of manifest.files || []) {
      let mine = null;
      try { mine = readFileSync(join(BRAIN, f.path)); } catch { /* missing counts as stale */ }
      if (!mine || sha16(mine) !== f.sha) old.push(f.path);
    }
    if (old.length) {
      say('CODE IS STALE on this machine: ' + old.length + ' of ' + manifest.files.length
        + ' file(s) differ from the server, including ' + old.slice(0, 3).join(', ')
        + (old.length > 3 ? ' and ' + (old.length - 3) + ' more' : '') + '.');
      say('   Nothing was changed. Run: node tools/pull-from-server.mjs');
    }
  }
} catch { /* the code check must never break the index sync, which is this tool's actual job */ }

// Release the lock the per-turn hook takes before spawning this.
//
// Without this the lock only expires on its 5 minute staleness timer, so a repair that fails in
// two seconds would block the next attempt for the rest of those five minutes. Clearing it here
// means the very next turn retries. The timer stays as the backstop for this process being killed
// outright, which is the only case that can now leave it set.
try { unlinkSync(resolve(homedir(), '.claude', 'havok-index-syncing')); } catch { /* not held */ }

process.exit(after.version === remote.version ? 0 : 1);
