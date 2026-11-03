// Restarts the brain server or the embed server on the host when it stops answering, at most MAX_PER_HOUR times an
// hour, then alerts instead. HAVOK's decision after the 2026-11-02 freeze: the analyzer saw the brain down at 20:39
// and nothing restarted it until a hand restart at 20:43.
//
// EVENTS, NOT A WATCHDOG (feedback_events_not_watchdogs). Nothing here runs on a timer. It is started by the failures
// that already happen: the pre-turn hook marking the server down after a failed recall, brain-client getting no
// answer, and the analyzer's existing /health probe (HavokBrainAnalytics, which already runs every 5 minutes for its
// own report). Each calls reportFailure(), which does nothing off the brain host and starts one detached run here.
//
// ONE RUN: confirm with /health (PROBES tries, PROBE_GAP_MS apart; one answer means healthy and nothing is done),
// check the hourly cap, restart through the normal start path (end the process that holds the port, then the same
// scheduled task the boot uses), wait for /health, and log every step to .brain-recover.log with the /health result
// before and after. Over the cap, or when a restart does not bring it back, it writes an alert into
// .brain-alerts.json, the file the analyzer writes and every machine's pre-turn hook reads.
//
// OFF UNTIL SWITCHED ON: with no {"enabled": true} in ~/.claude/havok-recover.json (HAVOK_HOME first) a run confirms
// and logs what it would have done, and restarts nothing.
//
//   node tools/brain-recover.mjs --what brain|embed --why "<what failed>"
import { readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');

export const MAX_PER_HOUR = 3;
const HOUR_MS = 3600 * 1000;
const PROBES = 3;
const PROBE_GAP_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;
// The brain server answers /health in under a second once listening; the embed server loads its model first.
const UP_WAIT_MS = 120000;
const UP_POLL_MS = 2000;
// A run that died holding the lock must not block recovery for good.
const LOCK_STALE_MS = 10 * 60 * 1000;

export const TARGETS = {
  brain: { url: 'https://127.0.0.1:8443/health', port: 8443, task: 'HavokBrainServer', script: 'brain-server' },
  embed: { url: 'http://127.0.0.1:8477/health', port: 8477, task: 'HavokEmbedServer', script: 'embed-server' },
};

// One GET with a hard limit. ok only on a 200 that says ok; the answer is kept short for the log.
export function probeHealth(url, { timeoutMs = PROBE_TIMEOUT_MS, ca = null } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { method: 'GET', ...(ca ? { ca } : {}) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => done({ ok: res.statusCode === 200 && /"ok"\s*:\s*true/.test(body), status: res.statusCode, ms: Date.now() - t0 }));
    });
    req.on('error', (e) => done({ ok: false, error: String(e.message).slice(0, 80), ms: Date.now() - t0 }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('no answer in ' + timeoutMs + ' ms')));
    req.end();
  });
}

// The decision, with every outside effect passed in, so it is tested with a fake server and a fake clock.
export async function recover({ what, why, enabled, now, sleep, probe, restart, state, log, alert, refuse = '' }) {
  if (refuse) {
    log({ at: new Date(now()).toISOString(), what, why, action: 'refused', reason: refuse });
    return 'refused';
  }
  const before = [];
  for (let i = 0; i < PROBES; i++) {
    if (i) await sleep(PROBE_GAP_MS);
    const r = await probe();
    before.push(r);
    if (r.ok) {
      log({ at: new Date(now()).toISOString(), what, why, action: 'none', reason: 'answered /health', before });
      return 'healthy';
    }
  }
  const recent = (state.restarts[what] || []).filter((t) => now() - t < HOUR_MS);
  if (recent.length >= MAX_PER_HOUR) {
    const text = 'the ' + what + ' server failed /health ' + PROBES + ' times and was NOT restarted: already '
      + recent.length + ' restarts in the last hour. A person or HAVOK must look at the cause. Last failure: ' + why;
    log({ at: new Date(now()).toISOString(), what, why, action: 'capped', restartsLastHour: recent.length, before });
    alert('recover-capped-' + what, text);
    state.restarts[what] = recent;
    return 'capped';
  }
  if (!enabled) {
    log({ at: new Date(now()).toISOString(), what, why, action: 'would-restart', reason: 'recovery is not switched on', before });
    return 'disabled';
  }
  // Counted BEFORE acting: a restart that crashes this run half way still counts toward the cap.
  state.restarts[what] = recent.concat([now()]);
  let how = null;
  try { how = await restart(); } catch (e) { how = { error: String((e && e.message) || e).slice(0, 200) }; }
  const after = [];
  const until = now() + UP_WAIT_MS;
  for (;;) {
    const r = await probe();
    after.push(r);
    if (r.ok || now() >= until) break;
    await sleep(UP_POLL_MS);
  }
  const up = after[after.length - 1].ok;
  log({ at: new Date(now()).toISOString(), what, why, action: 'restarted', how, before, after: after.slice(-3), up, restartsLastHour: state.restarts[what].length });
  if (!up) alert('recover-failed-' + what, 'the ' + what + ' server was restarted after failing /health and still does not answer it. Last failure: ' + why);
  return up ? 'restarted' : 'restart-failed';
}

