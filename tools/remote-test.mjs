// Test the brain the way a REMOTE machine actually reaches it: over the tailnet IP, with a
// recall-scoped token.
//
// WHY THIS EXISTS. deep-test.mjs and stress-test.mjs both talk to 127.0.0.1 holding the server's
// own full-scope token. That is not what a laptop client or the locked-down client machine do, and it silently
// skipped the two things most likely to break for them:
//
//   1. TLS over the tailnet address. The cert is pinned, so if its SAN ever stops covering
//      100.x, every remote machine fails to verify while loopback keeps passing every test here.
//      A cert regeneration is exactly when that happens, and the locked-down client machine cannot reach
//      GitHub to receive a fix.
//   2. Recall scope. the locked-down client holds a recall token because it is a company laptop and must
//      never read the owner's credentials. Nothing proved it can still do its job, or that the vault
//      is genuinely shut to it, from the caller's side rather than by reading the source.
//
// It mints its own throwaway recall token, uses it, and revokes it. The value is written to a
// file by token.mjs and never passed in argv or printed.
//
// Run: node tools/remote-test.mjs

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Forward slashes: a curl config reads a backslash as an escape. See the comment in stress-test.mjs.
const CERT = join(BRAIN, 'server-cert.pem').split('\\').join('/');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const execFileAsync = promisify(execFile);
const NL = String.fromCharCode(10);

const results = [];
const pass = (n, d) => { results.push(1); console.log('  PASS  ' + n.padEnd(34) + d); };
const fail = (n, d) => { results.push(0); console.log('  FAIL  ' + n.padEnd(34) + d); };
const warn = (n, d) => { console.log('  WARN  ' + n.padEnd(34) + d); };

// Find the tailscale binary WITHOUT hardcoding a Windows path.
//
// This used to be C:/Program Files/Tailscale/tailscale.exe, which fails on a Windows machine
// that installed it anywhere else, and on macOS and Linux entirely. PATH first is also the
// only form that works when this ships to someone who is not us.
function tailscaleBin() {
  const candidates = ['tailscale',
    'C:/Program Files/Tailscale/tailscale.exe',
    '/usr/bin/tailscale', '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return c;
    } catch { /* next */ }
  }
  return null;
}
// ---- the tailnet address, which is the whole point of this file --------------------------------
let TAILNET = '';
try {
  const bin = tailscaleBin();
  if (!bin) throw new Error('tailscale not found on PATH or any known location');
  TAILNET = execFileSync(bin, ['ip', '-4'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim().split(NL)[0].trim();
} catch { /* not installed or not up */ }
if (!/^100\./.test(TAILNET)) {
  console.log('  Tailscale is not reporting a tailnet address, so the remote path cannot be tested.');
  console.log('  This is the only suite that covers how other machines actually connect. Not passing it silently.');
  process.exit(1);
}
// The target is the PUBLISHED server endpoint, never this machine.
//
// It used to be https://<local tailscale ip>:8443, which is correct on the host by coincidence
// and wrong everywhere else. a laptop client ran it on 2026-09-05 and it aimed at a laptop client, where
// nothing listens on 8443. So the one suite whose entire purpose is covering how a REMOTE
// machine reaches the brain could not be run from a remote machine, and on the host it was
// quietly testing the host against itself while being reported as the remote path.
const ENDPOINT = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8'));
let BASE = String(ENDPOINT.url || '');
while (BASE.endsWith('/')) BASE = BASE.slice(0, -1);
if (!BASE || BASE.includes('127.0.0.1') || BASE.includes('localhost')) {
  console.log('  server-endpoint.json publishes ' + (BASE || 'nothing') + ', which is loopback.');
  console.log('  This suite exists to test the non-loopback path, so it will not pretend to pass.');
  process.exit(1);
}
const SELF = BASE.includes(TAILNET);
console.log('  target: ' + BASE + (SELF ? '  (this machine IS the host)' : '  (a REMOTE server, the real case)'));
console.log('  from:   ' + TAILNET);

// ---- a throwaway recall token, so this tests the real scope, not the server's own -------------
const NAME = 'REMOTETEST';
let MINTED = true;
const TOKFILE = join(tmpdir(), 'havok-remotetest.token');
try { execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'revoke', NAME], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); } catch { /* absent */ }
// Wrapped, because minting only works on the host. Off-host this throws, and it threw on a laptop client
// with EPERM from Defender Controlled Folder Access. Unwrapped, it killed the process before it
// could reach the fallback written directly below for exactly this case. Found by a laptop client,
// which proved it by patching a copy rather than by suggesting it.
try {
  execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'issue', NAME, '--scope', 'recall', '--out', TOKFILE],
    { stdio: 'ignore', windowsHide: true, timeout: 20000 });
} catch { /* not the host, or the write was blocked: the fallback below handles it */ }
let recallToken = '';
try { recallToken = readFileSync(TOKFILE, 'utf8').trim(); } catch { /* minting failed */ }

