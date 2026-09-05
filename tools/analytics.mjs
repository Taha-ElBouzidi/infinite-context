#!/usr/bin/env node
// Results, not status. Reads every call the brain server has logged, produces the sheet, and
// raises an alert when the results say something is wrong.
//
// The owner, 2026-09-05: "we should start recording analytics of every call so that we can analyze
// every call so that if there is an issue we could be alerted. Just as we know if it's working
// or not. All we care about is the results."
//
// WHY status.mjs WAS NOT ENOUGH. It already computes medians over seven days, but only when
// somebody runs it. On 2026-09-05 the server received no recall call for 58 minutes while every
// prompt looked healthy, and the two calls before the silence took 1783ms and 648ms against a
// normal 5 to 23ms. Nothing watched. This runs on a timer and watches.
//
// THE RAW DATA IS .server-access.log, one line per call, already there since 2026-08-19. This
// adds no logging. It reads what exists and refuses to trust anything it did not measure.
//
//   node tools/analytics.mjs              print the sheet for the last 24 hours
//   node tools/analytics.mjs --hours 72   a longer window
//   node tools/analytics.mjs --quiet      for the timer: write files, print nothing
//   node tools/analytics.mjs --json       the sheet as JSON on stdout
//
// Writes .brain-analytics.json (the sheet) and .brain-alerts.json (active alerts, with the time
// each was first seen so a five minute timer does not re-raise the same thing forever). The
// pre-turn hook reads the alerts file and injects any fresh alert into the next prompt on ANY
// machine, which is the one channel that reaches the owner with no session open and no phone push.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.server-access.log');
const SHEET = join(BRAIN, '.brain-analytics.json');
const ALERTS = join(BRAIN, '.brain-alerts.json');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const HOURS = Number(opt('hours', 24));
const QUIET = flag('quiet');
const JSON_OUT = flag('json');
const NL = String.fromCharCode(10);
const say = (s) => { if (!QUIET && !JSON_OUT) process.stdout.write(s + NL); };

// ---- thresholds, from the measured baseline on 2026-09-05 --------------------------------
// SERVER recall: median 194ms whole hook, server side 5 to 23ms warm. A call over SLOW_MS is not
// a normal call. SILENCE_MIN only counts inside ACTIVE hours, or every night would alert.
const SLOW_MS = 500;
const SILENCE_MIN = 45;
const ACTIVE_FROM = 8;   // local hour
const ACTIVE_TO = 1;     // local hour, next day
const DENIED_SPIKE = 5;  // from one non-local address inside the window

// ---- parse, identically to status.mjs so the two never disagree ---------------------------
// 'Local' means this host itself: loopback, private LAN ranges, and the host's own tailnet address
// read from the published endpoint. It was a hardcoded list of one machine's addresses until
// 2026-09-05, which is exactly the kind of line that must never ship.
let hostTailnet = '';
try { hostTailnet = String((JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).tailnet || {}).ipv4 || ''); } catch { /* none */ }
const isLocal = (ip) => ip === '127.0.0.1' || ip === hostTailnet
  || ip.startsWith('192.168.') || ip.startsWith('10.') || /^172.(1[6-9]|2[0-9]|3[01])./.test(ip);
const LOCAL = { has: isLocal };
const since = Date.now() - HOURS * 3600 * 1000;
const calls = [];
try {
  for (const line of readFileSync(LOG, 'utf8').split(NL)) {
    const m = line.match(/^(\S+Z)\s+(\S+)\s+(\S+)?/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t) || t < since) continue;
    const ms = Number((line.match(/(\d+)ms\s*$/) || [])[1]);
    const hits = Number((line.match(/hits=(\d+)/) || [])[1]);
    calls.push({ t, kind: m[2], who: m[3] || '', ms: Number.isFinite(ms) ? ms : null, hits: Number.isFinite(hits) ? hits : null, line });
  }
} catch (e) {
  process.stderr.write('cannot read ' + LOG + ': ' + e.message + NL);
  process.exit(1);
}

const pct = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const isActiveHour = (t) => { const h = new Date(t).getHours(); return h >= ACTIVE_FROM || h < ACTIVE_TO; };

