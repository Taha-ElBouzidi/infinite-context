// Adversarial tests. deep-test.mjs proves the happy paths and the designed refusals; this one
// tries to BREAK the server, because three machines now read and write it concurrently and a
// corrupted index or a half-written memory reaches all of them.
//
// Everything here is destructive-by-intent but self-cleaning: it writes only to slugs prefixed
// reference_stress_, removes them, and restores the generated files afterwards.
//
// Run: node tools/stress-test.mjs

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, copyFileSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// FORWARD SLASHES. A curl config treats a backslash as an escape character, so a Windows path
// built with join() silently becomes D:devHavokhavok-brainserver-cert.pem and every request
// fails with 'does not exist'. That is documented in the messaging memory and I still walked into
// it here, which is why it is written at the point of use rather than only in a memory.
const CERT = join(BRAIN, 'server-cert.pem').split('\\').join('/');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const token = readFileSync(join(CONFIG_DIR, 'havok-server-token'), 'utf8').trim();
// execFile, NOT exec. exec goes through cmd.exe on Windows and the quoting mangled every
// invocation, which made a healthy server look like eight failures including a dead /health.
// An argument array has no shell in the path at all.
const execFileAsync = promisify(execFile);
const NL = String.fromCharCode(10);

const results = [];
const pass = (n, d) => { results.push(1); console.log('  PASS  ' + n.padEnd(30) + d); };
const fail = (n, d) => { results.push(0); console.log('  FAIL  ' + n.padEnd(30) + d); };

function confFile(lines) {
  const f = join(tmpdir(), 'st_' + Math.random().toString(36).slice(2) + '.conf');
  writeFileSync(f, lines.join(NL) + NL, 'utf8');
  return f;
}

// Async so several can genuinely be in flight at once. execFileSync would serialise them and the
// concurrency test would prove nothing.
async function writeMemory(slug, content) {
  const body = join(tmpdir(), 'st_' + slug + '.json');
  writeFileSync(body, JSON.stringify({ slug, content }), 'utf8');
  const conf = confFile([
    'header = "Authorization: Bearer ' + token + '"',
    'header = "content-type: application/json"',
    'url = "https://127.0.0.1:8443/memory"',
    'request = "POST"',
    'data-binary = "@' + body.split('\\').join('/') + '"',
    'cacert = "' + CERT + '"', 'silent', 'max-time = 300',
  ]);
  try {
    const { stdout } = await execFileAsync('curl', ['-K', conf], { timeout: 310000, maxBuffer: 8 * 1024 * 1024 });
    try { return JSON.parse(stdout); } catch { return { raw: String(stdout).slice(0, 80) }; }
  } catch (e) {
    // curl exits non-zero on a refused connection, which for the oversized-body test is the
    // EXPECTED result. Return its stdout so the caller can judge, rather than calling it a failure.
    const out = (e && e.stdout) ? String(e.stdout) : '';
    try { return JSON.parse(out); } catch { return { raw: out || ('CURLFAIL ' + String(e.message).slice(0, 60)) }; }
  }
  finally { try { unlinkSync(body); unlinkSync(conf); } catch { /* gone */ } }
}

async function get(path) {
  const conf = confFile([
    'header = "Authorization: Bearer ' + token + '"',
    'url = "https://127.0.0.1:8443' + path + '"',
    'cacert = "' + CERT + '"', 'silent', 'max-time = 60',
    'write-out = "|CODE:%{http_code}"',
  ]);
  try {
    const { stdout } = await execFileAsync('curl', ['-K', conf], { timeout: 65000, maxBuffer: 8 * 1024 * 1024 });
    const code = (String(stdout).match(/\|CODE:(\d+)/) || [])[1];
    return { code, body: String(stdout).split('|CODE:')[0] };
  } catch (e) {
    const out = (e && e.stdout) ? String(e.stdout) : '';
    const code = (out.match(/\|CODE:(\d+)/) || [])[1];
    return { code: code || '000', body: out.split('|CODE:')[0] };
  }
  finally { try { unlinkSync(conf); } catch { /* gone */ } }
}

const FM = (n) => '---' + NL + 'name: Stress probe ' + n + NL
  + 'description: temporary stress-test memory number ' + n + ', written by tools/stress-test.mjs and removed' + NL
  + 'type: reference' + NL + '---' + NL + NL + 'See [[reference_deep_test_probe]].' + NL;

const made = [];