// Only the host can mint: token.mjs writes the server's own registry. On a remote machine that
// registry does not exist, and on a laptop client the write also hit EPERM from Defender Controlled
// Folder Access. Falling back to this machine's real token is not a weaker test, it is a more
// honest one: it exercises the credential the machine actually uses every day.
if (!recallToken) {
  try {
    recallToken = readFileSync(join(homedir(), '.claude', 'havok-server-token'), 'utf8').trim();
  } catch { /* none */ }
  if (recallToken) {
    MINTED = false;
    console.log("  token: could not mint one, using this machine own token instead");
  }
}
if (!recallToken) { console.log('  no token to test with, minting failed and this machine has none'); process.exit(1); }

function cleanup() {
  try { execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'revoke', NAME], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); } catch { /* gone */ }
  try { unlinkSync(TOKFILE); } catch { /* gone */ }
}

function confFile(lines) {
  const f = join(tmpdir(), 'rt_' + process.pid + '_' + results.length + '.conf');
  writeFileSync(f, lines.join(NL) + NL, 'utf8');
  return f;
}

async function call(path, { token = recallToken, body = null, pin = true } = {}) {
  const lines = [
    'header = "Authorization: Bearer ' + token + '"',
    'url = "' + BASE + path + '"',
    'silent', 'connect-timeout = 8', 'max-time = 120',
    'write-out = "|CODE:%{http_code}"',
  ];
  if (pin) lines.push('cacert = "' + CERT + '"');
  let bodyFile = null;
  if (body) {
    bodyFile = join(tmpdir(), 'rt_body_' + process.pid + '_' + results.length + '.json');
    writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
    lines.push('header = "content-type: application/json"', 'request = "POST"',
      'data-binary = "@' + bodyFile.split('\\').join('/') + '"');
  }
  const conf = confFile(lines);
  try {
    const { stdout } = await execFileAsync('curl', ['-K', conf], { windowsHide: true, timeout: 130000, maxBuffer: 16 * 1024 * 1024 });
    const s = String(stdout);
    const code = (s.match(/\|CODE:(\d+)/) || [])[1] || '000';
    const raw = s.split('|CODE:')[0];
    let json = null; try { json = JSON.parse(raw); } catch { /* not json */ }
    return { code, raw, json };
  } catch (e) {
    const s = String((e && e.stdout) || '');
    const code = (s.match(/\|CODE:(\d+)/) || [])[1] || '000';
    return { code, raw: s.split('|CODE:')[0], json: null, curlError: String(e.message).slice(0, 90) };
  } finally { try { unlinkSync(conf); if (bodyFile) unlinkSync(bodyFile); } catch { /* gone */ } }
}

// ---- 1. TLS over the tailnet address, pinned ---------------------------------------------------
{
  const r = await call('/health');
  r.code === '200'
    ? pass('TLS verifies on the tailnet IP', 'pinned cert accepted at ' + TAILNET)
    : fail('TLS verifies on the tailnet IP', 'health ' + r.code + ' ' + (r.curlError || '') +
      ' -- if this says certificate, the SAN no longer covers ' + TAILNET + ' and every remote machine is locked out');
}