// ---- the sheet -----------------------------------------------------------------------------
const recalls = calls.filter((c) => c.kind === 'RECALL');
const writes = calls.filter((c) => c.kind === 'MEMORY-WRITE');
const errors = calls.filter((c) => c.kind === 'ERROR');
const denied = calls.filter((c) => c.kind === 'DENIED' || c.kind === 'REFUSED-SCOPE');
const empty = recalls.filter((c) => c.hits === 0);
const slow = recalls.filter((c) => c.ms !== null && c.ms > SLOW_MS);

const byHour = {};
for (const c of recalls) {
  const k = new Date(c.t).toISOString().slice(0, 13);
  byHour[k] = byHour[k] || { calls: 0, ms: [], empty: 0 };
  byHour[k].calls += 1;
  if (c.ms !== null) byHour[k].ms.push(c.ms);
  if (c.hits === 0) byHour[k].empty += 1;
}
const hours = Object.entries(byHour).sort().map(([h, v]) => ({
  hour: h, calls: v.calls, median: pct(v.ms, 0.5), p95: pct(v.ms, 0.95), max: v.ms.length ? Math.max(...v.ms) : null, empty: v.empty,
}));

const byMachine = {};
for (const c of recalls) { byMachine[c.who] = (byMachine[c.who] || 0) + 1; }

// silences: gaps between consecutive recalls inside active hours
const silences = [];
for (let i = 1; i < recalls.length; i += 1) {
  const gapMin = (recalls[i].t - recalls[i - 1].t) / 60000;
  if (gapMin > SILENCE_MIN && isActiveHour(recalls[i - 1].t) && isActiveHour(recalls[i].t)) {
    silences.push({ from: new Date(recalls[i - 1].t).toISOString(), to: new Date(recalls[i].t).toISOString(), minutes: Math.round(gapMin) });
  }
}
// and the gap from the last recall to now, which is the live one
const lastRecall = recalls.length ? recalls[recalls.length - 1].t : null;
const liveGapMin = lastRecall ? Math.round((Date.now() - lastRecall) / 60000) : null;

