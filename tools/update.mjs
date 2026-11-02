#!/usr/bin/env node
// Updates an install of the public repository to the newest release, by itself, safely.
//
// The owner, 2026-11-02: "add an update to the brain in case there is a new published version in our GitHub, for the
// people that use our repo, they receive updates automatically." The rules it follows:
//   - Only a release: a tag vX.Y.Z whose commit is on main. Never another branch, never an untagged commit.
//   - No timer. The recall hook (hooks/pre-turn.mjs) starts this in the background when the brain is already working,
//     at most once a day, and the result is reported once, in one line, on a later turn.
//   - One network call a day: git ls-remote, which is git's own protocol, not GitHub's REST API, so the
//     unauthenticated limit of 60 API calls an hour never applies; the objects are fetched only when a release is new.
//   - Your memories are never touched: memory/ is not part of the engine, and a release that would put a file in
//     memory/, or overwrite any file you have (even an ignored one such as brain.json), is refused. Kit methods are
//     refreshed by tools/kit.mjs, which never overwrites one you changed.
//   - Verify before and after. A failure the install did not already have rolls the update back; a failure that only
//     appears with the new kit methods takes those back out and keeps the engine update.
//   - It can be turned off: brain.json {"autoUpdate": false}, or "notify" to be told and install by hand, or the
//     environment variable INFINITE_CONTEXT_AUTO_UPDATE=0. A run by hand works whatever the setting.
//
//   node tools/update.mjs              install the newest release now, if there is one
//   node tools/update.mjs --check      only say whether a newer release is out
//   node tools/update.mjs --status     the setting, the last check and what it found
//   node tools/update.mjs --off | --on | --notify   automatic updates off, on (the default), or tell only
//   node tools/update.mjs --auto       what the recall hook starts in the background

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, closeSync, appendFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { STATE_FILE as KIT_STATE, WAIT_DIR as KIT_WAIT, summary as kitSummary } from './kit.mjs';

export const STATE = '.update-state.json';
export const LOCK = '.update.lock';
export const LOG = '.update.log';
const CHANNEL = 'main';
const NS = 'refs/infinite-context';
const DAY_MS = 24 * 60 * 60 * 1000;
// A lock older than this was left by a crash; a real update takes minutes.
const LOCK_STALE_MS = 60 * 60 * 1000;
const NET_MS = 120000;
const STEP_MS = 300000;
const NPM_MS = 600000;
const LOG_MAX_BYTES = 200 * 1024;
// Brain data, not code: what tools/save-brain.mjs commits in an install.
const BRAIN_DATA = /^(memory|index|provenance)\/|^MANIFEST\.md$/;
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const listOf = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const firstLine = (e) => oneLine(String((e && (e.stderr || e.message)) || e).split(/\r?\n/).find((l) => l.trim()) || 'unknown error');

export const isInfiniteContext = (brain) => readJson(join(brain, 'package.json'), {}).name === 'infinite-context';

