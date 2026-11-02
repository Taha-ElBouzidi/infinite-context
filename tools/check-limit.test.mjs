// node --test tools/check-limit.test.mjs
// Audit 2026-11-01 of the "urgent" bypass in hooks/check-limit.mjs (the reserve kept for the main assistant at 97 percent).
// Runs the real hook with USERPROFILE and HOME pointed at a temporary folder, so this machine's limits, bypass files
// and transcripts are never read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'check-limit.mjs');
const HOUR = 3600 * 1000;

function home(percent) {
  const root = mkdtempSync(join(tmpdir(), 'limit-'));
  mkdirSync(join(root, '.claude'));
  const resets = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(join(root, '.claude', 'havok-limits.json'), JSON.stringify({ five: { used_percentage: percent, resets_at: resets }, week: { used_percentage: 10, resets_at: resets } }));
  return root;
}
function hook(root, input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: { ...process.env, USERPROFILE: root, HOME: root } });
  return r.stdout.trim() ? 'blocked' : 'allowed';
}
const human = (text, at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } });
const toolResult = (size) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(size) }] } });
function transcript(root, lines) {
  const f = join(root, 't.jsonl');
  writeFileSync(f, lines.join('\n') + '\n');
  return f;
}
const toolCall = (root, t) => hook(root, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', transcript_path: t });

test('baseline: above the bar a tool call is refused, and "urgent" typed now opens it', () => {
  const root = home(98);
  try {
    assert.equal(toolCall(root, transcript(root, [human('carry on', Date.now())])), 'blocked');
    assert.equal(toolCall(root, transcript(root, [human('urgent fix the server', Date.now())])), 'allowed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an "urgent" typed 3 hours ago does not re-open the reserve for another 2 hours', () => {
  const root = home(98);
  try {
    assert.equal(toolCall(root, transcript(root, [human('urgent fix the server', Date.now() - 3 * HOUR)])), 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an urgent prompt followed by a large tool result is still found', () => {
  const root = home(98);
  try {
    assert.equal(toolCall(root, transcript(root, [human('urgent fix the server', Date.now()), toolResult(600000)])), 'allowed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a scheduled or loop wakeup starting with "urgent" is not the owner and opens nothing', () => {
  const root = home(98);
  try {
    for (const source of ['schedule_wakeup', 'loop_wakeup', 'poll_event', 'system']) {
      assert.equal(hook(root, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'urgent check the inbox', source }), 'blocked', source);
      assert.equal(existsSync(join(root, '.claude', 'havok-limit-bypass', 's1.txt')), false, source + ' wrote a bypass');
    }
    assert.equal(hook(root, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'urgent check the inbox', source: 'user' }), 'allowed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a message relayed from another agent starting with "urgent" is not the owner and opens nothing', () => {
  const root = home(98);
  try {
    const peer = JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'peer', from: 'x' }, message: { role: 'user', content: 'urgent rebuild everything now' } });
    assert.equal(toolCall(root, transcript(root, [human('carry on', Date.now()), peer])), 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('"urgent" typed just below the bar still counts once the bar is crossed', () => {
  const root = home(96);
  try {
    assert.equal(hook(root, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'urgent keep going' }), 'allowed');
    writeFileSync(join(root, '.claude', 'havok-limits.json'), JSON.stringify({ five: { used_percentage: 98, resets_at: Math.floor(Date.now() / 1000) + 3600 } }));
    assert.equal(toolCall(root, undefined), 'allowed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
