// node --test tools/dispatch.test.mjs
// hooks/dispatch.mjs, the one command hook per event: it steps aside when the mod handled this very event
// (the marker the mod writes, hooks/alive-rules.mjs) and otherwise runs the old hooks itself, exactly as before.
// Runs with USERPROFILE and HOME pointed at a temporary folder, so this machine's marker, limits and logs are never
// read or written. The fake-hooks tests point HAVOK_DISPATCH_HOOKS at a folder of stand-in scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { marked, markerKey, ALIVE_DIR } from '../hooks/alive-rules.mjs';
import { JOBS } from '../hooks/dispatch.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const DISPATCH = join(HOOKS, 'dispatch.mjs');
const EM = String.fromCharCode(0x2014);

// A machine with the mod installed has ~/.claude/havok-mod; mod: false is an install without the mod.
function home({ mod = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-'));
  mkdirSync(join(root, '.claude'));
  if (mod) mkdirSync(join(root, '.claude', 'havok-mod'));
  return root;
}
function run(root, event, input, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [DISPATCH, event], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, USERPROFILE: root, HOME: root, CLAUDE_PLUGIN_ROOT: '', ...env } });
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, ms: Date.now() - t0, status: r.status, err: r.stderr };
}
function mark(root, sid, event, input, at = Date.now()) {
  const dir = join(root, ...ALIVE_DIR.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sid + '.json'), JSON.stringify(marked(null, '0.1.7', event, markerKey(event, input), at)));
}
const backupLog = (root) => { const f = join(root, '.claude', 'havok-mod', 'backup.log'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
const bashEm = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'echo a ' + EM + ' b' }, cwd: tmpdir() };

// Stand-in hooks: each records that it ran, then prints what the test asks for (or hangs).
function fakeHooks(behaviour) {
  const dir = mkdtempSync(join(tmpdir(), 'fakehooks-'));
  const ran = join(dir, 'ran');
  mkdirSync(ran);
  const files = new Set(Object.values(JOBS).flat().map((j) => j.file));
  for (const f of files) {
    const b = behaviour[f] || {};
    writeFileSync(join(dir, f), [
      "import { writeFileSync, readFileSync } from 'node:fs';",
      'readFileSync(0);',
      `writeFileSync(${JSON.stringify(join(ran, f + '.' + Math.random().toString(16).slice(2)))}, process.argv.slice(2).join(' '));`,
      b.hang ? 'setInterval(() => {}, 1000);' : '',
      b.print ? `process.stdout.write(${JSON.stringify(JSON.stringify(b.print))});` : '',
    ].join('\n'));
  }
  return { dir, ran: () => readdirSync(ran).map((n) => n.replace(/\.[0-9a-f]+$/, '')) };
}

// An install of the public engine has no mod: the backup is simply how its hooks run, so it writes nothing under
// ~/.claude/havok-mod and starts no sender (privacy review of 0.4.80, 2026-11-02).
test('with no mod installed, the dispatcher runs the hooks but writes no mod files and starts no sender', () => {
  const root = home({ mod: false });
  try {
    const r = run(root, 'PreToolUse', bashEm);
    assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(r.out));
    assert.ok(!existsSync(join(root, '.claude', 'havok-mod')), 'a mod folder was written in a home with no mod');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every job the dispatcher names exists in hooks/, so the backup can run them', () => {
  for (const jobs of Object.values(JOBS)) for (const j of jobs) assert.ok(existsSync(join(HOOKS, j.file)), j.file);
});