// ---- 2. recall, the thing remote machines are actually for -------------------------------------
{
  const t = Date.now();
  const r = await call('/recall', { body: { prompt: 'verify before claiming anything works' } });
  const ranked = (r.json && r.json.ranked) || [];
  const ms = Date.now() - t;
  ranked.length > 0
    ? pass('recall over the tailnet', ranked.length + ' memories in ' + ms + 'ms, top: ' + ranked[0].slug)
    : fail('recall over the tailnet', 'code ' + r.code + ', ' + ranked.length + ' memories');
  if (ranked.length && ms > 1500) warn('recall latency', ms + 'ms over the tailnet, slower than the ~70ms loopback path');
}

// ---- 3. rules and index, the rest of the read surface ------------------------------------------
{
  const rules = await call('/rules');
  const n = (rules.json && (rules.json.rules || []).length) || 0;
  n > 0 ? pass('rules over the tailnet', n + ' rules served') : fail('rules over the tailnet', 'code ' + rules.code + ', ' + n + ' rules');

  const v = await call('/index/version');
  (v.code === '200' && v.json && v.json.version)
    ? pass('index version', String(v.json.version).slice(0, 24))
    : fail('index version', 'code ' + v.code);
}

// ---- 4. THE BOUNDARY: recall scope must not reach the vault ------------------------------------
// This is the check that matters most. the locked-down client is a company laptop; if this ever passes traffic,
// the owner's credentials are on a machine his employer administers.
{
  const list = await call('/vault/list');
  const get = await call('/vault/get/anything');
  const pass1 = list.code === '403';
  const pass2 = get.code === '403';
  // Only meaningful with a token we minted at recall scope. Under the fallback this is the
  // machine's OWN token, which may legitimately be broader, so a 200 here proves nothing about
  // scope enforcement. It printed "A RECALL MACHINE CAN READ THE VAULT" on a laptop client, which was
  // false and reads as a breach. A check that cannot run must say so, never accuse.
  if (!MINTED) {
    warn('vault shut to a recall token', 'SKIPPED: using this machine’s own token, not a recall-scoped one');
  } else if (pass1 && pass2) {
    pass('vault shut to a recall token', 'both /vault/list and /vault/get returned 403');
  } else {
    fail('vault shut to a recall token', '/vault/list ' + list.code + ', /vault/get ' + get.code + ' -- A RECALL MACHINE CAN READ THE VAULT');
  }
  const said = (list.json && (list.json.detail || list.json.error)) || '';
  /ask the owner|do not retry/i.test(said)
    ? pass('refusal tells the agent what to do', 'names the owner and says do not retry')
    : warn('refusal wording', 'a refused agent may just retry: ' + String(said).slice(0, 70));
}

// ---- 5. a recall machine CAN still write. It is not a read-only client -------------------------
// The owner, 2026-08-24: the brain is 100% on the server and writes go through it. The locked-down client machine
// cannot reach GitHub at all, so if a recall token could not write, that machine could never record
// anything again. It landed 17 real memories the day it was connected.
{
  const slug = 'reference_stress_remote';
  const content = '---' + NL + 'name: Remote write probe' + NL
    + 'description: probe proving a recall-scoped machine on the tailnet can still write a memory to the server' + NL
    + 'type: reference' + NL + '---' + NL + NL + 'See [[reference_deep_test_probe]].' + NL;
  const r = await call('/memory', { body: { slug, content } });
  (r.code === '200' && r.json && r.json.ok)
    ? pass('recall token can write', 'accepted over the tailnet, indexed')
    : fail('recall token can write', 'code ' + r.code + ' ' + JSON.stringify(r.json || r.raw).slice(0, 90));
  // Reachable by recall straight after, or the write was cosmetic.
  const back = await call('/recall', { body: { prompt: 'remote write probe recall scoped machine tailnet' } });
  const hit = ((back.json && back.json.ranked) || []).some((m) => m.slug === slug);
  hit ? pass('and it is immediately findable', 'the write reindexed before returning')
    : fail('and it is immediately findable', 'written but recall does not surface it');
  try { unlinkSync(join(BRAIN, 'memory', slug + '.md')); } catch { /* gone */ }
  try { execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], { cwd: BRAIN, stdio: 'ignore', windowsHide: true, timeout: 180000 }); } catch { /* best effort */ }
}