// is it up right now, measured, not inferred from the log
let up = null;
let healthMs = null;
try {
  const ep = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8'));
  const cert = join(BRAIN, 'server-cert.pem').split(String.fromCharCode(92)).join('/');
  const t0 = Date.now();
  const out = execFileSync('curl', ['-s', '--max-time', '5', '--cacert', cert, String(ep.url).replace(/\/+$/, '') + '/health'],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  healthMs = Date.now() - t0;
  up = /"ok"\s*:\s*true/.test(out);
} catch { up = false; }

const sheet = {
  generated: new Date().toISOString(),
  windowHours: HOURS,
  up, healthMs,
  recalls: recalls.length,
  medianMs: pct(recalls.map((c) => c.ms).filter((x) => x !== null), 0.5),
  p95Ms: pct(recalls.map((c) => c.ms).filter((x) => x !== null), 0.95),
  maxMs: recalls.length ? Math.max(...recalls.map((c) => c.ms || 0)) : null,
  emptyRecalls: empty.length,
  slowRecalls: slow.map((c) => ({ at: new Date(c.t).toISOString(), ms: c.ms, who: c.who })),
  writes: writes.length,
  errors: errors.map((c) => ({ at: new Date(c.t).toISOString(), who: c.who, line: c.line.slice(0, 140) })),
  denied: denied.length,
  deniedByForeign: Object.entries(denied.filter((c) => !LOCAL.has(c.who)).reduce((a, c) => { a[c.who] = (a[c.who] || 0) + 1; return a; }, {})),
  silences,
  lastRecall: lastRecall ? new Date(lastRecall).toISOString() : null,
  liveGapMin,
  byHour: hours,
  byMachine,
};

// ---- alerts: only the things that mean the RESULTS are wrong ------------------------------
const found = [];
if (up === false) found.push({ id: 'down', text: 'brain server did not answer /health' });
if (slow.length) found.push({ id: 'slow', text: slow.length + ' recall(s) over ' + SLOW_MS + 'ms in the last ' + HOURS + 'h, worst ' + Math.max(...slow.map((c) => c.ms)) + 'ms' });
if (errors.length) found.push({ id: 'errors', text: errors.length + ' server ERROR line(s) in the last ' + HOURS + 'h' });
if (silences.length) found.push({ id: 'silence', text: silences.length + ' silence(s) over ' + SILENCE_MIN + ' min during active hours, longest ' + Math.max(...silences.map((s) => s.minutes)) + ' min' });
if (liveGapMin !== null && liveGapMin > SILENCE_MIN && isActiveHour(Date.now())) found.push({ id: 'silent-now', text: 'no recall reached the server for ' + liveGapMin + ' min and it is active hours' });
for (const [ip, n] of sheet.deniedByForeign) if (n >= DENIED_SPIKE) found.push({ id: 'denied-' + ip, text: n + ' rejected requests from ' + ip });
if (recalls.length && empty.length / recalls.length > 0.2) found.push({ id: 'empty', text: Math.round(100 * empty.length / recalls.length) + '% of recalls returned nothing' });

// keep first-seen so the timer does not re-raise the same alert every five minutes
let prior = {};
try { prior = JSON.parse(readFileSync(ALERTS, 'utf8')).alerts || {}; } catch { /* none */ }
const now = new Date().toISOString();
const alerts = {};
for (const a of found) alerts[a.id] = { text: a.text, firstSeen: (prior[a.id] && prior[a.id].firstSeen) || now, lastSeen: now };
const fresh = found.filter((a) => !prior[a.id]);

writeFileSync(SHEET, JSON.stringify(sheet, null, 2) + NL, 'utf8');
writeFileSync(ALERTS, JSON.stringify({ generated: now, alerts }, null, 2) + NL, 'utf8');

// ---- print ---------------------------------------------------------------------------------
if (JSON_OUT) { process.stdout.write(JSON.stringify(sheet, null, 2) + NL); process.exit(found.length ? 2 : 0); }

say('');
say('  BRAIN RESULTS, last ' + HOURS + 'h                       ' + now.slice(0, 16).replace('T', ' '));
say('  ' + '-'.repeat(64));
say('  server        ' + (up === null ? 'not probed' : up ? 'UP, /health in ' + healthMs + 'ms' : 'DOWN'));
say('  recalls       ' + recalls.length + '   median ' + sheet.medianMs + 'ms   p95 ' + sheet.p95Ms + 'ms   max ' + sheet.maxMs + 'ms');
say('  returned 0    ' + empty.length);
say('  slow > ' + SLOW_MS + 'ms  ' + slow.length);
say('  writes        ' + writes.length);
say('  errors        ' + errors.length + '    rejected ' + denied.length);
say('  last recall   ' + (sheet.lastRecall || 'none') + (liveGapMin !== null ? '   (' + liveGapMin + ' min ago)' : ''));
if (Object.keys(byMachine).length) {
  say('');
  say('  BY MACHINE');
  for (const [w, n] of Object.entries(byMachine).sort((a, b) => b[1] - a[1])) say('    ' + w.padEnd(18) + n);
}
if (hours.length) {
  say('');
  say('  BY HOUR            calls   median    p95    max   empty');
  for (const h of hours.slice(-24)) {
    say('    ' + h.hour.replace('T', ' ') + 'h   ' + String(h.calls).padStart(5) + String(h.median === null ? '-' : h.median + 'ms').padStart(9)
      + String(h.p95 === null ? '-' : h.p95 + 'ms').padStart(7) + String(h.max === null ? '-' : h.max + 'ms').padStart(7) + String(h.empty).padStart(8));
  }
}
say('');
if (!found.length) {
  say('  ALERTS  none. The results say it is working.');
} else {
  say('  ALERTS  ' + found.length + (fresh.length ? '   (' + fresh.length + ' new)' : ''));
  for (const a of found) say('    ' + (prior[a.id] ? '     ' : 'NEW  ') + a.text);
}
say('');
process.exit(found.length ? 2 : 0);