const parseVersion = (v) => { const m = String(v || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/); return m ? m.slice(1).map(Number) : null; };
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The setting: the environment variable wins over brain.json, and the default is to install.
export function settings(brain, env = process.env) {
  const e = String(env.INFINITE_CONTEXT_AUTO_UPDATE || '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(e)) return { mode: 'off', source: 'INFINITE_CONTEXT_AUTO_UPDATE' };
  if (e === 'notify') return { mode: 'notify', source: 'INFINITE_CONTEXT_AUTO_UPDATE' };
  if (['1', 'on', 'true', 'yes'].includes(e)) return { mode: 'install', source: 'INFINITE_CONTEXT_AUTO_UPDATE' };
  const v = readJson(join(brain, 'brain.json'), {}).autoUpdate;
  if (v === false || v === 'off') return { mode: 'off', source: 'brain.json' };
  if (v === 'notify') return { mode: 'notify', source: 'brain.json' };
  return { mode: 'install', source: v === undefined ? 'default' : 'brain.json' };
}

function upstreamUrl(brain) {
  const r = readJson(join(brain, 'package.json'), {}).repository;
  const url = typeof r === 'string' ? r : r && r.url;
  return url ? String(url).replace(/^git\+/, '') : '';
}

// The release notes of every version after `from` up to `to`: the bold lead of each bullet, in one line.
export function changesBetween(text, from, to) {
  const out = [];
  let take = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const h = raw.match(/^##\s+v?(\d+\.\d+\.\d+)\s*$/);
    if (h) { take = compareVersions(h[1], from) > 0 && compareVersions(h[1], to) <= 0; continue; }
    if (!take) continue;
    const b = raw.match(/^\s*[-*]\s+\*\*(.+?)\*\*/);
    if (b) out.push(b[1].replace(/[.:]\s*$/, '').trim());
  }
  const s = out.join('; ');
  return s.length > 300 ? s.slice(0, 297).replace(/\s+\S*$/, '') + '...' : s;
}

// What kind of failure a verify FAIL line is, with its counts and details removed, so the same problem before and
// after an update compares equal ("reflection has 3 finding(s)" and "has 5" are one kind).
const kindOf = (msg) => msg.split(/:| -> /)[0].replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
export function failureKinds(output) {
  const kinds = new Set();
  for (const l of String(output || '').split(/\r?\n/)) {
    const m = l.match(/^\s*FAIL\s+(.+)$/);
    if (m) kinds.add(kindOf(m[1]));
  }
  return kinds;
}

export function dependenciesChanged(oldPkg, newPkg) {
  const deps = (t) => { const p = (() => { try { return JSON.parse(t); } catch { return {}; } })(); return JSON.stringify([p.dependencies || {}, p.optionalDependencies || {}]); };
  return deps(oldPkg) !== deps(newPkg);
}

// ---- the parts that run commands --------------------------------------------------------------------
// Children get the brain they belong to and the marker that they run inside an update (the recall hook that verify
// runs end to end must not start another update), and git can never stop to ask for a password.
const childEnv = (brain, env) => ({ ...env, INFINITE_CONTEXT_UPDATING: '1', HAVOK_BRAIN: brain, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
const gitIn = (brain, env) => (args, timeout = 60000) => execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.quotePath=false', ...args], {
  cwd: brain, env, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function runNode(brain, env, script, args = []) {
  const p = join(brain, 'tools', script);
  if (!existsSync(p)) return { ok: true, out: '', missing: true };
  const r = spawnSync(process.execPath, [p, ...args], { cwd: brain, env, encoding: 'utf8', timeout: STEP_MS, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '') + '\n' + (r.stderr || ''), status: r.status, error: r.error };
}

function verify(brain, env) {
  const r = runNode(brain, env, 'verify.mjs');
  if (r.missing) return { kinds: new Set(), lines: [] };
  const kinds = failureKinds(r.out);
  const lines = listOf(r.out).filter((l) => /^FAIL\s+/.test(l)).map((l) => l.replace(/^FAIL\s+/, ''));
  if (!r.ok && !kinds.size) {
    kinds.add('verify did not finish');
    lines.push('verify did not finish (' + (r.error ? r.error.message : 'exit ' + r.status) + ')');
  }
  return { kinds, lines };
}
// The first failure of a kind the earlier run did not have, in words.
const newFailure = (before, after) => after.lines.find((l) => !before.kinds.has(kindOf(l))) || [...after.kinds].find((k) => !before.kinds.has(k));

function npmInstall(brain, env) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--silent'], {
    cwd: brain, env, encoding: 'utf8', timeout: NPM_MS, windowsHide: true, shell: process.platform === 'win32',
  });
  return r.status === 0;
}

