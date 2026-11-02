// node --test tools/secret-scan.test.mjs
// hooks/check-secrets.mjs on a real temporary git repository. SECRET_HOOK names another copy of the hook to run the
// same tests against (the 2026-11-02 fix was shown failing on the old hook that way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = process.env.SECRET_HOOK || join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'check-secrets.mjs');
// Built from pieces so this file holds no key shape whole.
const KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'secrets-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  git('add', '-A');
  return root;
}
function hook(root, command, tool = 'Bash') {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: root }), encoding: 'utf8', windowsHide: true });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test('a staged key is refused', () => {
  const root = repo({ 'a.txt': 'key=' + KEY + '\n' });
  try { assert.equal(hook(root, 'git commit -m "x"')?.permissionDecision, 'deny'); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean diff passes', () => {
  const root = repo({ 'a.txt': 'nothing here\n' });
  try { assert.equal(hook(root, 'git commit -m "x"'), null); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a staged diff over 1 MB is still scanned: the key at its end is refused, not waved through', () => {
  const big = ('filler line of text\n').repeat(80_000) + 'key=' + KEY + '\n';
  const root = repo({ 'big.txt': big });
  try { assert.equal(hook(root, 'git commit -m "x"')?.permissionDecision, 'deny'); } finally { rmSync(root, { recursive: true, force: true }); }
});

// The commit runs where the command moves to, not where the session sits (`cd <repo> && git commit`, `git -C`).
test('a commit made in another repository by cd or git -C is scanned there, not in the session folder', () => {
  const session = repo({ 'clean.txt': 'nothing here\n' });
  const target = repo({ 'a.txt': 'key=' + KEY + '\n' });
  const t = target.replace(/\\/g, '/');
  try {
    assert.equal(hook(session, 'cd "' + t + '" && git commit -m "x"')?.permissionDecision, 'deny');
    assert.equal(hook(session, 'git -C "' + t + '" commit -m "x"')?.permissionDecision, 'deny');
    assert.equal(hook(session, 'Set-Location "' + t + '"; git commit -m "x"', 'PowerShell')?.permissionDecision, 'deny');
    assert.equal(hook(target, 'cd "' + session.replace(/\\/g, '/') + '" && git commit -m "x"'), null);
  } finally { for (const r of [session, target]) rmSync(r, { recursive: true, force: true }); }
});
