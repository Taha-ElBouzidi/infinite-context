// node --test tools/session-setup.test.mjs
// What session start may change outside the brain (privacy review of 0.4.80, 2026-11-02). In an install of the public
// repository (package.json names infinite-context) it never merges permission settings into ~/.claude/settings.json
// and never edits ~/.gemini or another tool's config; the owner's own brain keeps doing both. The git gate is armed only
// where hooks/git exists. Each test builds a code folder and a home folder in temporary directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInstall, mergeSharedSettings, wireAntigravity, wantsGitHooks } from './session-setup.mjs';

function place({ name, settings = true, gitHooks = false }) {
  const root = mkdtempSync(join(tmpdir(), 'session-setup-'));
  const here = join(root, 'code');
  const home = join(root, 'home');
  mkdirSync(join(here, 'hooks'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.gemini'), { recursive: true });
  writeFileSync(join(here, 'package.json'), JSON.stringify({ name }));
  writeFileSync(join(here, 'hooks', 'hooks.json'), '{}');
  if (settings) writeFileSync(join(here, 'hooks', 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  if (gitHooks) { mkdirSync(join(here, 'hooks', 'git')); writeFileSync(join(here, 'hooks', 'git', 'pre-commit'), '#!/bin/sh\n'); }
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
  return { root, here, home, settings: () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) };
}

test('an install is recognised by its package.json', () => {
  const a = place({ name: 'infinite-context' });
  const b = place({ name: 'my-brain' });
  try { assert.equal(isInstall(a.here), true); assert.equal(isInstall(b.here), false); }
  finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }); }
});

test('in an install, session start never merges permission settings into the user settings', () => {
  const p = place({ name: 'infinite-context' });
  try {
    assert.deepEqual(mergeSharedSettings({ here: p.here, home: p.home }), []);
    assert.equal(p.settings().permissions.defaultMode, 'default');
    assert.equal(p.settings().skipDangerousModePermissionPrompt, undefined);
  } finally { rmSync(p.root, { recursive: true, force: true }); }
});

test('in the owner brain the shared settings are still merged', () => {
  const p = place({ name: 'my-brain' });
  try {
    assert.ok(mergeSharedSettings({ here: p.here, home: p.home }).length > 0);
    assert.equal(p.settings().permissions.defaultMode, 'bypassPermissions');
  } finally { rmSync(p.root, { recursive: true, force: true }); }
});

test('in an install, another tool config (~/.gemini) is never edited', () => {
  const p = place({ name: 'infinite-context' });
  try {
    assert.equal(wireAntigravity({ here: p.here, home: p.home }), false);
    assert.ok(!existsSync(join(p.home, '.gemini', 'config')), 'the Gemini config folder was created');
  } finally { rmSync(p.root, { recursive: true, force: true }); }
});

test('in the owner brain Antigravity is still wired where it is installed', () => {
  const p = place({ name: 'my-brain' });
  try {
    assert.equal(wireAntigravity({ here: p.here, home: p.home }), true);
    assert.ok(existsSync(join(p.home, '.gemini', 'config', 'mcp_config.json')));
  } finally { rmSync(p.root, { recursive: true, force: true }); }
});

test('the git gate is armed only where hooks/git exists', () => {
  const a = place({ name: 'infinite-context' });
  const b = place({ name: 'my-brain', gitHooks: true });
  try { assert.equal(wantsGitHooks(a.here), false); assert.equal(wantsGitHooks(b.here), true); }
  finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }); }
});
