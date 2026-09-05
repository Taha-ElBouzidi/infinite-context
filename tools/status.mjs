// One screen answering two questions: is the brain live right now, and is it actually working well.
//
// The owner, 2026-08-24: "we should have a status for the brain if it is live, if anything is down, like
// a status notice, and we should have analytics to understand if our solution works and if it needs
// any improvement."
//
// WHY THIS EXISTS SEPARATELY FROM brain-client status
// That tool answers "what can THIS machine reach", from the caller's point of view. This answers
// "what is the state of the whole system", from the server's, including machines that are not this
// one and trends over time. A green light on one machine has already been mistaken for a healthy
// system twice this week.
//
// EVERYTHING HERE IS MEASURED, never inferred. Every number comes from the access log, the index
// files, or a live request made while this runs.
//
// Usage: node tools/status.mjs            live status plus 7 day analytics
//        node tools/status.mjs --days 30  wider window
//        node tools/status.mjs --json     machine readable

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

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

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = join(BRAIN, 'server-cert.pem');
const LOG = join(BRAIN, '.server-access.log');
const CONFIG_DIR = process.env.HAVOK_HOME || join(homedir(), '.claude');
const JSON_OUT = process.argv.includes('--json');
const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  return i > -1 ? Math.max(1, Number(process.argv[i + 1]) || 7) : 7;
})();

const out = [];
const say = (s) => { if (!JSON_OUT) console.log(s); };

