// The one command hook per event (hooks.json). The owner, 2026-11-02: "the mods run and the hook is only a backup if the
// mods fail". The mod (an optional Claude Code add-on, not part of the engine) does every job the old hooks did, inside Claude Code, and runs before the command hooks
// of the same event; after it handled an event it writes ~/.claude/havok-mod/alive/<session>.json naming it
// (alive-rules.mjs). This file reads that marker first:
//   the mod handled this very event (same key, within a minute)  exit at once, doing nothing;
//   otherwise (mod missing, crashed, skipped by a guard, broken by a Claude Code update)  run the old hooks of this
//   event exactly as hooks.json ran them before (same files, matchers and time limits, in parallel), hand on what
//   they answered, and log the activation to ~/.claude/havok-mod/backup.log.
// One change from before: a safety check that does not finish in its time refuses the action (The owner, 2026-11-02:
// hooks "go past the time we allow them and no issue"; a timed-out hook let the action through). Its time limit here
// is the old one, and the hooks.json limit of this file is above the largest, so this file always gets to decide.
// The handled path loads nothing but the marker rules, so it costs one node start and one small file read.
import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ALIVE_DIR, FRESH_MS, handled, safeSession } from './alive-rules.mjs';

const SHELL = /^(Bash|PowerShell)$/;
const COMMIT = (cmd) => /git\s+commit/.test(cmd) || /\bgit\b[^|;&]*\bcommit\b/.test(cmd);

// The old hooks.json, as a table. `safety` names a check that must finish: past its time it refuses.
export const JOBS = {
  SessionStart: [{ file: 'check-session-start.mjs', ms: 30000 }],
  UserPromptSubmit: [
    { file: 'check-limit.mjs', ms: 5000, safety: 'the limit reserve check' },
    { file: 'check-keep-warm.mjs', ms: 15000 },
    // Its three probes and the diagnosis take up to 26 s when the brain is down; the old 25 s limit killed it just
    // before it recorded the outage, so the gate never closed (one timeout in the 2026-10-30 review).
    { file: 'brain-gate.mjs', args: ['prompt'], ms: 30000 },
    { file: 'recall-gate.mjs', args: ['prompt'], ms: 5000 },
    { file: 'style-note.mjs', ms: 5000 },
    // The per-turn rules and recall, as a backup like the rest (HAVOK, 2026-11-03): it runs only when the mod did not
    // handle this prompt. Until 0.4.86 it was its own hooks.json entry, which ran beside the mod's recall on every
    // prompt (the locked-down client machine: 3.1 s and 34,818 characters each time). It keeps its own 5 s deadline inside this limit.
    { file: 'pre-turn.mjs', args: ['--from-plugin'], ms: 10000 },
  ],
  PreToolUse: [
    { file: 'check-limit.mjs', ms: 5000, safety: 'the limit reserve check' },
    { file: 'brain-gate.mjs', args: ['tool'], ms: 10000, safety: 'the brain outage check' },
    { file: 'recall-gate.mjs', args: ['tool'], ms: 5000 },
    { file: 'check-content.mjs', ms: 10000, tools: /^(Write|Edit|NotebookEdit|Bash|PowerShell)$|^mcp__/, safety: 'the writing rules check' },
    { file: 'check-secrets.mjs', ms: 15000, tools: SHELL, commit: true, safety: 'the secret scan of the staged diff' },
    { file: 'check-brain-commit.mjs', ms: 130000, tools: SHELL, commit: true, safety: 'the brain verification' },
    { file: 'check-commit-message.mjs', ms: 10000, tools: SHELL, safety: 'the commit message check' },
    { file: 'check-windows.mjs', ms: 5000, tools: SHELL, safety: 'the visible window and watcher check' },
    { file: 'helper-brain.mjs', ms: 5000, tools: /^(Agent|Task|SendMessage)$/ },
  ],
  Stop: [
    { file: 'check-stop.mjs', ms: 10000 },
    { file: 'check-memory-written.mjs', ms: 10000 },
    { file: 'brain-gate.mjs', args: ['stop'], ms: 10000 },
    { file: 'recall-gate.mjs', args: ['stop'], ms: 5000 },
  ],
};