// ---- 6. /dist, the only delivery path a GitHub-blocked machine has -----------------------------
{
  const m = await call('/dist');
  const files = (m.json && m.json.files) || [];
  files.length > 0
    ? pass('/dist serves a manifest', files.length + ' files a blocked machine can self-update from')
    : fail('/dist serves a manifest', 'code ' + m.code + ' -- a machine that cannot reach the repo has no other update path');
  const hasCert = files.some((f) => /server-cert\.pem$/.test(f.path));
  hasCert ? pass('cert is redistributable', 'a regenerated cert can reach a blocked machine')
    : fail('cert is redistributable', 'server-cert.pem is not in /dist: regenerating it strands any machine that cannot reach the repo');
  // Match on the FILE, not on the name. The first version of this check flagged tools/vault.mjs and
  // tools/token.mjs, which are source code every remote machine needs in order to work at all, and
  // called a healthy allowlist a leak. What must never be served is the material itself: the
  // encrypted vault, the token database, the TLS private key, the age identities.
  const SECRETS = ['vault.json', 'havok-tokens.json', 'server-key.pem', 'havok-server-key.pem', 'havok-server-token'];
  const listed = files.filter((f) => SECRETS.includes(f.path.split('/').pop()) || /\.age$|\.key$/.test(f.path));
  listed.length === 0 ? pass('no secret material in /dist', 'manifest carries code and docs only')
    : fail('no secret material in /dist', 'EXPOSED: ' + listed.map((f) => f.path).join(', '));

  // And do not trust the manifest to be the whole story: ask for the vault directly. The allowlist
  // is the control, so this is the test of the control rather than of its advertisement.
  const direct = await call('/dist/vault.json');
  const trav = await call('/dist/..%2F..%2FUsers%2F<user>%2F.claude%2Fhavok-tokens.json');
  (direct.code !== '200' && trav.code !== '200')
    ? pass('/dist refuses what is off-list', 'vault.json ' + direct.code + ', traversal ' + trav.code)
    : fail('/dist refuses what is off-list', 'vault.json ' + direct.code + ', traversal ' + trav.code + ' -- ONE OF THESE SERVED');
}

// ---- 7. a revoked token stops working immediately -----------------------------------------------
// Revocation that needs a restart is not revocation. If this laptop is lost, the token must die now.
// PROVE IT WORKS FIRST. The first version of this check just revoked and asserted 401, and it
// passed while the token had never been valid at all: the server was reading a boot-time snapshot
// of the token file, so a freshly issued token was already 401. A test that cannot distinguish
// "revoked" from "never worked" is not testing revocation.
{
  // /index/version, NOT /health: health is deliberately unauthenticated so the boot script can
  // probe it, so a 200 there says nothing about whether this token is valid.
  // Revoking a token we did not mint would revoke the credential this machine runs on.
  if (!MINTED) {
    warn('revocation is immediate', 'SKIPPED: not our token to revoke, would lock this machine out');
  } else {
  const before = await call('/index/version');
  if (before.code !== '200') {
    fail('revocation is immediate', 'skipped: the token was not working before revoke (' + before.code + '), so this proves nothing');
  } else {
    execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'revoke', NAME], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    const r = await call('/recall', { body: { prompt: 'anything at all' } });
    r.code === '401'
      ? pass('revocation is immediate', 'worked, then 401 straight after revoke, no restart')
      : fail('revocation is immediate', 'a revoked token still got ' + r.code + ' -- a lost laptop stays connected');
  }
  }
}

cleanup();
const passed = results.reduce((a, b) => a + b, 0);
console.log('');
console.log('  ' + passed + ' passed, ' + (results.length - passed) + ' failed, ' + results.length + ' checks');
if (existsSync(TOKFILE)) console.log('  WARNING: test token file still on disk at ' + TOKFILE);
process.exit(passed === results.length ? 0 : 1);