test('the mod handled this very tool call: the dispatcher runs nothing and says nothing', () => {
  const root = home();
  const fake = fakeHooks({});
  try {
    mark(root, 's1', 'PreToolUse', bashEm);
    const r = run(root, 'PreToolUse', bashEm, { HAVOK_DISPATCH_HOOKS: fake.dir });
    assert.equal(r.out, null);
    assert.deepEqual(fake.ran(), []);
    assert.equal(backupLog(root), '');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('the mod handled another tool call, not this one: the old hooks run and refuse the em dash, and the fallback is logged', () => {
  const root = home();
  try {
    mark(root, 's1', 'PreToolUse', { ...bashEm, tool_use_id: 'toolu_other' });
    const r = run(root, 'PreToolUse', bashEm);
    assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /em dash/);
    assert.match(backupLog(root), /PreToolUse .*s1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no marker at all (mod missing, crashed or skipped): the old hooks run', () => {
  const root = home();
  try {
    const r = run(root, 'PreToolUse', bashEm);
    assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a marker older than a minute does not count', () => {
  const root = home();
  try {
    mark(root, 's1', 'PreToolUse', bashEm, Date.now() - 2 * 60_000);
    const r = run(root, 'PreToolUse', bashEm);
    assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the backup runs only the hooks of this event whose matcher fits the tool, as hooks.json did', () => {
  const root = home();
  const fake = fakeHooks({});
  try {
    run(root, 'PreToolUse', { ...bashEm, tool_name: 'Read', tool_input: { file_path: 'x' } }, { HAVOK_DISPATCH_HOOKS: fake.dir });
    assert.deepEqual(fake.ran().sort(), ['brain-gate.mjs', 'check-limit.mjs', 'recall-gate.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('a safety hook that does not finish refuses the call instead of letting it through', () => {
  const root = home();
  const fake = fakeHooks({ 'check-secrets.mjs': { hang: true } });
  try {
    const commit = { ...bashEm, tool_input: { command: 'git commit -m "x"' } };
    const r = run(root, 'PreToolUse', commit, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
    assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /secret scan .*did not finish/i);
    assert.ok(r.ms < 15000, 'took ' + r.ms);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('a hook that is not a safety check and does not finish is dropped, as Claude Code drops a timed-out hook', () => {
  const root = home();
  const fake = fakeHooks({ 'helper-brain.mjs': { hang: true } });
  try {
    const r = run(root, 'PreToolUse', { ...bashEm, tool_name: 'Agent', tool_input: { prompt: 'p' } }, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
    assert.equal(r.out, null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('a refusal wins over an input rewrite; with no refusal the rewrite goes through', () => {
  const root = home();
  const rewrite = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { prompt: 'p2' } } };
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'limit' } };
  const a = fakeHooks({ 'helper-brain.mjs': { print: rewrite } });
  const b = fakeHooks({ 'helper-brain.mjs': { print: rewrite }, 'check-limit.mjs': { print: deny } });
  try {
    const agent = { ...bashEm, tool_name: 'Agent', tool_input: { prompt: 'p' } };
    assert.deepEqual(run(root, 'PreToolUse', agent, { HAVOK_DISPATCH_HOOKS: a.dir }).out, rewrite);
    assert.equal(run(root, 'PreToolUse', agent, { HAVOK_DISPATCH_HOOKS: b.dir }).out.hookSpecificOutput.permissionDecisionReason, 'limit');
  } finally { for (const d of [root, a.dir, b.dir]) rmSync(d, { recursive: true, force: true }); }
});

test('a prompt: a block wins, otherwise every hook\'s context is handed on together', () => {
  const root = home();
  const ctx = (t) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: t } });
  const a = fakeHooks({ 'style-note.mjs': { print: ctx('slip') }, 'brain-gate.mjs': { print: ctx('down') } });
  const b = fakeHooks({ 'style-note.mjs': { print: ctx('slip') }, 'check-limit.mjs': { print: { decision: 'block', reason: 'reserve' } } });
  try {
    const p = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi', prompt_id: 'p1' };
    const ra = run(root, 'UserPromptSubmit', p, { HAVOK_DISPATCH_HOOKS: a.dir }).out;
    assert.match(ra.hookSpecificOutput.additionalContext, /down/);
    assert.match(ra.hookSpecificOutput.additionalContext, /slip/);
    assert.deepEqual(run(root, 'UserPromptSubmit', p, { HAVOK_DISPATCH_HOOKS: b.dir }).out, { decision: 'block', reason: 'reserve' });
  } finally { for (const d of [root, a.dir, b.dir]) rmSync(d, { recursive: true, force: true }); }
});

test('the limit check that does not finish blocks the prompt (it is a safety check)', () => {
  const root = home();
  const fake = fakeHooks({ 'check-limit.mjs': { hang: true } });
  try {
    const r = run(root, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
    assert.equal(r.out?.decision, 'block');
    assert.match(r.out.reason, /did not finish/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('the mod handled this Stop: nothing runs; a Stop it did not handle runs the stop hooks and keeps a block', () => {
  const root = home();
  const fake = fakeHooks({ 'brain-gate.mjs': { print: { decision: 'block', reason: 'brain down' } } });
  try {
    const s = { hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1', stop_hook_active: false, last_assistant_message: 'done' };
    mark(root, 's1', 'Stop', s);
    assert.equal(run(root, 'Stop', s, { HAVOK_DISPATCH_HOOKS: fake.dir }).out, null);
    assert.deepEqual(fake.ran(), []);
    const r = run(root, 'Stop', { ...s, last_assistant_message: 'other reply' }, { HAVOK_DISPATCH_HOOKS: fake.dir });
    assert.deepEqual(r.out, { decision: 'block', reason: 'brain down' });
    assert.deepEqual(fake.ran().sort(), ['brain-gate.mjs', 'check-memory-written.mjs', 'check-stop.mjs', 'recall-gate.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('the handled path is quick: one node start and one small file read', () => {
  const root = home();
  try {
    mark(root, 's1', 'PreToolUse', bashEm);
    const times = [0, 1, 2].map(() => run(root, 'PreToolUse', bashEm).ms);
    assert.ok(Math.min(...times) < 1500, 'took ' + times.join(', '));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the backup refuses a visible window and a new watcher when the mod did not run, and lets a hidden call through', () => {
  const root = home();
  try {
    const call = (tool, command) => ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: tool, tool_use_id: 'toolu_w' + command.length, tool_input: { command }, cwd: tmpdir() });
    const window = run(root, 'PreToolUse', call('PowerShell', 'Start-Process notepad.exe'));
    assert.equal(window.out?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(window.out.hookSpecificOutput.permissionDecisionReason, /-WindowStyle Hidden/);
    const watcher = run(root, 'PreToolUse', call('Bash', 'schtasks /Create /SC MINUTE /MO 1 /TN W /TR "wscript C:/x/l.vbs" /F'));
    assert.match(watcher.out?.hookSpecificOutput?.permissionDecisionReason || '', /add the marker/);
    assert.equal(run(root, 'PreToolUse', call('PowerShell', 'Start-Process node -ArgumentList s.mjs -WindowStyle Hidden')).out, null);
    assert.equal(run(root, 'PreToolUse', call('Read', 'x')).out, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the window check is a safety check: past its time it refuses, and it runs for Bash and PowerShell only', () => {
  const root = home();
  const fake = fakeHooks({ 'check-windows.mjs': { hang: true } });
  try {
    const r = run(root, 'PreToolUse', bashEm, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
    assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /window and watcher check .*did not finish/i);
    const fake2 = fakeHooks({});
    run(root, 'PreToolUse', { ...bashEm, tool_name: 'Read', tool_input: { file_path: 'x' } }, { HAVOK_DISPATCH_HOOKS: fake2.dir });
    assert.ok(!fake2.ran().includes('check-windows.mjs'));
    rmSync(fake2.dir, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
});


test('the backup never blocks a keep-warm ping: an old timer is told to delete itself, any other ping to answer ok', () => {
  const root = home();
  try {
    const p = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'keep-warm ping', prompt_id: 'p1' };
    const timer = run(root, 'UserPromptSubmit', { ...p, source: 'schedule_wakeup' }).out;
    assert.equal(timer?.decision, undefined);
    assert.match(timer.hookSpecificOutput.additionalContext, /CronDelete/);
    const own = run(root, 'UserPromptSubmit', { ...p, prompt_id: 'p2' }).out;
    assert.equal(own?.decision, undefined);
    assert.match(own.hookSpecificOutput.additionalContext, /single word ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The owner, 2026-11-03: "the hooks are a backup only and mods should never fail". Each backup run leaves a note per session
// that the status line shows as a mod failure; the handled path leaves none.
test('a backup run leaves a per-session note with its reason for the status line; a handled event leaves none', () => {
  const root = home();
  run(root, 'PreToolUse', bashEm);
  const f = join(root, '.claude', 'havok-mod', 'backup', 's1.json');
  assert.ok(existsSync(f));
  const note = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(note.event, 'PreToolUse');
  assert.equal(note.cause, 'no-marker');
  assert.match(note.why, /no mod marker/);
  const root2 = home();
  mark(root2, 's1', 'PreToolUse', bashEm);
  run(root2, 'PreToolUse', bashEm);
  assert.equal(existsSync(join(root2, '.claude', 'havok-mod', 'backup', 's1.json')), false);
});
