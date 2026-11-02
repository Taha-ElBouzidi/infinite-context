// node --test tools/hook-rules.test.mjs
// The pure rule modules the command hooks and the mod share (hooks/*-rules.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markerKey, marked, handled, FRESH_MS, KEEP_KEYS } from '../hooks/alive-rules.mjs';
import { contentProblems, styleProblems } from '../hooks/content-rules.mjs';
import { afterStop, snapshotOf, SUBSTANTIAL_STOPS } from '../hooks/memory-rules.mjs';
import { pingContext, fromTimer, isPingText, ALLOWED_CONTEXT, OLD_TIMER_CONTEXT } from '../hooks/keepwarm-rules.mjs';
import { hitsOf, typedUrgent } from '../hooks/limit-rules.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const EM = String.fromCharCode(0x2014);

test('every rule module is pure: no import at all, so the mod (no Node there) can load it', () => {
  const files = readdirSync(HOOKS).filter((f) => f.endsWith('-rules.mjs'));
  assert.ok(files.length >= 11, files.join(','));
  for (const f of files) assert.doesNotMatch(readFileSync(join(HOOKS, f), 'utf8'), /^\s*import\s/m, f);
});

test('the marker names one event and one input: another tool call, another prompt or an old mark does not count', () => {
  const now = 1_000_000;
  const call = { tool_use_id: 'toolu_a', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const m = marked(null, '0.1.7', 'PreToolUse', markerKey('PreToolUse', call), now);
  assert.equal(handled(m, 'PreToolUse', call, now + 10), true);
  assert.equal(handled(m, 'PreToolUse', { ...call, tool_use_id: 'toolu_b' }, now + 10), false);
  assert.equal(handled(m, 'Stop', call, now + 10), false);
  assert.equal(handled(m, 'PreToolUse', call, now + FRESH_MS + 1), false);
  const p = { prompt_id: 'p1', prompt: 'hello' };
  const m2 = marked(m, '0.1.7', 'UserPromptSubmit', markerKey('UserPromptSubmit', p), now);
  assert.equal(handled(m2, 'UserPromptSubmit', p, now + 10), true);
  assert.equal(handled(m2, 'UserPromptSubmit', { ...p, prompt: 'other' }, now + 10), false);
  assert.equal(handled(m2, 'PreToolUse', call, now + 10), true);
});

test('parallel tool calls: the marker keeps the last ones, not only the newest', () => {
  let m = null;
  for (let i = 0; i < KEEP_KEYS + 5; i++) m = marked(m, 'v', 'PreToolUse', 'k' + i, 100 + i);
  assert.equal(handled(m, 'PreToolUse', { tool_use_id: 'k' + (KEEP_KEYS + 4) }, 200), true);
  assert.equal(handled(m, 'PreToolUse', { tool_use_id: 'k5' }, 200), true);
  assert.equal(handled(m, 'PreToolUse', { tool_use_id: 'k0' }, 200), false);
});

test('PowerShell commands are held to the writing rules like Bash', () => {
  assert.ok(contentProblems('PowerShell', { command: 'Write-Output "a ' + EM + ' b"' }));
  assert.equal(contentProblems('PowerShell', { command: 'Get-ChildItem' }), null);
});

test('the reply check counts every symbol', () => {
  assert.deepEqual(styleProblems('plain words'), []);
  assert.equal(styleProblems('a ' + EM).length, 1);
});

test('the "nothing saved" note comes once, after eight turns with no memory written', () => {
  const snap = snapshotOf([{ name: 'a.md', mtimeMs: 5 }, { name: 'MEMORY.md', mtimeMs: 99 }]);
  assert.deepEqual(snap, { count: 1, newest: 5 });
  let r = afterStop(null, snap, 'M');
  const notes = [];
  for (let i = 1; i < SUBSTANTIAL_STOPS + 3; i++) { r = afterStop(r.state, snap, 'M'); if (r.note) notes.push(i); }
  assert.deepEqual(notes, [SUBSTANTIAL_STOPS - 1]);
  const wrote = afterStop({ base: snap, stops: 9, nudged: false }, { count: 2, newest: 6 }, 'M');
  assert.equal(wrote.note, undefined);
});

test('keep-warm: a ping is never refused; the mod ping answers one word, an old timer ping deletes that timer', () => {
  assert.equal(isPingText(' keep-warm ping '), true);
  assert.equal(fromTimer({ source: 'schedule_wakeup' }), true);
  assert.equal(fromTimer({ source: 'user' }), false);
  assert.equal(pingContext(true), ALLOWED_CONTEXT);
  assert.equal(pingContext(false), OLD_TIMER_CONTEXT);
  assert.match(OLD_TIMER_CONTEXT, /CronDelete/);
});

test('limit: an old reading never blocks; urgent opens only when typed', () => {
  const now = Date.now();
  const at = Math.floor(now / 1000);
  assert.equal(hitsOf({ five: { used_percentage: 99, resets_at: at - 10 } }, now).hits.length, 0);
  assert.equal(hitsOf({ five: { used_percentage: 99, resets_at: at + 10 } }, now).hits.length, 1);
  assert.equal(typedUrgent({ hook_event_name: 'UserPromptSubmit', prompt: 'urgent fix', source: 'user' }), true);
  assert.equal(typedUrgent({ hook_event_name: 'UserPromptSubmit', prompt: 'urgent fix', source: 'schedule_wakeup' }), false);
});

test('a commit folder: cd, Set-Location and git -C move it; a folder this cannot read keeps the session folder', async () => {
  const { commitDir, isCommitAttempt } = await import('../hooks/secret-rules.mjs');
  assert.equal(commitDir('git commit -m x', 'C:/s'), 'C:/s');
  assert.equal(commitDir('cd D:/dev/repo && git commit -m x', 'C:/s'), 'D:/dev/repo');
  assert.equal(commitDir('cd "D:/my repo" && git add . && git commit -m x', 'C:/s'), 'D:/my repo');
  assert.equal(commitDir('cd sub; git commit -m x', 'C:/s'), 'C:/s/sub');
  assert.equal(commitDir('cd /d/dev/repo && git commit -m x', 'C:/s'), 'D:/dev/repo');
  assert.equal(commitDir("Set-Location -Path 'D:\\dev\\repo'; git commit -m x", 'C:/s'), 'D:/dev/repo');
  assert.equal(commitDir('git -C D:/dev/repo commit -m x', 'C:/s'), 'D:/dev/repo');
  assert.equal(commitDir('(cd D:/a && make); git commit -m x', 'C:/s'), 'C:/s');
  assert.equal(commitDir('cd $REPO && git commit -m x', 'C:/s'), 'C:/s');
  assert.equal(commitDir('cd ~ && git commit -m x', 'C:/s'), 'C:/s');
  assert.equal(isCommitAttempt('git -C D:/dev/repo commit -m x'), true);
  assert.equal(isCommitAttempt('git status'), false);
});

// A memory written with Write or Edit settles the learned items. The folder used to be matched by the name havok-brain,
// so in a clone named infinite-context a memory write was never seen (privacy review of 0.4.80, 2026-11-02).
test('recall rules see a memory write in the brain folder they are given, whatever it is called', async () => {
  const { onTool } = await import('../hooks/recall-rules.mjs');
  const s = { searched: true, learned: 1 };
  const write = (file_path, brainDir) => onTool(s, 'Write', { file_path }, 'cli', brainDir).state.learned;
  assert.equal(write(String.raw`C:\Users\me\infinite-context\memory\feedback_a.md`, String.raw`C:\Users\me\infinite-context`), 0);
  assert.equal(write('/home/me/infinite-context/memory/feedback_a.md', '/home/me/infinite-context'), 0);
  assert.equal(write('/home/me/other-project/memory/notes.md', '/home/me/infinite-context'), 1);
  assert.equal(write('/home/me/infinite-context/memory/feedback_a.md'), 0, 'with no folder given, a memory file still counts');
});