// ---- LIVE ---------------------------------------------------------------------------------
function token() {
  try { return readFileSync(join(CONFIG_DIR, 'havok-server-token'), 'utf8').trim(); } catch { return ''; }
}
function probe(path) {
  const t = token();
  if (!t) return { code: '000', ms: 0, note: 'no token on this machine' };
  const conf = join(tmpdir(), 'hs_' + process.pid + '.conf');
  writeFileSync(conf, [
    'header = "Authorization: Bearer ' + t + '"',
    'url = "https://127.0.0.1:8443' + path + '"',
    'cacert = "' + CERT.split('\\').join('/') + '"',
    'silent', 'max-time = 10',
  ].join('\n') + '\n', 'utf8');
  const t0 = Date.now();
  try {
    const r = execFileSync('curl', ['-K', conf, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code}'], { encoding: 'utf8', timeout: 12000 });
    return { code: r.trim(), ms: Date.now() - t0 };
  } catch { return { code: '000', ms: Date.now() - t0 }; }
  finally { try { unlinkSync(conf); } catch { /* gone */ } }
}

const live = {};
{
  const h = probe('/health');
  live.server = { up: h.code === '200', code: h.code, ms: h.ms };
}
{
  let ip = '';
  let up = false;
  try {
    ip = execFileSync(tailscaleBin(), ['ip', '-4'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      .split('\n')[0].trim();
    up = /^100\./.test(ip);
  } catch { /* not installed or not running */ }
  live.tailscale = { up, ip };
  // Peers, so a machine that silently left the tailnet is visible here rather than discovered
  // later when someone wonders why its recall went quiet.
  try {
    const s = execFileSync(tailscaleBin(), ['status'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    live.peers = s.split('\n').filter((l) => /^100\./.test(l)).map((l) => {
      const p = l.trim().split(/\s+/);
      return { ip: p[0], name: p[1], active: /active/.test(l) };
    });
  } catch { live.peers = []; }
}
live.embedDaemon = existsSync(join(CONFIG_DIR, 'havok-embed.alive'));

// The real test: does a prompt actually come back with memories.
{
  const t0 = Date.now();
  let hits = 0;
  try {
    const r = execFileSync('node', [join(BRAIN, 'hooks', 'pre-turn.mjs')], {
      input: JSON.stringify({ prompt: 'what is my training split', cwd: BRAIN, session_id: 'status' }),
      encoding: 'utf8', timeout: 40000,
    });
    const ctx = JSON.parse(r || '{}').hookSpecificOutput?.additionalContext || '';
    hits = (ctx.match(/- \[(both|meaning|keyword)\]/g) || []).length;
    live.rules = (ctx.match(/^\d+\. /gm) || []).length;
  } catch { /* leave at 0 */ }
  live.recall = { hits, ms: Date.now() - t0, ok: hits > 0 };
}

// ---- INDEX --------------------------------------------------------------------------------
const index = {};
try {
  const mems = readdirSync(join(BRAIN, 'memory')).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
  index.memories = mems.length;
  index.vectors = emb.slugs.length;
  index.missing = mems.filter((f) => !emb.slugs.includes(f.replace(/\.md$/, ''))).length;
} catch { index.error = true; }

// ---- ANALYTICS, from the access log --------------------------------------------------------
// The log is the only record of what other machines actually did. Parsing it is how "is it working"
// stops being an opinion.
// WAITING ON THE OWNER. Things that need a human's hands and cannot be done from a session.
//
// Each entry CHECKS THE REAL STATE rather than being a list someone maintains, so it disappears the
// moment the thing is actually done. A reminder that has to be ticked off by hand goes stale, and a
// stale reminder trains you to skip the whole section.
const pending = [];
if (process.platform === 'win32') {
  try {
    const trig = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-ScheduledTask -TaskName 'HavokBrainServer' -ErrorAction SilentlyContinue).Triggers | ForEach-Object { $_.CimClass.CimClassName }"],
      { encoding: 'utf8', timeout: 20000 });
    if (trig && !/BootTrigger/.test(trig)) {
      pending.push({
        what: 'the brain server still starts at LOGON, not at boot',
        why: 'after a reboot it stays down until you sign in at the keyboard, and every other machine sees the brain as unreachable until then',
        run: 'powershell -ExecutionPolicy Bypass -File D:\\dev\\Havok\\havok-brain\\tools\\install-boot-task.ps1',
        note: 'needs an ELEVATED PowerShell, once. AtStartup triggers are administrator-only. The logon trigger is kept as a fallback, so this cannot make things worse.',
      });
    }
  } catch { /* task scheduler unreadable: say nothing rather than raise a false alarm */ }
}

const since = Date.now() - DAYS * 86400_000;
const stats = { recall: [], embed: [], secrets: 0, denied: 0, byMachine: {}, byDay: {} };
try {
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    const m = line.match(/^(\S+Z)\s+(\S+)\s+(\S+)?/);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || at < since) continue;
    const kind = m[2];
    const who = m[3] || '?';
    const day = m[1].slice(0, 10);
    const ms = Number((line.match(/(\d+)ms\s*$/) || [])[1]);

    stats.byDay[day] = (stats.byDay[day] || 0) + 1;
    if (/^\d|^:/.test(who) || who.includes('.')) {
      stats.byMachine[who] = stats.byMachine[who] || { n: 0, last: m[1] };
      stats.byMachine[who].n++;
      stats.byMachine[who].last = m[1];
    }
    if (kind === 'RECALL' && Number.isFinite(ms)) stats.recall.push(ms);
    else if (kind.startsWith('EMBED') && Number.isFinite(ms)) stats.embed.push(ms);
    else if (kind === 'READ') stats.secrets++;
    else if (kind === 'DENIED') {
      stats.denied++;
      // Track WHO was rejected. A count alone is noise: 17 of the first 24 were this machine's own
      // negative tests, and flagging that as "investigate" trains you to ignore the line entirely.
      stats.deniedBy = stats.deniedBy || {};
      stats.deniedBy[who] = (stats.deniedBy[who] || 0) + 1;
    }
  }
} catch { stats.error = true; }

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

// ---- BOOT REPORT ---------------------------------------------------------------------------
let boot = null;
try { boot = JSON.parse(readFileSync(join(BRAIN, '.boot-status.json'), 'utf8')); } catch { /* never booted via the script */ }

// ---- RENDER --------------------------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify({ pending, live, index, stats: {
    recallCount: stats.recall.length, recallMedianMs: pct(stats.recall, 0.5), recallP95Ms: pct(stats.recall, 0.95),
    embedCount: stats.embed.length, secrets: stats.secrets, denied: stats.denied,
    byMachine: stats.byMachine, byDay: stats.byDay,
  }, boot, days: DAYS }, null, 2));
} else {
  const dot = (ok) => (ok ? 'UP  ' : 'DOWN');
  say('');
  say('  BRAIN STATUS                                    ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  say('  ' + '-'.repeat(66));
  say('  ' + dot(live.server.up) + '  brain server        https 8443, ' + live.server.ms + 'ms, code ' + live.server.code);
  say('  ' + dot(live.tailscale.up) + '  tailscale           ' + (live.tailscale.ip || 'not running'));
  say('  ' + dot(live.recall.ok) + '  recall              ' + live.recall.hits + ' memories, ' + live.recall.ms + 'ms, ' + (live.rules || 0) + ' rules injected');
  say('  ' + (live.embedDaemon ? 'UP  ' : '--  ') + '  embed daemon        ' + (live.embedDaemon ? 'running (fallback only)' : 'not running (server does recall)'));
  if (index.error) say('  DOWN  index               UNREADABLE');
  else say('  ' + dot(index.missing === 0) + '  index               ' + index.memories + ' memories, ' + index.vectors + ' vectors'
    + (index.missing ? ', ' + index.missing + ' MISSING A VECTOR' : ''));

  if (live.peers && live.peers.length) {
    say('');
    say('  MACHINES ON THE TAILNET');
    for (const p of live.peers) say('    ' + (p.active ? 'active ' : 'idle   ') + p.ip.padEnd(17) + p.name);
  }

  if (pending.length) {
    say('');
    say('  WAITING ON YOU  (' + pending.length + ')');
    for (const p of pending) {
      say('    ' + p.what);
      say('      why : ' + p.why);
      say('      run : ' + p.run);
      if (p.note) say('      note: ' + p.note);
    }
  }

  say('');
  say('  LAST ' + DAYS + ' DAYS');
  say('    recall requests     ' + stats.recall.length + (stats.recall.length
    ? '   median ' + pct(stats.recall, 0.5) + 'ms, p95 ' + pct(stats.recall, 0.95) + 'ms' : ''));
  say('    embed requests      ' + stats.embed.length + (stats.embed.length
    ? '   median ' + pct(stats.embed, 0.5) + 'ms' : ''));
  say('    secret reads        ' + stats.secrets);
    say('    rejected requests   ' + stats.denied + (stats.denied
      ? '   (' + Object.entries(stats.deniedBy || {}).map(([ip, c]) => ip + ' x' + c).join(', ') + ')' : ''));

  const machines = Object.entries(stats.byMachine).sort((a, b) => b[1].n - a[1].n);
  if (machines.length) {
    say('');
    say('  WHO IS USING IT');
    for (const [ip, d] of machines) {
      say('    ' + String(d.n).padStart(5) + '  ' + ip.padEnd(18) + 'last ' + d.last.slice(0, 16).replace('T', ' '));
    }
  }

  const days = Object.entries(stats.byDay).sort();
  if (days.length > 1) {
    say('');
    say('  PER DAY');
    const max = Math.max(...days.map(([, n]) => n));
    for (const [d, n] of days) {
      say('    ' + d + '  ' + String(n).padStart(5) + '  ' + '#'.repeat(Math.max(1, Math.round((n / max) * 34))));
    }
  }

  if (boot) {
    say('');
    say('  LAST BOOT  ' + String(boot.at).slice(0, 16).replace('T', ' ') + (boot.ok ? '  all steps OK' : '  ' + boot.failed + ' FAILED'));
    for (const s of boot.steps || []) if (!s.ok) say('    FAILED  ' + s.step + ': ' + s.detail);
  }

  const problems = [];
  if (!live.server.up) problems.push('the brain server is DOWN, every machine is on keyword-only recall');
  if (!live.tailscale.up) problems.push('Tailscale is down, no remote machine can reach the brain');
  if (!live.recall.ok) problems.push('recall returned NOTHING on a live prompt');
  if (index.missing) problems.push(index.missing + ' memories have no vector and cannot be found by meaning');
  // Loopback rejections are almost always our own tests of the auth path, so they are reported but
  // not raised as a problem. A rejection from anywhere ELSE is worth a human look.
  const foreignDenied = Object.entries(stats.deniedBy || {})
    .filter(([ip]) => ip !== '127.0.0.1' && ip !== '::1')
    .reduce((n, [, c]) => n + c, 0);
  if (foreignDenied) {
    problems.push(foreignDenied + ' rejected request(s) from NON-loopback sources: '
      + Object.entries(stats.deniedBy).filter(([ip]) => ip !== '127.0.0.1' && ip !== '::1')
        .map(([ip, c]) => ip + ' x' + c).join(', '));
  }
  say('');
  if (problems.length) { say('  NEEDS ATTENTION'); for (const p of problems) say('    - ' + p); }
  else say('  Everything is healthy.');
  say('');
}
