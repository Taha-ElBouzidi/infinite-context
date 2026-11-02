// Brain outage gate: when the brain server cannot be reached, the agent repairs it before any other work.
//
// The owner, 2026-10-15, after a laptop lost the brain for a few minutes and the hooks only warned: when the brain or
// the VPN it goes through is down, the agent repairs it before continuing, with no escape word. Three events, one file:
//   prompt  (UserPromptSubmit): probe /health with retries, so a blip after a sign-in passes unnoticed. Still
//           down: record it and tell the agent that the repair is its first job, and how.
//   tool    (PreToolUse): while down, refuse every tool except reading and repair commands. Re-probes at
//           most every 20 s, so the gate opens by itself the moment the brain answers.
//   stop    (Stop): while down, refuse to end the turn once, so the agent either keeps repairing or tells
//           the user exactly what the repair needs from them (for example a network change).
// Not gated: the main session (on the brain host it is the one that repairs the server), keep-warm pings, and the
// brain host switched off (Tailscale shows it offline), where work goes on normally.
// The rules (what stays allowed, the texts) are in gate-rules.mjs, shared with the mod, which runs this file
// itself for the probe and is the first to act; this hook is its backup through dispatch.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { RETRIES_MS, PROBE_TIMEOUT_MS, HOW, toolExempt, fresh, toolDenyReason, stopBlockReason } from './gate-rules.mjs';

const HOME = join(homedir(), '.claude');
const STATE = process.env.HAVOK_GATE_STATE || join(HOME, 'havok-brain-gate.json');
const BRAIN = process.env.HAVOK_BRAIN_DIR || join(dirname(fileURLToPath(import.meta.url)), '..');

const raw = readFileSync(0, 'utf8');
let data = {}; try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const mode = process.argv[2];
const session = String(data.session_id || '');
const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };
if (session && read(join(HOME, 'havok-main-session.txt')) === session) process.exit(0);
const getState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { down: false }; } };
const putState = (s) => { try { writeFileSync(STATE, JSON.stringify(s)); } catch { /* best effort */ } };
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };

function endpoint() {
  const ep = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8'));
  let url = process.env.HAVOK_GATE_URL || ep.url;
  try {
    const host = String(JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase();
    if (!process.env.HAVOK_GATE_URL && host && host === String(process.env.HAVOK_MACHINE_NAME || hostname()).toUpperCase()) url = url.replace(/\/\/[^/:]+/, '//127.0.0.1');
  } catch { /* keep the published url */ }
  return { url, ip: process.env.HAVOK_GATE_IP || (ep.tailnet || {}).ipv4 || '', ca: existsSync(join(BRAIN, ep.cert || 'server-cert.pem')) ? readFileSync(join(BRAIN, ep.cert || 'server-cert.pem')) : undefined };
}

function probeOnce(ep) {
  return new Promise((done) => {
    const req = https.get(ep.url + '/health', { ca: ep.ca, timeout: PROBE_TIMEOUT_MS }, (res) => { res.resume(); done(res.statusCode === 200 ? null : 'health answered ' + res.statusCode); });
    req.on('timeout', () => { req.destroy(); done('no answer within ' + PROBE_TIMEOUT_MS / 1000 + ' s'); });
    req.on('error', (e) => done(e.code || e.message));
  });
}

async function probe(ep, waits) {
  let why = '';
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    why = await probeOnce(ep);
    if (!why) return null;
  }
  return why;
}

// Where the fault is: this machine's Tailscale, the brain host switched off, or the brain service on a running host.
function diagnose(ep) {
  if (/127\.0\.0\.1/.test(ep.url)) return { kind: 'server', detail: 'this is the brain host and its own brain service does not answer' };
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    if (j.BackendState !== 'Running' || !(j.Self || {}).Online) return { kind: 'local', detail: 'Tailscale on this machine is ' + (j.BackendState || 'not running') };
    const peer = Object.values(j.Peer || {}).find((p) => (p.TailscaleIPs || []).includes(ep.ip));
    if (peer && peer.Online === false) return { kind: 'server-off', detail: 'Tailscale shows the brain host offline (last seen ' + (peer.LastSeen || 'unknown') + ')' };
    return { kind: 'server', detail: 'the brain host is online in Tailscale but the brain service does not answer' };
  } catch { return { kind: 'local', detail: 'the tailscale command does not answer on this machine' }; }
}

function proxyNote() {
  // The VPN state file to quote, where an instance names one in brain.json (vpnStateFile); the engine names none.
  let f = '';
  try { f = String(JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).vpnStateFile || ''); } catch { /* none */ }
  const s = f ? read(f) : '';
  return s ? ' The VPN proxy state file says: ' + s.slice(0, 200) + '.' : '';
}


if (mode === 'prompt') {
  if (String(data.prompt || '').trim() === 'keep-warm ping') process.exit(0);
  let ep; try { ep = endpoint(); } catch { process.exit(0); }
  const why = await probe(ep, RETRIES_MS);
  if (!why) { if (getState().down) putState({ down: false, upAt: Date.now() }); process.exit(0); }
  const d = diagnose(ep);
  if (d.kind === 'server-off') {
    putState({ down: false, serverOff: Date.now() });
    out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'BRAIN OFFLINE: ' + d.detail + '. The brain host is switched off, so work normally without the brain this turn and say so in one line.' } });
  }
  const prev = getState();
  putState({ down: true, since: prev.down ? prev.since : Date.now(), checkedAt: Date.now(), reason: why, kind: d.kind, detail: d.detail, stopBlocks: 0 });
  out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
    'BRAIN DOWN, REPAIR FIRST. The brain server did not answer three times over 12 s (' + why + '; ' + d.detail + ').' + proxyNote() +
    ' Rule: repair it before doing anything else in the message. Until the brain answers, every tool except reading and network repair commands is refused. ' + HOW[d.kind] +
    ' When it answers again, carry on with the message.' } });
}

const s = getState();
if (!s.down) process.exit(0);

async function stillDown() {
  if (fresh(s, Date.now())) return true;
  let ep; try { ep = endpoint(); } catch { return false; }
  const why = await probe(ep, [0]);
  if (!why) { putState({ down: false, upAt: Date.now() }); return false; }
  putState({ ...s, checkedAt: Date.now(), reason: why });
  return true;
}

if (mode === 'tool') {
  const tool = String(data.tool_name || '');
  if (toolExempt(tool, data.tool_input || {})) process.exit(0);
  if (!(await stillDown())) process.exit(0);
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: toolDenyReason(s) } });
}

if (mode === 'stop') {
  if ((s.stopBlocks || 0) >= 1 || !(await stillDown())) process.exit(0);
  putState({ ...getState(), stopBlocks: (s.stopBlocks || 0) + 1 });
  out({ decision: 'block', reason: stopBlockReason(s) });
}
process.exit(0);