const LOG_MAX_BYTES = 5 * 1024 * 1024;

// Why the mod did not handle this event, from its marker (alive-rules.mjs): a short cause for counting, and words.
export function whyNotHandled(marker, event, now) {
  if (!marker || typeof marker !== 'object') return { cause: 'no-marker', why: 'no mod marker for this session (the mod did not load, is not installed here, or never handled an event)' };
  const at = Number(marker.at) || 0;
  const v = marker.v ? ' (mod ' + marker.v + ')' : '';
  if (!at || now - at > FRESH_MS) return { cause: 'stale-marker', why: 'the mod last handled an event ' + (at ? Math.round((now - at) / 1000) + ' s' : 'an unknown time') + ' ago' + v + ', so it stopped running in this session' };
  if (marker.ev && Array.isArray(marker.ev[event]) && marker.ev[event].length) return { cause: 'missed-event', why: 'the mod handled other ' + event + ' events but not this one (it threw, ran out of time or skipped it)' + v };
  return { cause: 'event-not-handled', why: 'the mod is running in this session but handled no ' + event + v };
}


export function jobsFor(event, data) {
  const tool = String(data.tool_name || '');
  const cmd = String((data.tool_input || {}).command || '');
  return (JOBS[event] || []).filter((j) => (!j.tools || j.tools.test(tool)) && (!j.commit || COMMIT(cmd)));
}

