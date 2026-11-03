// node --test hooks/check-session-start.test.mjs
// Context release, 2026-11-02 (review focus 1 of the plan): the session-start text stops repeating REFLEX, the router,
// HOT and the memory instructions only when the mod has said it delivered the global layer for THIS session, by
// writing ~/.claude/havok-mod/layers-live/<session>. A machine on the new brain with an old mod has no marker and keeps
// everything, so no agent is ever left without rules. Runs a copy of the hook on a throwaway brain and home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'session-start-'));
  const brain = join(root, 'brain'), home = join(root, 'home');
  for (const d of ['hooks', 'memory', 'index', 'tools']) mkdirSync(join(brain, d), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  copyFileSync(join(HERE, 'check-session-start.mjs'), join(brain, 'hooks', 'check-session-start.mjs'));
  copyFileSync(join(HERE, 'memory-instructions.md'), join(brain, 'hooks', 'memory-instructions.md'));
  copyFileSync(join(HERE, '..', 'tools', 'session-setup.mjs'), join(brain, 'tools', 'session-setup.mjs'));
  writeFileSync(join(brain, 'REFLEX.md'), '# REFLEX\nreflex rule text\n');
  writeFileSync(join(brain, 'memory', 'MEMORY.md'), '# Router\nrouter text\n');
  writeFileSync(join(brain, 'memory', 'reference_x.md'), '---\nname: reference_x\n---\nx\n');
  writeFileSync(join(brain, 'index', 'HOT.md'), '# HOT\nhot text\n');
  execFileSync('git', ['init', '-q'], { cwd: brain, windowsHide: true });
  return { root, brain, home };
}

function run({ brain, home }, input) {
  const out = execFileSync(process.execPath, [join(brain, 'hooks', 'check-session-start.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, USERPROFILE: home, HOME: home, HAVOK_BRAIN: brain },
  });
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

test('keeps the tiers when the mod has not reported layers-live, and drops them when it has', { timeout: 300000 }, () => {
  const s = setup();
  try {
    const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const full = run(s, { session_id: sid, source: 'startup' });
    for (const want of ['BRAIN:', 'BRAIN TIER 0: REFLEX', 'reflex rule text', 'MEMORY ROUTER', 'router text', 'HOT, what is in play', 'hot text', '# Memory']) {
      assert.ok(full.includes(want), 'without the marker the output holds ' + want);
    }
    assert.doesNotMatch(full, /keep-warm/i);

    mkdirSync(join(s.home, '.claude', 'havok-mod', 'layers-live'), { recursive: true });
    writeFileSync(join(s.home, '.claude', 'havok-mod', 'layers-live', sid), '');
    const slim = run(s, { session_id: sid, source: 'startup' });
    assert.match(slim, /^BRAIN: /);
    assert.match(slim, /brain verify|Gate:/i);
    for (const gone of ['REFLEX', 'reflex rule text', 'router text', 'hot text', '# Memory', 'RECALL IS NOT OPTIONAL']) {
      assert.ok(!slim.includes(gone), 'with the marker the output has no ' + gone);
    }
    assert.doesNotMatch(slim, /keep-warm/i);
    assert.ok(slim.length < full.length / 2);

    const other = run(s, { session_id: 'bbbbbbbb-1111-2222-3333-444444444444', source: 'startup' });
    assert.ok(other.includes('reflex rule text'), 'the marker of one session does not slim another');
    const traversal = run(s, { session_id: '../layers-live/' + sid, source: 'startup' });
    assert.ok(traversal.includes('reflex rule text'), 'a session id that is not a plain id never matches a marker');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