// The kit's footprint in this brain before the update: the copies in memory/ of every kit method of either version,
// the kit state and what waits in kit-updates/. Restored as it was if the update is taken back.
function snapshot(brain, names) {
  const files = new Map();
  for (const n of names) files.set(join('memory', n), null);
  files.set(KIT_STATE, null);
  const walk = (rel) => { let list = []; try { list = readdirSync(join(brain, rel)); } catch { return; } for (const n of list) { const r = join(rel, n); if (statSync(join(brain, r)).isDirectory()) walk(r); else files.set(r, null); } };
  walk(KIT_WAIT);
  for (const rel of files.keys()) { try { files.set(rel, readFileSync(join(brain, rel))); } catch { /* did not exist */ } }
  return files;
}
function restore(brain, snap) {
  const walk = (rel) => { let list = []; try { list = readdirSync(join(brain, rel)); } catch { return; } for (const n of list) { const r = join(rel, n); if (statSync(join(brain, r)).isDirectory()) walk(r); else if (!snap.has(r)) unlinkSync(join(brain, r)); } };
  walk(KIT_WAIT);
  for (const [rel, content] of snap) {
    const p = join(brain, rel);
    if (content === null) { if (existsSync(p)) unlinkSync(p); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

function takeLock(brain) {
  const p = join(brain, LOCK);
  try { if (existsSync(p) && Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS) unlinkSync(p); } catch { /* raced, fine */ }
  try {
    const fd = openSync(p, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch { return false; }
}

function logger(brain) {
  const p = join(brain, LOG);
  try { if (existsSync(p) && statSync(p).size > LOG_MAX_BYTES) writeFileSync(p, readFileSync(p, 'utf8').slice(-LOG_MAX_BYTES / 2)); } catch { /* a log is a help */ }
  return (msg) => { try { appendFileSync(p, new Date().toISOString() + ' ' + oneLine(msg) + '\n'); } catch { /* a log is a help */ } };
}

const samePath = (a, b) => {
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const x = resolve(real(a));
  const y = resolve(real(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// ---- the update ------------------------------------------------------------------------------------
// Which results are worth a line to the person, and only once: a blocked or announced release once per version, a
// clone that cannot update itself once ever. A failed network check is silent; tomorrow's check tries again.
const ONCE = new Set(['blocked', 'available', 'no-git']);
const onceKey = (res) => (res.status === 'no-git' ? 'no-git' : res.status + ' ' + res.to);

export function runUpdate(opts = {}) {
  const brain = resolve(opts.brain || SELF);
  const env = opts.env || process.env;
  const now = opts.now ?? Date.now();
  const mode = opts.mode || 'now';
  // Never a file written in a brain that is not an install of the public repository (the source brain the engine is exported from is not one).
  if (!isInfiniteContext(brain)) return { status: 'not-infinite-context' };
  if (mode === 'auto' && settings(brain, env).mode === 'off') return { status: 'off' };
  const url = opts.url || env.INFINITE_CONTEXT_UPDATE_URL || upstreamUrl(brain);
  if (!takeLock(brain)) return { status: 'busy' };
  const log = logger(brain);
  try {
    const res = update({ brain, env, mode, url, log });
    log('result ' + res.status + (res.to ? ' ' + res.from + ' to ' + res.to : '') + (res.reason ? ': ' + res.reason : ''));
    const st = readJson(join(brain, STATE), {}) || {};
    let report = mode === 'auto' && ['updated', 'rolled-back', 'failed', ...ONCE].includes(res.status);
    if (report && ONCE.has(res.status)) {
      if (st.notified === onceKey(res)) report = false;
      else st.notified = onceKey(res);
    }
    if (res.status !== 'off') st.lastCheck = new Date(now).toISOString();
    st.last = { ...res, at: new Date(now).toISOString(), reported: !report };
    try { writeJson(join(brain, STATE), st); } catch { /* the result still returns */ }
    return res;
  } finally {
    try { unlinkSync(join(brain, LOCK)); } catch { /* already gone */ }
  }
}

function update({ brain, env, mode, url, log }) {
  const cenv = childEnv(brain, env);
  const git = gitIn(brain, cenv);
  const ok = (args) => { try { git(args); return true; } catch { return false; } };
  const from = readJson(join(brain, 'package.json'), {}).version || '0.0.0';
  if (!url) return { status: 'no-source', from, reason: 'package.json names no repository to update from' };
  let top = '';
  try { top = git(['rev-parse', '--show-toplevel']); } catch { /* not a clone, or no git */ }
  if (!top || !samePath(top, brain)) return { status: 'no-git', from, reason: 'this install is not a git clone of the repository' };

  // 1. Which releases exist: one small request.
  let head = null;
  const tags = [];
  try {
    for (const line of listOf(git(['ls-remote', '--refs', url, 'refs/heads/' + CHANNEL, 'refs/tags/v*'], NET_MS))) {
      const [sha, ref] = line.split(/\s+/);
      if (ref === 'refs/heads/' + CHANNEL) head = sha;
      const m = String(ref || '').match(/^refs\/tags\/(v\d+\.\d+\.\d+)$/);
      if (m) tags.push({ tag: m[1], version: m[1].slice(1) });
    }
  } catch (e) { return { status: 'error', from, reason: 'could not reach ' + url + ': ' + firstLine(e) }; }
  const newer = tags.filter((t) => compareVersions(t.version, from) > 0).sort((a, b) => compareVersions(b.version, a.version));
  if (!head || !newer.length) return { status: 'current', from };

  // 2. Fetch them, into a namespace of our own, and keep the newest one that is on main.
  try {
    git(['fetch', '--no-tags', '--quiet', url, '+refs/heads/' + CHANNEL + ':' + NS + '/' + CHANNEL, ...newer.map((t) => '+refs/tags/' + t.tag + ':' + NS + '/tags/' + t.tag)], NET_MS);
  } catch (e) { return { status: 'error', from, reason: 'could not fetch the release: ' + firstLine(e) }; }
  const target = newer.find((t) => ok(['merge-base', '--is-ancestor', NS + '/tags/' + t.tag + '^{commit}', NS + '/' + CHANNEL]));
  if (!target) return { status: 'current', from, reason: 'no release on ' + CHANNEL + ' is newer than ' + from };
  const to = target.version;
  const T = git(['rev-parse', NS + '/tags/' + target.tag + '^{commit}']);
  let notes = '';
  try { notes = changesBetween(git(['show', T + ':CHANGELOG.md']), from, to); } catch { /* no changelog */ }
  log('release ' + to + ' found, this install is at ' + from);
  if (mode === 'check' || (mode === 'auto' && settings(brain, env).mode === 'notify')) return { status: 'available', from, to, summary: notes };

  // 3. Refuse anything that could lose a file of the user's.
  const blocked = (reason) => ({ status: 'blocked', from, to, reason });
  const oldSha = git(['rev-parse', 'HEAD']);
  if (!ok(['diff', '--cached', '--quiet'])) return blocked('changes are staged in git here; commit or unstage them, then run node tools/update.mjs');
  // Commits of the install's own that only hold brain data (memories saved by tools/save-brain.mjs) are merged with the
  // release; any other own commit blocks, as before (2026-11-02, tools/update.test.mjs).
  let base = oldSha;
  let mergeMemories = false;
  if (!ok(['merge-base', '--is-ancestor', 'HEAD', T])) {
    try { base = git(['merge-base', 'HEAD', T]); } catch { base = ''; }
    const own = base ? listOf(git(['diff', '--name-only', '--no-renames', base, 'HEAD'])) : ['?'];
    if (own.some((f) => !BRAIN_DATA.test(f))) return blocked('this install has commits of its own, so it cannot move to the release without a merge; to update by hand: git pull ' + url + ' ' + CHANNEL + ', then node tools/verify.mjs');
    mergeMemories = true;
  }
  const releaseChanges = listOf(git(['diff', '--name-only', base, T]));
  const clash = listOf(git(['diff', '--name-only'])).filter((f) => releaseChanges.includes(f));
  if (clash.length) return blocked('you changed ' + clash.slice(0, 3).join(', ') + (clash.length > 3 ? ' and ' + (clash.length - 3) + ' more' : '') + ', which this release also changes; put yours aside (git stash), then run node tools/update.mjs');
  const memories = listOf(git(['ls-tree', '-r', '--name-only', T, '--', 'memory/'])).filter((f) => f !== 'memory/.gitkeep');
  if (memories.length) return blocked('the release would put files into memory/ (' + memories.slice(0, 3).join(', ') + '), which only ever holds your own memories');
  const taken = listOf(git(['diff', '--name-only', '--diff-filter=A', base, T])).filter((f) => existsSync(join(brain, f)));
  if (taken.length) return blocked('the release adds ' + taken.slice(0, 3).join(', ') + ', which already exists here as your own file; move it aside, then run node tools/update.mjs');

  // 4. Verify as it is now, so only a failure the update brings counts against it.
  const before = verify(brain, cenv);
  const kitNames = new Set([oldSha, T].flatMap((c) => { try { return listOf(git(['ls-tree', '--name-only', c, 'kit/memory/'])); } catch { return []; } })
    .map((p) => p.split('/').pop()).filter((n) => n.endsWith('.md')));
  const snap = snapshot(brain, kitNames);
  let branch = '';
  try { branch = git(['symbolic-ref', '-q', '--short', 'HEAD']); } catch { /* detached */ }

  // 5. Move to the release. A fast-forward, or a merge when the install's own commits only hold its memories: nothing
  // of the install's own is rewritten.
  try {
    if (mergeMemories) {
      const who = ok(['config', 'user.email']) ? [] : ['-c', 'user.name=Infinite Context update', '-c', 'user.email=update@infinite-context.invalid'];
      git([...who, 'merge', '--no-edit', '--quiet', T], STEP_MS);
    } else if (branch) git(['merge', '--ff-only', '--quiet', T], STEP_MS);
    else git(['checkout', '--quiet', '--detach', T], STEP_MS);
  } catch (e) { return blocked('git refused to move to the release: ' + firstLine(e)); }
  log('moved ' + (branch || 'HEAD') + ' from ' + oldSha.slice(0, 10) + ' to ' + T.slice(0, 10));
  let deps = false;
  try { deps = dependenciesChanged(git(['show', oldSha + ':package.json']), git(['show', T + ':package.json'])); } catch { /* no package.json */ }

  const rollback = (reason) => {
    log('rolling back: ' + reason);
    restore(brain, snap);
    try {
      if (branch) git(['reset', '--keep', '--quiet', oldSha], STEP_MS);
      else git(['checkout', '--quiet', '--detach', oldSha], STEP_MS);
    } catch (e) {
      return { status: 'failed', from, to, reason: reason + '; going back failed too (' + firstLine(e) + '), to go back by hand: git reset --keep ' + oldSha };
    }
    if (deps) npmInstall(brain, cenv);
    runNode(brain, cenv, 'build-index.mjs');
    return { status: 'rolled-back', from, to, reason };
  };

  if (deps && !npmInstall(brain, cenv)) return rollback('npm install of the new dependencies failed');
  runNode(brain, cenv, 'build-index.mjs');
  const after = verify(brain, cenv);
  const broke = newFailure(before, after);
  if (broke) return rollback('verify failed after the update: ' + oneLine(broke));

  // 6. The kit, as its own step: a problem that only comes with the new kit methods takes them back out and keeps
  // the engine update, so an install is never held on old code by one method.
  let kit = '';
  let kitNote = '';
  const k = runNode(brain, cenv, 'kit.mjs', ['refresh', '--json', '--no-index']);
  if (!k.missing) {
    let report = null;
    try { report = JSON.parse(listOf(k.out).filter((l) => l.startsWith('{')).pop()); } catch { /* not JSON */ }
    runNode(brain, cenv, 'build-index.mjs');
    const withKit = verify(brain, cenv);
    const kitBroke = newFailure(after, withKit);
    if (kitBroke || !report) {
      restore(brain, snap);
      runNode(brain, cenv, 'build-index.mjs');
      kitNote = 'kit methods were taken back out because ' + (kitBroke ? 'verify failed with them: ' + oneLine(kitBroke) : 'the kit refresh did not finish');
    } else {
      kit = kitSummary(report);
    }
  }
  return { status: 'updated', from, to, summary: notes, kit, kitNote };
}

// ---- what the recall hook calls -------------------------------------------------------------------------
export function noticeFor(last) {
  const tell = ' Tell the person this in one line.';
  const what = last.summary ? ' What changed: ' + last.summary + '.' : '';
  switch (last.status) {
    case 'updated':
      return 'INFINITE CONTEXT UPDATE: it updated itself from ' + last.from + ' to ' + last.to + ' and its checks passed.' + what
        + (last.kit ? ' ' + capital(last.kit) + '.' : '') + (last.kitNote ? ' ' + capital(last.kitNote) + '.' : '') + tell;
    case 'rolled-back':
      return 'INFINITE CONTEXT UPDATE: it tried to update from ' + last.from + ' to ' + last.to + ', but its checks failed afterwards ('
        + last.reason + '), so it went back to ' + last.from + ' and nothing of the person was changed. To try again and see why: node tools/update.mjs.' + tell;
    case 'failed':
      return 'INFINITE CONTEXT UPDATE: the update to ' + last.to + ' failed and could not go back on its own: ' + last.reason + '.' + tell;
    case 'blocked':
      return 'INFINITE CONTEXT UPDATE: version ' + last.to + ' is out (this install has ' + last.from + ') but was not installed automatically: ' + last.reason + '.' + tell;
    case 'available':
      return 'INFINITE CONTEXT UPDATE: version ' + last.to + ' is out (this install has ' + last.from + ').' + what
        + ' Updates are set to notify only; to install it: node tools/update.mjs.' + tell;
    case 'no-git':
      return 'INFINITE CONTEXT UPDATE: automatic updates need a git clone of the repository and this install is not one, so it will not update itself; reinstall from a git clone to get updates.' + tell;
    default:
      return '';
  }
}

function startBackground(brain, env) {
  const child = spawn(process.execPath, [join(brain, 'tools', 'update.mjs'), '--auto'], { cwd: brain, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* tomorrow's turn tries again */ });
  child.unref();
}

// Called on every turn by the recall hook. Cheap: one small file read. Returns the line to show, once, for the last
// result worth telling, and starts a background check when the last one is a day old. Never throws.
export function updateNotice(brain = SELF, { now = Date.now(), env = process.env, start = startBackground } = {}) {
  try {
    if (env.INFINITE_CONTEXT_UPDATING) return '';
    if (!isInfiniteContext(brain)) return '';
    const st = readJson(join(brain, STATE), {}) || {};
    let line = '';
    if (st.last && st.last.reported === false) { line = oneLine(noticeFor(st.last)); st.last.reported = true; }
    const last = Math.max(Date.parse(st.lastCheck || '') || 0, Date.parse(st.lastStart || '') || 0);
    const due = settings(brain, env).mode !== 'off' && now - last >= DAY_MS;
    if (due) st.lastStart = new Date(now).toISOString();
    if (line || due) writeJson(join(brain, STATE), st);
    if (due) start(brain, env);
    return line;
  } catch { return ''; }
}

// ---- command line ------------------------------------------------------------------------------------
function describe(r) {
  switch (r.status) {
    case 'updated': return 'updated from ' + r.from + ' to ' + r.to + ', checks passed.' + (r.summary ? ' What changed: ' + r.summary + '.' : '') + (r.kit ? ' ' + capital(r.kit) + '.' : '') + (r.kitNote ? ' ' + capital(r.kitNote) + '.' : '');
    case 'current': return 'up to date at ' + r.from + (r.reason ? ' (' + r.reason + ')' : '');
    case 'available': return 'version ' + r.to + ' is out, this install has ' + r.from + '.' + (r.summary ? ' What changed: ' + r.summary + '.' : '') + ' To install it: node tools/update.mjs';
    case 'rolled-back': return 'not updated: ' + r.reason + '. Went back to ' + r.from + '.';
    case 'blocked': return 'not updated to ' + r.to + ': ' + r.reason;
    case 'busy': return 'another update is running; try again in a few minutes';
    case 'off': return 'automatic updates are off';
    case 'not-infinite-context': return 'this brain is not an install of the public repository (package.json does not name infinite-context), so it is not updated from there';
    default: return r.status + (r.reason ? ': ' + r.reason : '');
  }
}

function setSetting(brain, value) {
  const p = join(brain, 'brain.json');
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { throw new Error('brain.json is not valid JSON, so it was left alone; fix it first'); }
  }
  cfg.autoUpdate = value;
  writeJson(p, cfg);
}

function main(argv) {
  const say = (s) => process.stdout.write(s + '\n');
  const has = (f) => argv.includes(f);
  if (has('--off') || has('--on') || has('--notify')) {
    const value = has('--off') ? false : has('--notify') ? 'notify' : true;
    setSetting(SELF, value);
    say('automatic updates: ' + (value === false ? 'off' : value === 'notify' ? 'notify only, install by hand with node tools/update.mjs' : 'on'));
    return;
  }
  if (has('--status')) {
    const s = settings(SELF);
    const st = readJson(join(SELF, STATE), {}) || {};
    say('automatic updates : ' + { install: 'on', notify: 'notify only', off: 'off' }[s.mode] + ' (' + s.source + ')');
    say('this install      : ' + (readJson(join(SELF, 'package.json'), {}).version || 'unknown'));
    say('last check        : ' + (st.lastCheck || 'never'));
    if (st.last) say('last result       : ' + describe(st.last));
    return;
  }
  const mode = has('--auto') ? 'auto' : has('--check') ? 'check' : 'now';
  const r = runUpdate({ brain: SELF, mode });
  if (mode !== 'auto') say(describe(r));
  process.exit(['failed', 'error'].includes(r.status) ? 1 : 0);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === here.toLowerCase() : invoked === here)) main(process.argv.slice(2));
