// The backup block in settings.json exists only while a session is armed (tools/backup-arm.mjs, HAVOK 2026-11-03).
//   node --test tools/backup-arm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { arm, disarm, recompute, armedSessions, MARK, PERMANENT } from './backup-arm.mjs';
import { markerKey, marked, ALIVE_DIR } from '../hooks/alive-rules.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = join(BRAIN, 'hooks', 'dispatch.mjs');
function home({ mod = true, settings } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'backuparm-'));
  mkdirSync(join(h, '.claude'), { recursive: true });
  if (mod) mkdirSync(join(h, '.claude', 'havok-mod'), { recursive: true });
  if (settings !== undefined) writeFileSync(join(h, '.claude', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return h;
}
const settingsOf = (h) => JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
const ourGroups = (s) => Object.values(s.hooks || {}).flat().filter((g) => g.hooks.some((x) => x.command.includes(MARK)));

test('armed: the block holds the dispatcher for the four events; disarmed: it goes, and the owner\'s own hooks stay', () => {
  const own = { model: 'opus', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node mine.mjs' }] }] } };
  const h = home({ settings: own });
  arm(h, 'sess-1', 'test');
  assert.match(recompute(h, DISPATCH), /armed: backup block written/);
  const s = settingsOf(h);
  assert.equal(ourGroups(s).length, 4);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, 'node mine.mjs');
  assert.equal(s.hooks.PreToolUse[0].matcher, '.*');
  assert.equal(s.model, 'opus');
  assert.ok(existsSync(join(h, '.claude', 'settings.json.bak-havok-backup')));
  assert.match(recompute(h, DISPATCH), /already in place/);
  disarm(h, 'sess-1');
  assert.match(recompute(h, DISPATCH), /disarmed/);
  assert.deepEqual(settingsOf(h), own);
});

test('two sessions: the block stays while either is armed', () => {
  const h = home({ settings: {} });
  arm(h, 'a', 'x'); arm(h, 'b', 'y'); recompute(h, DISPATCH);
  disarm(h, 'a'); recompute(h, DISPATCH);
  assert.equal(ourGroups(settingsOf(h)).length, 4);
  disarm(h, 'b'); recompute(h, DISPATCH);
  assert.equal(ourGroups(settingsOf(h)).length, 0);
  assert.deepEqual(armedSessions(h), []);
});

test('a settings.json that does not parse is left untouched', () => {
  const h = home({ settings: '{ not json' });
  arm(h, 'a', 'x');
  assert.match(recompute(h, DISPATCH), /does not parse/);
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), '{ not json');
});

const start = (h, extra = {}) => spawnSync(process.execPath, [DISPATCH, 'SessionStart'], {
  input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' }), encoding: 'utf8', windowsHide: true, timeout: 60000,
  env: { ...process.env, USERPROFILE: h, HOME: h, HAVOK_DISPATCH_HOOKS: mkdtempSync(join(tmpdir(), 'nohooks-')), ...extra },
});

test('a session start the mod did not handle arms that session; one it handled arms nothing', () => {
  const h = home({ settings: {} });
  start(h);
  assert.deepEqual(armedSessions(h).map((x) => x.sid), ['s1']);
  assert.equal(ourGroups(settingsOf(h)).length, 4);
  const h2 = home({ settings: {} });
  const dir = join(h2, ...ALIVE_DIR.split('/'));
  mkdirSync(dir, { recursive: true });
  const data = { hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' };
  writeFileSync(join(dir, 's1.json'), JSON.stringify(marked(null, '0.1.31', 'SessionStart', markerKey('SessionStart', data), Date.now())));
  start(h2);
  assert.deepEqual(armedSessions(h2), []);
  assert.equal(existsSync(join(h2, '.claude', 'settings.json')) ? ourGroups(settingsOf(h2)).length : 0, 0);
});

test('a machine without the mod is armed for good', () => {
  const h = home({ mod: false, settings: {} });
  start(h);
  assert.deepEqual(armedSessions(h).map((x) => x.sid), [PERMANENT]);
  assert.equal(ourGroups(settingsOf(h)).length, 4);
});
