// node --test tools/update.test.mjs
// Automatic updates for installs of the public repository (the owner, 2026-11-02: "for the people that use our repo,
// they receive updates automatically"). Each test builds a fake upstream repository and a clone of it in temporary
// folders, so nothing here reaches the network or touches a real install. What is pinned:
//   only a release tag that is on main is installed, never one on another branch;
//   the user's memories and other own files are never touched, and a release that would touch them is refused;
//   verify runs after the update and a new failure rolls everything back;
//   automatic checks run from the recall hook at most once a day, can be turned off, and report once, in one line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, utimesSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stampKit, refreshKit } from './kit.mjs';
import { runUpdate, updateNotice, settings, changesBetween, failureKinds, dependenciesChanged, STATE } from './update.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_TOOL = readFileSync(join(REPO, 'tools', 'kit.mjs'), 'utf8');
const temps = [];
const temp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
process.on('exit', () => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const env = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^INFINITE_CONTEXT_|^HAVOK_BRAIN$/.test(k)) delete e[k]; return e; };
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

const kitMethod = (body) => [
  '---', 'name: How to do a', 'description: Do a, the words a person types for a: how to do it. Read before doing a.', 'type: reference',
  'metadata:', '  type: reference', '  asserted: 2026-09-26', '  updated: 2026-09-26', '---', '', '# How to do a', '', body, '', '## Related', '[[reference_how_to_b]]', '',
].join('\n');

// A minimal engine: the steps the updater runs (build-index, verify, kit refresh) are small scripts. verify passes,
// unless told to fail always, or only once the kit added a given method (a kit problem, not an engine one).
function engine(version, o = {}) {
  const verify = o.verifyFails
    ? "console.error('  FAIL  something this release broke'); process.exit(1);"
    : o.verifyFailsWith
      ? "import { existsSync } from 'node:fs'; if (existsSync('memory/" + o.verifyFailsWith + "')) { console.error('  FAIL  reflection has 1 finding(s), run: node tools/reflect.mjs'); process.exit(1); } console.log('BRAIN VERIFY PASSED');"
      : "console.log('BRAIN VERIFY PASSED');";
  return {
    'package.json': JSON.stringify({ name: o.name || 'infinite-context', version, dependencies: {} }, null, 2) + '\n',
    'CHANGELOG.md': '# Changelog\n\n' + ['0.3.0', '0.2.0'].filter((v) => v <= version).map((v) => '## ' + v + '\n\n- **Release ' + v + ' change.** It does a thing.\n\n').join('') + '## 0.1.0\n\n- **First release.** It starts.\n',
    '.gitignore': 'index/\nbrain.json\n.update-state.json\n.update.lock\n.kit-state.json\n*.log\n',
    '.gitattributes': '* text=auto eol=lf\n',
    'memory/.gitkeep': '',
    'tools/build-index.mjs': "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('index', { recursive: true }); writeFileSync('index/built.txt', 'built');\n",
    'tools/verify.mjs': '// verify ' + version + '\n' + verify + '\n',
    'tools/kit.mjs': KIT_TOOL,
    'kit/memory/reference_how_to_a.md': kitMethod(o.kitBody || 'Version one.'),
    ...(o.extra || {}),
  };
}
function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
}
function release(up, version, o = {}) {
  writeTree(up, engine(version, o));
  stampKit(join(up, 'kit'), { today: '2026-11-02' });
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'release ' + version);
  if (!o.noTag) git(up, 'tag', 'v' + version);
  return git(up, 'rev-parse', 'HEAD');
}
// An upstream at 0.1.0 and a user's install cloned from it, with the kit installed and a memory of the user's own.
function setup(o = {}) {
  const up = temp('ic-up-');
  git(up, 'init', '-q');
  release(up, '0.1.0', o.first || {});
  const home = temp('ic-install-');
  const install = join(home, 'brain');
  git(home, 'clone', '-q', up, install);
  refreshKit({ brain: install, today: '2026-10-01', init: true });
  writeFileSync(join(install, 'memory', 'user_note.md'), '---\nname: My note\ndescription: my own note about my work, written by me\ntype: user\n---\n\nMine.\n');
  return { up, install, old: git(install, 'rev-parse', 'HEAD') };
}
const mine = (install) => read(install, 'memory/user_note.md');
const state = (install) => JSON.parse(read(install, STATE));

