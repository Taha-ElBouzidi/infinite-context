// Full end-to-end test of the brain after tonight's security and architecture work.
// Every check runs something and reads the output. Nothing here asserts from intention.

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir, networkInterfaces } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').split(String.fromCharCode(92)).join('/');
const CERT = BRAIN + '/server-cert.pem';
const results = [];
const pass = (n, d) => results.push(['PASS', n, d]);
const fail = (n, d) => results.push(['FAIL', n, d]);
const warn = (n, d) => results.push(['WARN', n, d]);

const token = readFileSync(join(homedir(), '.claude', 'havok-server-token'), 'utf8').trim();

function curl(extraLines, expectJson = true) {
  const f = join(tmpdir(), 'dt_' + Math.floor(process.hrtime()[1]) + '.conf');
  writeFileSync(f, extraLines.join('\n') + '\n', 'utf8');
  try {
    const out = execFileSync('curl', ['-K', f, '-s', '-o', '-', '-w', '\nCODE:%{http_code} VERIFY:%{ssl_verify_result}'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out;
  } catch (e) {
    // curl exits non-zero on a refused connection or a rejected certificate, which for the
    // negative tests below IS the expected outcome. Return its stdout so the caller can read the
    // 000 code instead of treating the exit status as a test failure. Getting this wrong reported
    // three healthy security controls as broken.
    const out = (e && e.stdout) ? String(e.stdout) : '';
    return out || ('CODE:000 VERIFY:0 (curl exit ' + (e && e.status) + ')');
  }
  finally { try { unlinkSync(f); } catch { /* gone */ } }
}
const authed = (url, extra = []) => curl([
  'header = "Authorization: Bearer ' + token + '"',
  'url = "' + url + '"', 'cacert = "' + CERT + '"', 'silent', 'max-time = 20', ...extra,
]);

// ---- 1. TRANSPORT -------------------------------------------------------------------------
{
  const r = authed('https://127.0.0.1:8443/health');
  const m = r.match(/CODE:(\d+) VERIFY:(\d+)/) || [];
  (m[1] === '200' && m[2] === '0') ? pass('loopback TLS', 'code ' + m[1] + ', verify ' + m[2])
    : fail('loopback TLS', r.slice(-60));
}
{
  // Read the published endpoint. This was a hardcoded tailnet address, which is a bug on any
  // machine but the host, and it also leaked the owner's network address into a file we intend to
  // open source. Same class as the hardcoded tailscale.exe path fixed the same day.
  let base = '';
  try { base = String(JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url || ''); } catch { /* none */ }
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!base) {
    fail('tailnet TLS', 'server-endpoint.json publishes no url, cannot probe the tailnet path');
  } else {
    const r = authed(base + '/health');
    const m = r.match(/CODE:(\d+) VERIFY:(\d+)/) || [];
    (m[1] === '200' && m[2] === '0') ? pass('tailnet TLS', 'code ' + m[1] + ', verify ' + m[2])
      : fail('tailnet TLS', r.slice(-60));
  }
}
{
  // The server must be invisible on every interface that is not the tailnet. Probe this host's
  // own LAN address, discovered at runtime: it was one machine's WiFi address hardcoded until
  // 2026-09-05, which both leaked it and made the test meaningless anywhere else.
  // EVERY non-tailnet interface, not the first one found: on this host the first is a virtual
  // adapter and the WiFi is second, and the WiFi is the one that leaked a bearer token once.
  const lans = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^100.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])./.test(i.address))
    .map((i) => i.address);
  if (!lans.length) {
    warn('LAN refused', 'no non-tailnet interface on this host, nothing to probe');
  } else {
    const exposed = lans.filter((ip) => !/CODE:000/.test(curl(['url = "https://' + ip + ':8443/health"', 'insecure', 'silent', 'max-time = 6'])));
    exposed.length ? fail('LAN refused', 'port ANSWERED on ' + exposed.join(', ') + ', it is exposed off the tailnet')
      : pass('LAN refused', 'refused on every non-tailnet interface: ' + lans.join(', '));
  }
}
{
  const r = curl(['url = "http://127.0.0.1:8478/health"', 'silent', 'max-time = 6']);
  /CODE:000/.test(r) ? pass('plaintext gone', '8478 refuses connections')
    : fail('plaintext gone', 'plain HTTP still answering: ' + r.slice(-50));
}
{
  const r = curl(['header = "Authorization: Bearer wrongtokenwrongtokenwrongtoken"',
    'url = "https://127.0.0.1:8443/vault/list"', 'cacert = "' + CERT + '"', 'silent', 'max-time = 10']);
  /CODE:401/.test(r) ? pass('bad token rejected', '401') : fail('bad token rejected', r.slice(-50));
}
{
  const r = curl(['url = "https://127.0.0.1:8443/health"', 'silent', 'max-time = 8']);
  /CODE:000/.test(r) ? pass('cert pinning enforced', 'unpinned client refused')
    : fail('cert pinning enforced', 'unpinned client got through: ' + r.slice(-40));
}