function runJob(dir, job, raw, ms) {
  return import('node:child_process').then(({ spawn }) => new Promise((done) => {
    let out = '', err = '', over = false;
    const child = spawn(process.execPath, [join(dir, job.file), ...(job.args || [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    const timer = setTimeout(() => { over = true; try { child.kill(); } catch { /* gone */ } }, ms);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', () => { clearTimeout(timer); done({ job, out: '', err: '', code: 0, over: false }); });
    child.on('close', (code) => { clearTimeout(timer); done({ job, out, err, code, over }); });
    child.stdin.on('error', () => { /* the hook may exit before reading */ });
    child.stdin.end(raw);
  }));
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export function merge(event, results) {
  const secs = (r) => Math.round(r.ms / 1000);
  const late = results.find((r) => r.over && r.job.safety);
  if (event === 'PreToolUse') {
    if (late) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked: ' + late.job.safety + ' did not finish within ' + secs(late) + ' s, so this call was not checked and did not run. Run it again; if it keeps happening, tell the user the hook backup is slow on this machine.' } };
    let rewrite = null;
    for (const r of results) {
      if (r.over) continue;
      if (r.code === 2) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.err.trim() || r.job.file } };
      const o = parse(r.out.trim());
      const h = o && o.hookSpecificOutput;
      if (h && h.permissionDecision === 'deny') return o;
      if (o && o.decision === 'block') return o;
      if (!rewrite && h && h.updatedInput) rewrite = o;
    }
    return rewrite;
  }
  if (event === 'UserPromptSubmit' || event === 'Stop') {
    if (late && event === 'UserPromptSubmit') return { decision: 'block', reason: late.job.safety + ' did not finish within ' + secs(late) + ' s, so this message was held back. Send it again; if it keeps happening, tell the user the hook backup is slow on this machine.' };
    const context = [];
    for (const r of results) {
      if (r.over) continue;
      if (r.code === 2) return { decision: 'block', reason: r.err.trim() || r.job.file };
      const text = r.out.trim();
      if (!text) continue;
      const o = parse(text);
      if (o && o.decision === 'block') return o;
      if (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) context.push(o.hookSpecificOutput.additionalContext);
      else if (!o && event === 'UserPromptSubmit') context.push(text);
    }
    return context.length ? { hookSpecificOutput: { hookEventName: event, additionalContext: context.join('\n\n') } } : null;
  }
  // One hook per event (SessionStart, PostCompact): its answer is handed on as it printed it.
  const r = results[0];
  return r && !r.over && r.out.trim() ? r.out : null;
}

// ~/.claude/havok-mod/backup/<session>.json: the newest backup run of that session. Never throws.
export const BACKUP_NOTE_DIR = 'backup';
function noteBackup(home, sid, note) {
  try {
    const dir = join(home, '.claude', 'havok-mod', BACKUP_NOTE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sid + '.json'), JSON.stringify(note));
  } catch { /* bookkeeping only */ }
}

function logBackup(home, line) {
  try {
    const dir = join(home, '.claude', 'havok-mod');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'backup.log');
    try { if (statSync(f).size > LOG_MAX_BYTES) renameSync(f, f + '.1'); } catch { /* new file */ }
    appendFileSync(f, line + '\n');
  } catch { /* bookkeeping only */ }
}

async function main() {
  const event = process.argv[2];
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no input */ }
  const data = parse(raw || '{}') || {};
  const home = homedir();
  const sid = safeSession(data.session_id);
  let marker = null;
  if (sid) marker = parse((() => { try { return readFileSync(join(home, ...ALIVE_DIR.split('/'), sid + '.json'), 'utf8'); } catch { return ''; } })());
  const now = Date.now();
  if (handled(marker, event, data, now)) process.exit(0);
  // Arming (tools/backup-arm.mjs, HAVOK 2026-11-03): hooks.json keeps only SessionStart; a session start the mod did not
  // handle arms this session's backup block in settings.json (every resume too), and a machine without the mod is
  // armed for good. The mod disarms its own session when it runs.
  if (event === 'SessionStart') {
    try {
      const { arm, recompute, PERMANENT } = await import('../tools/backup-arm.mjs');
      const self = fileURLToPath(import.meta.url);
      if (!existsSync(join(home, '.claude', 'havok-mod'))) arm(home, PERMANENT, 'no mod on this machine');
      else if (sid) arm(home, sid, 'the mod did not handle the session start (' + String(data.source || '') + ')');
      recompute(home, self);
    } catch { /* arming is best effort; the jobs below still run */ }
  }

  const dir = process.env.HAVOK_DISPATCH_HOOKS || dirname(fileURLToPath(import.meta.url));
  const jobs = jobsFor(event, data);
  const forced = Number(process.env.HAVOK_DISPATCH_JOB_MS) || 0;
  const { cause, why } = whyNotHandled(marker, event, now);
  const results = await Promise.all(jobs.map((j) => runJob(dir, j, raw, forced || j.ms).then((r) => ({ ...r, ms: forced || j.ms }))));
  const answer = merge(event, results);
  const late = results.filter((r) => r.over).map((r) => r.job.file);
  const ran = jobs.map((j) => j.file + (j.args ? ':' + j.args.join(',') : '')).join(' ');
  const at = new Date(now).toISOString();
  // No mod on this machine (an install of the public engine): the backup is simply how its hooks run, so nothing is
  // logged under ~/.claude/havok-mod and no sender starts (privacy review of 0.4.80, 2026-11-02).
  const modHere = existsSync(join(home, '.claude', 'havok-mod'));
  if (modHere) logBackup(home, at + ' ' + event + ' session=' + (sid || 'none') + ' why="' + why + '" ran=' + ran
    + (late.length ? ' late=' + late.join(',') : '') + (marker && marker.v ? ' mod=' + marker.v : ''));
  // The status line shows it as a mod failure (The owner, 2026-11-03: "the hooks are a backup only and mods should never
  // fail"): one small file per session, read by release/statusline.mjs, so a silent fallback can never last.
  if (modHere && sid) noteBackup(home, sid, { at, event, cause, why });
  if (answer) process.stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer));
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