test('a newer release on main is installed, the kit is refreshed, and the user memories are untouched', () => {
  const { up, install } = setup();
  const note = mine(install);
  release(up, '0.2.0', { kitBody: 'Version two.' });
  const tagged = release(up, '0.3.0', { kitBody: 'Version three.' });
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.equal(r.from, '0.1.0');
  assert.equal(r.to, '0.3.0', 'the newest release on main, in one step');
  assert.equal(git(install, 'rev-parse', 'HEAD'), tagged);
  assert.equal(JSON.parse(read(install, 'package.json')).version, '0.3.0');
  assert.match(read(install, 'memory/reference_how_to_a.md'), /Version three\./, 'the unchanged kit method was refreshed');
  assert.equal(mine(install), note, 'the user memory is byte for byte the same');
  assert.match(r.summary, /Release 0\.3\.0 change/);
  assert.match(r.summary, /Release 0\.2\.0 change/);
  assert.equal(git(install, 'status', '--porcelain', '--untracked-files=no'), '', 'the engine tree is clean at the release');
});

test('a release tag that is not on main is never installed', () => {
  const { up, install, old } = setup();
  git(up, 'checkout', '-q', '-b', 'staging');
  release(up, '0.3.0');
  git(up, 'checkout', '-q', 'main');
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'current', JSON.stringify(r));
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
});

