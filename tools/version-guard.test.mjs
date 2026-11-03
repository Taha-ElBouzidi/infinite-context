import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionGuard, compareVersions } from './version-guard.mjs';

const hook = ['hooks/pre-turn.mjs'];

test('versions compare by number, not by text', () => {
  assert.equal(compareVersions('0.4.10', '0.4.9'), 1);
  assert.equal(compareVersions('0.4.81', '0.4.81'), 0);
  assert.equal(compareVersions('0.4.80', '0.4.81'), -1);
});

test('no hook code staged passes at any version', () => {
  assert.equal(versionGuard({ hookChange: [], branch: 'master', now: '1.0.0', head: '1.0.0' }).ok, true);
});

test('master: a hook change without a bump against HEAD fails, with a bump passes', () => {
  assert.equal(versionGuard({ hookChange: hook, branch: 'master', now: '0.4.81', head: '0.4.81', base: '0.4.81', master: '0.4.81' }).ok, false);
  assert.equal(versionGuard({ hookChange: hook, branch: 'master', now: '0.4.82', head: '0.4.81', base: '0.4.81', master: '0.4.81' }).ok, true);
});

test('branch: a second hook commit after the one bump passes', () => {
  const r = versionGuard({ hookChange: hook, branch: 'context-release', now: '0.4.81', head: '0.4.81', base: '0.4.80', master: '0.4.80' });
  assert.equal(r.ok, true, r.message);
});

test('branch: no bump since leaving master fails', () => {
  assert.equal(versionGuard({ hookChange: hook, branch: 'context-release', now: '0.4.80', head: '0.4.80', base: '0.4.80', master: '0.4.80' }).ok, false);
});

test('branch: master released the same number meanwhile fails', () => {
  const r = versionGuard({ hookChange: hook, branch: 'context-release', now: '0.4.81', head: '0.4.81', base: '0.4.80', master: '0.4.81' });
  assert.equal(r.ok, false);
  assert.match(r.message, /master is now at 0\.4\.81/);
});

test('branch: master moved above the branch fails', () => {
  assert.equal(versionGuard({ hookChange: hook, branch: 'context-release', now: '0.4.81', head: '0.4.81', base: '0.4.80', master: '0.4.82' }).ok, false);
});

test('detached HEAD (a rebase replay) keeps the master rule', () => {
  assert.equal(versionGuard({ hookChange: hook, branch: 'HEAD', now: '0.4.81', head: '0.4.81', base: '0.4.80', master: '0.4.80' }).ok, false);
});

// A lower version on master is not a bump: claude plugin update would never pick the change up.
test('master: a hook change that lowers the plugin version fails', () => {
  const r = versionGuard({ hookChange: hook, branch: 'master', now: '0.4.80', head: '0.4.82' });
  assert.equal(r.ok, false, r.message);
  assert.match(r.message, /0\.4\.80/);
  assert.equal(versionGuard({ hookChange: hook, branch: 'HEAD', now: '0.4.9', head: '0.4.10' }).ok, false, 'compared as numbers, detached HEAD too');
});