// ---- 1. CONCURRENT WRITES, different slugs --------------------------------------------------
// The real scenario: three machines writing at once. Each write reindexes and commits, so if that
// is not serialised the index or the git tree can be left inconsistent.
{
  const n = 5;
  const slugs = Array.from({ length: n }, (_, i) => 'reference_stress_' + i);
  made.push(...slugs);
  const rs = await Promise.all(slugs.map((s, i) => writeMemory(s, FM(i))));
  const ok = rs.filter((r) => r && r.ok).length;
  ok === n ? pass('5 concurrent writes', 'all ' + n + ' accepted')
    : fail('5 concurrent writes', ok + ' of ' + n + ' ok: ' + JSON.stringify(rs.map((r) => r.error || r.raw || 'ok')).slice(0, 90));

  // Every one must have a vector, or the index lost a write in the race.
  let emb = { slugs: [] };
  try { emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8')); } catch { /* none */ }
  const missing = slugs.filter((s) => !emb.slugs.includes(s));
  missing.length === 0 ? pass('index survived the race', 'all 5 have vectors')
    : fail('index survived the race', missing.length + ' lost their vector: ' + missing.join(', '));
}

// ---- 2. CONCURRENT WRITES, SAME slug ---------------------------------------------------------
// Last writer should win cleanly. What must never happen is a half-written or unparseable file.
{
  const slug = 'reference_stress_same';
  made.push(slug);
  const rs = await Promise.all([1, 2, 3].map((i) => writeMemory(slug, FM('same-' + i))));
  const ok = rs.filter((r) => r && r.ok).length;
  let parsable = false;
  try {
    const t = readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8');
    parsable = t.startsWith('---') && /^description:.+/m.test(t) && t.trim().endsWith('.');
  } catch { /* missing */ }
  (ok >= 1 && parsable) ? pass('same-slug race', ok + ' accepted, file intact and parsable')
    : fail('same-slug race', 'ok=' + ok + ' parsable=' + parsable);
}

// ---- 3. NON-ASCII CONTENT --------------------------------------------------------------------
// His memories carry French accents and Arabic. A byte-mangling write would corrupt them silently.
{
  const slug = 'reference_stress_unicode';
  made.push(slug);
  const marker = 'Décennale 10 M€, société, à côté. مرحبا بالعالم. 中文';
  const content = '---' + NL + 'name: Unicode probe' + NL
    + 'description: stress probe checking accented French and Arabic survive a write intact, removed after' + NL
    + 'type: reference' + NL + '---' + NL + NL + marker + NL + NL + 'See [[reference_deep_test_probe]].' + NL;
  const r = await writeMemory(slug, content);
  let round = '';
  try { round = readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8'); } catch { /* none */ }
  (r.ok && round.includes(marker)) ? pass('unicode round-trip', 'French, Arabic and CJK intact')
    : fail('unicode round-trip', r.ok ? 'written but the text was mangled' : 'refused: ' + (r.error || r.raw));
}

// ---- 4. OVERSIZED BODY ------------------------------------------------------------------------
// Must be refused or truncated cleanly, never accepted and never crash the server.
{
  const slug = 'reference_stress_huge';
  const content = '---' + NL + 'name: Huge probe' + NL
    + 'description: stress probe sending an oversized body to check the server refuses rather than dying' + NL
    + 'type: reference' + NL + '---' + NL + NL + 'x'.repeat(400_000) + NL;
  const r = await writeMemory(slug, content);
  const landed = existsSync(join(BRAIN, 'memory', slug + '.md'));
  if (landed) made.push(slug);
  (!landed) ? pass('oversized body refused', 'not written: ' + (r.error || r.raw || 'connection dropped'))
    : fail('oversized body refused', 'a 400KB memory was accepted');
  const h = await get('/health');
  h.code === '200' ? pass('server alive after that', 'health 200') : fail('server alive after that', 'health ' + h.code);
}

// ---- 5. RATE LIMIT ----------------------------------------------------------------------------
// 120 per minute per IP. The vault is the most attackable surface here, so this must actually bite.
{
  const rs = await Promise.all(Array.from({ length: 140 }, () => get('/index/version')));
  const limited = rs.filter((r) => r.code === '429').length;
  const served = rs.filter((r) => r.code === '200').length;
  limited > 0 ? pass('rate limit bites', served + ' served, ' + limited + ' got 429')
    : fail('rate limit bites', 'all ' + served + ' served, no 429 at 140 requests');
}

// ---- 6. STILL HEALTHY AFTER ALL OF IT ----------------------------------------------------------
// WAIT OUT THE WINDOW FIRST. The limit is per IP over 60s, and this machine's own recall hook
// shares 127.0.0.1 with the test. Running deep-test straight after this showed 11 failures that
// were purely this test's leftover 429s: a healthy server reported as broken, which is the exact
// false-evidence trap this suite exists to catch. So the run pays its own minute back rather than
// handing the next caller, tool or the owner mid-turn, a brain that refuses to answer.
{
  console.log('  ...waiting 62s for the rate-limit window this test filled to drain');
  await new Promise((r) => setTimeout(r, 62_000));
  const h = await get('/health');
  const r = await get('/index/version');
  // Both must be 200 now. Accepting 429 here was letting the run finish while still refusing
  // traffic, which is not "survived", it is "left the brain unusable and called it a pass".
  (h.code === '200' && r.code === '200')
    ? pass('recovered, serving again', 'health 200, index 200')
    : fail('recovered, serving again', 'health ' + h.code + ', index ' + r.code + ' (still limited?)');
}

// ---- CLEANUP -----------------------------------------------------------------------------------
for (const s of [...new Set(made)]) {
  try { unlinkSync(join(BRAIN, 'memory', s + '.md')); } catch { /* already gone */ }
}
try { execFileSync('node', [join(BRAIN, 'tools', 'build-index.mjs')], { cwd: BRAIN, stdio: 'ignore', timeout: 180000 }); } catch { /* best effort */ }
// The write endpoint commits, so those probes are in git. Remove them there too, or every stress
// run leaves junk in the brain history and pushes it to every machine.
try {
  execFileSync('git', ['-C', BRAIN, 'add', '-A', 'memory/', 'index/', 'MANIFEST.md'], { stdio: 'ignore', timeout: 30000 });
  execFileSync('git', ['-C', BRAIN, 'commit', '-m', 'test: remove stress-test probes'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  execFileSync('git', ['-C', BRAIN, 'push', '-q', 'origin', 'HEAD'], { stdio: 'ignore', timeout: 120000 });
} catch { /* nothing to remove, or the gate refused; reported below */ }

const passed = results.reduce((a, b) => a + b, 0);
console.log('');
console.log('  ' + passed + ' passed, ' + (results.length - passed) + ' failed, ' + results.length + ' checks');
const left = readdirSync(join(BRAIN, 'memory')).filter((f) => f.startsWith('reference_stress_'));
if (left.length) console.log('  WARNING: probes left behind: ' + left.join(', '));