test('verify failing after the update rolls everything back', () => {
  const { up, install, old } = setup();
  const kitCopy = read(install, 'memory/reference_how_to_a.md');
  const note = mine(install);
  release(up, '0.2.0', { verifyFails: true, kitBody: 'Version two.' });
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'rolled-back', JSON.stringify(r));
  assert.match(r.reason, /something this release broke/);
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
  assert.equal(JSON.parse(read(install, 'package.json')).version, '0.1.0');
  assert.equal(read(install, 'memory/reference_how_to_a.md'), kitCopy, 'the kit copy is as it was');
  assert.equal(mine(install), note);
  assert.equal(git(install, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('a kit method that breaks verify is taken back out, and the engine update stays', () => {
  const { up, install } = setup();
  const tagged = release(up, '0.2.0', { verifyFailsWith: 'reference_how_to_b.md', extra: { 'kit/memory/reference_how_to_b.md': kitMethod('B.').replace(/do a/g, 'do b').replace('[[reference_how_to_b]]', '[[reference_how_to_a]]') } });
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.equal(git(install, 'rev-parse', 'HEAD'), tagged);
  assert.match(r.kitNote, /taken back/);
  assert.ok(!existsSync(join(install, 'memory', 'reference_how_to_b.md')));
  assert.match(read(install, 'memory/reference_how_to_a.md'), /Version one\./);
});

test('an engine file changed by hand that the release also changes blocks the update, a hand change elsewhere is kept', () => {
  const { up, install, old } = setup();
  writeFileSync(join(install, 'tools', 'verify.mjs'), '// my own verify\nconsole.log("BRAIN VERIFY PASSED");\n');
  release(up, '0.2.0');
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.match(r.reason, /tools\/verify\.mjs/);
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
  assert.equal(read(install, 'tools/verify.mjs'), '// my own verify\nconsole.log("BRAIN VERIFY PASSED");\n');

  const second = setup();
  writeFileSync(join(second.install, '.gitignore'), read(second.install, '.gitignore') + 'my-own-folder/\n');
  release(second.up, '0.2.0');
  const r2 = runUpdate({ brain: second.install, url: second.up, env: env() });
  assert.equal(r2.status, 'updated', JSON.stringify(r2));
  assert.match(read(second.install, '.gitignore'), /my-own-folder/);
});

test('a release that would overwrite a file of the user, even an ignored one, is refused', () => {
  const { up, install, old } = setup();
  writeFileSync(join(install, 'brain.json'), '{"owner":"me"}\n');
  release(up, '0.2.0', { extra: { 'brain.json': '{"owner":"someone else"}\n' } });
  git(up, 'add', '-f', 'brain.json');
  git(up, 'commit', '-q', '--amend', '--no-edit');
  git(up, 'tag', '-f', 'v0.2.0');
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.match(r.reason, /brain\.json/);
  assert.equal(read(install, 'brain.json'), '{"owner":"me"}\n');
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
});

test('a release that carries memories is refused, so memory/ only ever holds the user own', () => {
  const { up, install, old } = setup();
  release(up, '0.2.0', { extra: { 'memory/feedback_from_upstream.md': '---\nname: x\ndescription: a memory that must never ship\ntype: feedback\n---\n' } });
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.match(r.reason, /memory\//);
  assert.ok(!existsSync(join(install, 'memory', 'feedback_from_upstream.md')));
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
});

// Saving memories commits them in the install (tools/save-brain.mjs), so counting those commits as the user's own
// would stop every update after the first save (2026-11-02). Commits that only touch memory/ and index/ are merged with
// the release instead; a commit that changes anything else still blocks.
test('an install whose own commits only hold memories is updated, and the memories stay', () => {
  const { up, install } = setup();
  git(install, 'add', 'memory/user_note.md');
  git(install, 'commit', '-q', '-m', 'my memories');
  release(up, '0.2.0');
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.match(git(install, 'log', '--format=%s'), /my memories/);
  assert.ok(existsSync(join(install, 'memory', 'user_note.md')));
  assert.match(read(install, 'tools/verify.mjs'), /verify 0.2.0/);
});

test('an install with code commits of its own is not updated automatically and says how', () => {
  const { up, install, old } = setup();
  writeFileSync(join(install, 'tools', 'mine.mjs'), 'export const mine = 1;\n');
  git(install, 'add', 'memory/user_note.md', 'tools/mine.mjs');
  git(install, 'commit', '-q', '-m', 'my memories and a tool');
  const mineHead = git(install, 'rev-parse', 'HEAD');
  release(up, '0.2.0');
  const r = runUpdate({ brain: install, url: up, env: env() });
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.match(r.reason, /commits of its own/);
  assert.notEqual(mineHead, old);
  assert.equal(git(install, 'rev-parse', 'HEAD'), mineHead);
});

test('turned off, automatic runs do nothing and touch no network; a run by hand still works', () => {
  const { up, install, old } = setup();
  release(up, '0.2.0');
  writeFileSync(join(install, 'brain.json'), JSON.stringify({ autoUpdate: false }));
  assert.equal(settings(install, env()).mode, 'off');
  const nowhere = join(tmpdir(), 'no-such-upstream-' + process.pid);
  assert.equal(runUpdate({ brain: install, url: nowhere, mode: 'auto', env: env() }).status, 'off');
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
  rmSync(join(install, 'brain.json'));
  assert.equal(runUpdate({ brain: install, url: nowhere, mode: 'auto', env: { ...env(), INFINITE_CONTEXT_AUTO_UPDATE: '0' } }).status, 'off');
  writeFileSync(join(install, 'brain.json'), JSON.stringify({ autoUpdate: false }));
  assert.equal(runUpdate({ brain: install, url: up, mode: 'now', env: env() }).status, 'updated', 'the setting governs automatic runs only');
});

test('notify mode says a release is out and installs nothing', () => {
  const { up, install, old } = setup();
  release(up, '0.2.0');
  writeFileSync(join(install, 'brain.json'), JSON.stringify({ autoUpdate: 'notify' }));
  const r = runUpdate({ brain: install, url: up, mode: 'auto', env: env() });
  assert.equal(r.status, 'available', JSON.stringify(r));
  assert.equal(r.to, '0.2.0');
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
  const line = updateNotice(install, { env: env(), start: () => {} });
  assert.match(line, /0\.2\.0/);
  assert.match(line, /node tools\/update\.mjs/);
  assert.equal(runUpdate({ brain: install, url: up, mode: 'auto', env: env() }).status, 'available');
  assert.equal(updateNotice(install, { env: env(), start: () => {} }), '', 'the same release is announced once');
});

test('the recall hook starts a check at most once a day, never when off, never from inside an update', () => {
  const { install } = setup();
  let starts = 0;
  const start = () => { starts += 1; };
  const t0 = Date.parse('2026-11-02T08:00:00Z');
  updateNotice(install, { now: t0, env: env(), start });
  assert.equal(starts, 1);
  updateNotice(install, { now: t0 + 60 * 60 * 1000, env: env(), start });
  assert.equal(starts, 1, 'an hour later: not again');
  updateNotice(install, { now: t0 + 25 * 60 * 60 * 1000, env: env(), start });
  assert.equal(starts, 2, 'the next day: again');
  updateNotice(install, { now: t0 + 50 * 60 * 60 * 1000, env: { ...env(), INFINITE_CONTEXT_UPDATING: '1' }, start });
  assert.equal(starts, 2);
  writeFileSync(join(install, 'brain.json'), JSON.stringify({ autoUpdate: false }));
  updateNotice(install, { now: t0 + 75 * 60 * 60 * 1000, env: env(), start });
  assert.equal(starts, 2);
});

test('an update is reported once, in one line, with what changed', () => {
  const { up, install } = setup();
  release(up, '0.2.0', { kitBody: 'Version two.' });
  assert.equal(runUpdate({ brain: install, url: up, mode: 'auto', env: env() }).status, 'updated');
  const line = updateNotice(install, { env: env(), start: () => {} });
  assert.ok(line && !line.includes('\n'), 'one line');
  assert.match(line, /0\.1\.0 to 0\.2\.0/);
  assert.match(line, /Release 0\.2\.0 change/);
  assert.match(line, /1 refreshed/);
  assert.equal(updateNotice(install, { env: env(), start: () => {} }), '');
  assert.equal(state(install).last.reported, true);
});

test('not an Infinite Context install, or not a git clone: no update, and at most one notice', () => {
  const { up, install } = setup({ first: { name: 'someone-elses-brain' } });
  release(up, '0.2.0', { name: 'someone-elses-brain' });
  let starts = 0;
  assert.equal(runUpdate({ brain: install, url: up, env: env() }).status, 'not-infinite-context');
  assert.equal(updateNotice(install, { env: env(), start: () => { starts += 1; } }), '');
  assert.equal(starts, 0);

  const plain = setup();
  release(plain.up, '0.2.0');
  const copy = join(temp('ic-copy-'), 'brain');
  cpSync(plain.install, copy, { recursive: true, filter: (s) => !/[\\/]\.git([\\/]|$)/.test(s) });
  const r = runUpdate({ brain: copy, url: plain.up, mode: 'auto', env: env() });
  assert.equal(r.status, 'no-git', JSON.stringify(r));
  assert.match(updateNotice(copy, { env: env(), start: () => {} }), /git clone/);
  runUpdate({ brain: copy, url: plain.up, mode: 'auto', env: env() });
  assert.equal(updateNotice(copy, { env: env(), start: () => {} }), '', 'said once, not every day');
});

test('a second update while one is running waits its turn', () => {
  const { up, install, old } = setup();
  release(up, '0.2.0');
  writeFileSync(join(install, '.update.lock'), JSON.stringify({ pid: 1, at: Date.now() }));
  assert.equal(runUpdate({ brain: install, url: up, env: env() }).status, 'busy');
  assert.equal(git(install, 'rev-parse', 'HEAD'), old);
  const stale = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(join(install, '.update.lock'), stale, stale);
  assert.equal(runUpdate({ brain: install, url: up, env: env() }).status, 'updated', 'a lock left by a crash two hours ago does not block');
  assert.ok(!existsSync(join(install, '.update.lock')));
});

test('the small parts: release notes, verify failures, dependency changes', () => {
  const log = '# Changelog\n\n## 0.4.60\n\n- **Kit updates.** Detail.\n- **Auto update.** Detail.\n\n## 0.4.52\n\n- **Helpers share the brain.** Detail.\n\n## 0.4.10\n\n- **Old.** Detail.\n';
  assert.equal(changesBetween(log, '0.4.10', '0.4.60'), 'Kit updates; Auto update; Helpers share the brain');
  assert.equal(changesBetween(log, '0.4.52', '0.4.60'), 'Kit updates; Auto update');
  const kinds = failureKinds('  ok    parse x\n  FAIL  reflection has 3 finding(s), run: node tools/reflect.mjs\n  FAIL  parse hooks/a.mjs -> SyntaxError: x\n');
  assert.deepEqual([...kinds].sort(), ['parse hooks/a.mjs', 'reflection has # finding(s), run']);
  assert.ok(failureKinds('  FAIL  reflection has 5 finding(s), run: node tools/reflect.mjs').has('reflection has # finding(s), run'));
  assert.equal(dependenciesChanged('{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"1"},"version":"2"}'), false);
  assert.equal(dependenciesChanged('{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"2"}}'), true);
});