// The brain server's probe is https pinned to server-cert.pem: without the certificate it fails TLS against a healthy
// server, and a restart then would only take a working server down (audit 2026-11-02). The embed server is plain http.
export function certRefusal(what, ca) {
  return what === 'brain' && !ca ? 'server-cert.pem cannot be read, so /health cannot be checked over https; not restarted' : '';
}

// The normal start path: the same scheduled task the boot starts it with, after ending the process that holds the
// port. The port owner, never "every node running brain-server": test copies on scratch ports run that script too.
// The task still counts as Running for a moment after its process is stopped, and Start-ScheduledTask does nothing
// then: it waits for the task to leave Running, up to TASK_WAIT_TRIES x 250 ms.
const TASK_WAIT_TRIES = 20;
export function restartScript(t) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$c = Get-NetTCPConnection -State Listen -LocalPort ' + t.port + ' -ErrorAction SilentlyContinue | Select-Object -First 1',
    "$killed = ''",
    'if ($c) {',
    '  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess)',
    "  if ($p -and $p.CommandLine -like '*" + t.script + "*') { Stop-Process -Id $p.ProcessId -Force; $killed = [string]$p.ProcessId }",
    "  else { throw ('port " + t.port + " is held by something that is not " + t.script + ": ' + $c.OwningProcess) }",
    '}',
    'for ($i = 0; $i -lt ' + TASK_WAIT_TRIES + " -and (Get-ScheduledTask -TaskName '" + t.task + "').State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 250 }",
    "Start-ScheduledTask -TaskName '" + t.task + "'",
    "Write-Output ('killed=' + $killed + ' task=" + t.task + "')",
  ].join('\n');
}

function windowsRestart(t) {
  const ps = restartScript(t);
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { done: out.trim().slice(0, 200) };
}

export function isBrainHost(brain = BRAIN) {
  try {
    const r = JSON.parse(readFileSync(join(brain, 'vault-recipients.json'), 'utf8'));
    return String(r.host || '').toUpperCase() === (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
  } catch { return false; }
}

// Called where a failure is seen. Cheap and silent off the brain host; never throws into its caller.
export function reportFailure(what, why, brain = BRAIN) {
  try {
    if (!TARGETS[what] || !isBrainHost(brain)) return false;
    const child = spawn(process.execPath, [join(brain, 'tools', 'brain-recover.mjs'), '--what', what, '--why', String(why).slice(0, 200)],
      { detached: true, stdio: 'ignore', cwd: brain, windowsHide: true });
    child.unref();
    return true;
  } catch { return false; }
}

// Merged into the analyzer's file, keeping its other alerts and each alert's first-seen time, so the hook on every
// machine shows it on the next turn. The analyzer keeps raising it from the log while it is inside its window.
export function writeAlert(file, id, text, nowIso) {
  let doc = { generated: nowIso, alerts: {} };
  try { doc = JSON.parse(readFileSync(file, 'utf8')); doc.alerts = doc.alerts || {}; } catch { /* first alert */ }
  doc.alerts[id] = { text, firstSeen: (doc.alerts[id] && doc.alerts[id].firstSeen) || nowIso, lastSeen: nowIso };
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : ''; };
  const what = opt('what');
  const t = TARGETS[what];
  if (!t) { process.stderr.write('usage: node tools/brain-recover.mjs --what brain|embed --why "<what failed>"\n'); process.exit(2); }
  if (!isBrainHost()) process.exit(0);
  const LOCK = join(BRAIN, '.brain-recover.lock');
  // One run at a time: several hooks failing in the same minute must cause one restart, not several.
  try { if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK); } catch { /* no lock */ }
  let fd;
  try { fd = openSync(LOCK, 'wx'); } catch { process.exit(0); }
  try {
    const STATE = join(BRAIN, '.brain-recover.json');
    let state = { restarts: {} };
    try { state = JSON.parse(readFileSync(STATE, 'utf8')); state.restarts = state.restarts || {}; } catch { /* first run */ }
    let enabled = false;
    try { enabled = JSON.parse(readFileSync(join(CONFIG_DIR, 'havok-recover.json'), 'utf8')).enabled === true; } catch { /* off */ }
    let ca = null;
    try { ca = readFileSync(join(BRAIN, 'server-cert.pem')); } catch { /* refused below for the https target */ }
    const result = await recover({
      what, why: opt('why') || 'unspecified', enabled, refuse: certRefusal(what, ca),
      now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      probe: () => probeHealth(t.url, { ca }),
      restart: () => windowsRestart(t),
      state,
      log: (row) => appendFileSync(join(BRAIN, '.brain-recover.log'), JSON.stringify(row) + '\n', 'utf8'),
      alert: (id, text) => writeAlert(join(BRAIN, '.brain-alerts.json'), id, text, new Date().toISOString()),
    });
    writeFileSync(STATE, JSON.stringify(state) + '\n', 'utf8');
    process.stdout.write(what + ': ' + result + '\n');
  } finally {
    closeSync(fd);
    try { unlinkSync(LOCK); } catch { /* gone */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