// ---- 2. RECALL ----------------------------------------------------------------------------
{
  const r = authed('https://127.0.0.1:8443/recall', [
    'request = "POST"', 'header = "content-type: application/json"',
    'data = "{\\"prompt\\":\\"what is my training split\\"}"',
  ]);
  let n = 0; try { n = (JSON.parse(r.split('\nCODE:')[0]).ranked || []).length; } catch { /* bad */ }
  n === 5 ? pass('/recall endpoint', '5 memories returned') : fail('/recall endpoint', 'returned ' + n);
}
{
  const r = authed('https://127.0.0.1:8443/rules');
  let n = 0; try { n = (JSON.parse(r.split('\nCODE:')[0]).rules || []).length; } catch { /* bad */ }
  // Compare against rules.json rather than a hardcoded number. The first version hardcoded 7 and
  // would have failed the moment a rule was added, which happened the next day.
  const onDisk = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules.length;
  n === onDisk ? pass('/rules endpoint', n + ' rules, matches rules.json; hook adds the tier line to make ' + (n + 1))
    : fail('/rules endpoint', 'server says ' + n + ', rules.json says ' + onDisk);
}

// ---- 3. THE HOOK, END TO END --------------------------------------------------------------
function hook(prompt, env = {}, brainDir = BRAIN) {
  const r = spawnSync('node', [join(brainDir, 'hooks', 'pre-turn.mjs')], {
    input: JSON.stringify({ prompt, cwd: brainDir, session_id: 'deeptest' }),
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 40000,
  });
  let c = ''; try { c = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || ''; } catch { /* none */ }
  return c;
}
{
  const c = hook('what is my training split');
  const rules = c.split('\n').filter((l) => /^\d+\. /.test(l)).length;
  const mems = c.split('\n').filter((l) => /^- \[/.test(l)).length;
  const tagged = c.split('\n').filter((l) => /^- \[(both|meaning|keyword)\]/.test(l)).length;
  rules >= 8 ? pass('hook injects rules', rules + ' rules') : fail('hook injects rules', rules + ' rules');
  mems === 5 ? pass('hook injects recall', '5 memories') : fail('hook injects recall', mems + ' memories');
  tagged === mems ? pass('channel tags present', 'all ' + tagged + ' tagged') : fail('channel tags', tagged + '/' + mems);
  !/semantic recall is OFF/.test(c) ? pass('no false degradation notice', 'clean')
    : fail('no false degradation notice', 'the OFF warning is back');
}
{
  // A paraphrase sharing no keyword with the memory: proves the semantic channel is alive.
  const c = hook('stop writing so much to me');
  /reply_length|feedback_reply/.test(c) ? pass('semantic channel alive', 'paraphrase matched the reply-length memory')
    : warn('semantic channel', 'paraphrase did not surface the expected memory');
}

// ---- 4. DEGRADED PATHS --------------------------------------------------------------------
{
  const TMP = join(tmpdir(), 'dt-noidx-' + process.pid);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* locked, use a fresh name */ }
  mkdirSync(join(TMP, 'havok-brain'), { recursive: true });
  for (const d of ['memory', 'hooks', 'tools']) cpSync(join(BRAIN, d), join(TMP, 'havok-brain', d), { recursive: true });
  for (const f of ['REFLEX.md', 'server-endpoint.json', 'vault.json', 'vault-recipients.json', 'server-cert.pem']) {
    try { cpSync(join(BRAIN, f), join(TMP, 'havok-brain', f)); } catch { /* optional */ }
  }
  const c = hook('what is my training split', { HAVOK_BRAIN: join(TMP, 'havok-brain') }, join(TMP, 'havok-brain'));
  const rules = c.split('\n').filter((l) => /^\d+\. /.test(l)).length;
  const mems = c.split('\n').filter((l) => /^- \[/.test(l)).length;
  // ON FAILURE, SAY WHY. This failed once on 2026-08-24 with "1 rules, 0 memories" and could not be
  // reproduced afterwards: 5 isolated runs of this exact scenario and 6 full deep-test runs all
  // passed, and the server log for that minute shows no rate limiting and no error. So the summary
  // was the only evidence and it was not enough to diagnose anything.
  //
  // 0 memories with the server up means the hook fell back to local matching, and this clone has no
  // index, so the interesting question is always WHY it fell back. The most likely cause is a file
  // the copy above treats as optional: without server-cert.pem the hook cannot pin TLS, every call
  // fails validation, and it degrades silently to exactly this result.
  if (rules >= 8 && mems === 5) {
    pass('machine with NO index', rules + ' rules, ' + mems + ' memories, fully served by the server');
  } else {
    const missing = ['server-cert.pem', 'server-endpoint.json', 'REFLEX.md']
      .filter((f) => !existsSync(join(TMP, 'havok-brain', f)));
    fail('machine with NO index', rules + ' rules, ' + mems + ' memories'
      + (missing.length ? '; the clone is MISSING ' + missing.join(', ') : '; all needed files copied')
      + (/unreachable|not reachable|recall is OFF|degraded/i.test(c) ? '; the hook reported degradation' : '')
      + '; context starts: ' + JSON.stringify(c.slice(0, 120)));
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* left behind in temp, harmless */ }
}
{
  const MARK = join(homedir(), '.claude', 'havok-remote-embed-down');
  writeFileSync(MARK, JSON.stringify({ at: Date.now(), reason: 'deep test' }), 'utf8');
  const c = hook('what is my training split');
  unlinkSync(MARK);
  const mems = c.split('\n').filter((l) => /^- \[/.test(l)).length;
  mems > 0 ? pass('server-unreachable fallback', mems + ' memories from the local index')
    : fail('server-unreachable fallback', 'no memories, machine would be blind');
}

// ---- 4b. THE WRITE PATH -------------------------------------------------------------------
// Added 2026-08-24. POST /memory was the newest and riskiest code in the system and had no
// permanent test, only throwaway scripts. A bad write reaches every machine on the next pull, and
// a broken wikilink in one memory blocks EVERY machine from committing, so these run every time.
function postMemory(obj, tok) {
  const body = join(tmpdir(), 'dtw_body.json');
  writeFileSync(body, JSON.stringify(obj), 'utf8');
  const r = curl([
    'header = "Authorization: Bearer ' + (tok || token) + '"',
    'header = "content-type: application/json"',
    'url = "https://127.0.0.1:8443/memory"',
    'request = "POST"',
    // Forward slashes: a curl config treats a backslash as an escape and mangles a Windows path.
    'data-binary = "@' + body.split('\\').join('/') + '"',
    'cacert = "' + CERT + '"', 'silent', 'max-time = 240',
  ]);
  try { unlinkSync(body); } catch { /* gone */ }
  try { return JSON.parse(r.split('\nCODE:')[0]); } catch { return { raw: r.slice(0, 80) }; }
}
const FM = (type, link) => '---\nname: Deep test probe\n'
  + 'description: temporary probe written by tools/deep-test.mjs, deleted immediately, ignore it\n'
  + 'type: ' + type + '\n---\n\nSee [[' + link + ']].\n';
{
  const bad = [
    ['rejects path traversal', { slug: '../../etc/passwd', content: FM('reference', 'feedback_verify_before_claiming') }, 'bad slug'],
    ['rejects a dotted slug', { slug: 'reference_x.md', content: FM('reference', 'feedback_verify_before_claiming') }, 'bad slug'],
    ['rejects unknown prefix', { slug: 'nonsense_probe_x', content: FM('reference', 'feedback_verify_before_claiming') }, 'bad prefix'],
    ['rejects thin description', { slug: 'reference_dt_thin', content: '---\nname: x\ndescription: short\ntype: reference\n---\nbody padding padding' }, 'missing or thin description'],
    ['rejects broken wikilink', { slug: 'reference_dt_link', content: FM('reference', 'reference_definitely_not_a_memory') }, 'broken wikilink'],
  ];
  for (const [label, payload, want] of bad) {
    const r = postMemory(payload);
    r.error === want ? pass(label, want) : fail(label, 'got ' + (r.error || JSON.stringify(r).slice(0, 50)));
  }
}
{
  // The happy path, then remove the probe so the brain is left exactly as found.
  // Rewrite a PERMANENT file with its exact current content, rather than creating a throwaway.
  // The endpoint commits and pushes, so a create-then-delete probe added a junk memory and a
  // deletion to the brain history on every run and pushed both to every machine.
  const slug = 'reference_deep_test_probe';
  let content = '';
  try { content = readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8'); } catch { /* first run */ }
  if (!content) content = FM('reference', 'feedback_verify_before_claiming');
  const r = postMemory({ slug, content });
  const onDisk = existsSync(join(BRAIN, 'memory', slug + '.md'));
  let vectored = false;
  try { vectored = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8')).slugs.includes(slug); } catch { /* none */ }
  (r.ok && onDisk && vectored)
    ? pass('write lands and indexes', 'written, vector present, pushed=' + r.pushed)
    : fail('write lands and indexes', 'ok=' + r.ok + ' onDisk=' + onDisk + ' vector=' + vectored + ' err=' + (r.error || ''));
  // Put the tree back EXACTLY as found. The probe write dirties index/ and MANIFEST.md, and the
  // suite's own "working tree clean" check then fails on dirt the suite created. A test that fails
  // because of itself teaches you to ignore the result, which is worse than having no test.
  try {
    execFileSync('git', ['-C', BRAIN, 'checkout', '--', 'index/', 'MANIFEST.md', 'memory/MEMORY.md'],
      { stdio: 'ignore', windowsHide: true, timeout: 30000 });
  } catch { /* nothing to restore */ }
}

// ---- 4c. SCOPE BOUNDARY, with a REAL recall-scoped token ------------------------------------
{
  let rtok = '';
  // Which machine is recall-scoped is instance config, brain.json.restrictedMachines. It was a
  // hardcoded machine name until 2026-09-05.
  let restricted = [];
  try { restricted = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).restrictedMachines || []; } catch { /* none */ }
  for (const m of restricted) {
    try { rtok = readFileSync(join(homedir(), '.claude', 'issued-' + m + '.token'), 'utf8').trim(); } catch { /* not issued here */ }
    if (rtok) break;
  }
  if (!rtok) { warn('scope boundary', 'no recall-scoped token on this machine to test with'); }
  else {
    const g = (p) => (curl(['header = "Authorization: Bearer ' + rtok + '"', 'url = "https://127.0.0.1:8443' + p + '"',
      'cacert = "' + CERT + '"', 'silent', 'max-time = 20']).match(/CODE:(\d+)/) || [])[1];
    const rules = g('/rules'); const vault = g('/vault/list');
    (rules === '200' && vault === '403')
      ? pass('recall scope enforced', '/rules 200, /vault/list 403')
      : fail('recall scope enforced', '/rules ' + rules + ', /vault/list ' + vault + ' (want 200 and 403)');
  }
}

// ---- 4d. BOOTSTRAP is closed unless armed ---------------------------------------------------
{
  // This route hands out a credential without one, so 'refuses when not armed' is the single most
  // important assertion about it.
  const r = curl(['url = "https://127.0.0.1:8443/bootstrap/DEFINITELY_NOT_ARMED"',
    'cacert = "' + CERT + '"', 'silent', 'max-time = 20']);
  /CODE:403/.test(r) ? pass('bootstrap closed by default', 'unarmed name refused')
    : fail('bootstrap closed by default', 'expected 403, got ' + (r.match(/CODE:(\d+)/) || [])[1]);
}
// ---- 5. INDEX INTEGRITY -------------------------------------------------------------------
{
  const disk = readdirSync(join(BRAIN, 'memory')).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((f) => f.replace(/\.md$/, ''));
  const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
  const missing = disk.filter((s) => !emb.slugs.includes(s));
  missing.length === 0 ? pass('vector parity', disk.length + ' memories, ' + emb.slugs.length + ' vectors')
    : fail('vector parity', missing.length + ' without a vector: ' + missing.slice(0, 3).join(', '));
}

// ---- 6. SECRETS ---------------------------------------------------------------------------
{
  // Read the RECIPIENT LIST, not the tool's prose. The first version regex-matched the whole
  // output and tripped on a laptop client's description, which says "NOT the company-issued laptop".
  // A test that fails on the word rather than the fact is worse than no test.
  const rec = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
  const names = Object.keys(rec.machines || {});
  let restricted2 = [];
  try { restricted2 = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).restrictedMachines || []; } catch { /* none */ }
  const leaked = restricted2.filter((m) => names.some((n) => n.toUpperCase() === String(m).toUpperCase()));
  if (!restricted2.length) warn('restricted machines excluded from vault', 'no restrictedMachines in brain.json, nothing to check');
  else if (leaked.length) fail('restricted machines excluded from vault', 'these ARE recipients: ' + leaked.join(', '));
  else pass('restricted machines excluded from vault', 'recipients are exactly: ' + names.join(', '));
}
{
  const key = join(homedir(), '.claude', 'havok-server-key.pem');
  const acl = execFileSync('icacls', [key], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  /Authenticated Users|Everyone|CodexSandbox/i.test(acl)
    ? fail('TLS key ACL', 'readable beyond <user> and SYSTEM')
    : pass('TLS key ACL', '<user> and SYSTEM only');
}
{
  const acl = execFileSync('icacls', ['D:\\dev\\Havok\\havok-brain\\hooks\\pre-turn.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  /Authenticated Users/i.test(acl) ? fail('hook not writable by others', 'Authenticated Users still has access')
    : pass('hook not writable by others', 'Administrators, SYSTEM, <user> only');
}
{
  // The repo must still be WRITABLE by us: this is the check that would have caught the a laptop client breakage.
  const probe = join(BRAIN, '.deep-test-write');
  try { writeFileSync(probe, 'x'); unlinkSync(probe); pass('brain still writable', 'write and delete OK'); }
  catch (e) { fail('brain still writable', 'READ-ONLY: ' + e.code); }
}

// ---- 7. REPO STATE ------------------------------------------------------------------------
{
  const st = execFileSync('git', ['-C', BRAIN, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  st === '' ? pass('working tree clean', 'nothing uncommitted') : warn('working tree', st.split('\n').length + ' uncommitted file(s)');
  const ab = execFileSync('git', ['-C', BRAIN, 'rev-list', '--left-right', '--count', 'origin/master...HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  ab === '0\t0' ? pass('pushed', 'in sync with origin') : warn('pushed', 'behind/ahead: ' + ab);
}
{
  const keys = execFileSync('git', ['-C', BRAIN, 'ls-files'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    .split('\n').filter((f) => /key.*\.pem$|\.key$/i.test(f));
  keys.length === 0 ? pass('no private key in git', '0 key files tracked') : fail('no private key in git', keys.join(', '));
  const cert = execFileSync('git', ['-C', BRAIN, 'ls-files', 'server-cert.pem'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  cert ? pass('public cert tracked', 'clients can pin it') : fail('public cert tracked', 'MISSING, clients cannot verify');
}

// ---- REPORT -------------------------------------------------------------------------------
const w = Math.max(...results.map((r) => r[1].length));
for (const [s, n, d] of results) console.log('  ' + s.padEnd(5) + n.padEnd(w + 2) + d);
const f = results.filter((r) => r[0] === 'FAIL').length;
const wn = results.filter((r) => r[0] === 'WARN').length;
console.log('\n  ' + (results.length - f - wn) + ' passed, ' + f + ' failed, ' + wn + ' warnings, ' + results.length + ' checks');

// PERSIST FAILURES. On 2026-08-24 a run reported one failure, the output was piped through
// tail -1, and the name of the failing check was gone for good. Six clean runs afterwards could
// not reproduce it, so the cause is still unknown, which is a worse outcome than the failure was.
// The summary line is the part people keep; the detail has to survive on its own.
if (f > 0) {
  const stamp = new Date().toISOString();
  const lines = results.filter((r) => r[0] === 'FAIL').map(([, n, d]) => stamp + '  FAIL  ' + n + '  ' + d);
  try {
    appendFileSync(join(BRAIN, '.deep-test-failures.log'), lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    console.log('  failures appended to .deep-test-failures.log');
  } catch { /* logging must never change the exit code */ }
}
