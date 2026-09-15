#!/usr/bin/env node
// Make a git pull possible on a machine whose working tree the mirror also writes to.
//
// The wedge, found by a laptop client on 2026-09-05 and hit four more times on 2026-09-06: the mirror
// delivers a new tool as an UNTRACKED file, the next commit on the remote adds that same path, and
// git refuses to pull over an untracked file even when the bytes are identical. Fixing them one at
// a time means one abort per file. With the git timer gone, the only pull left on a client machine
// runs at session start, so the wedge became invisible: the pull fails quietly, the local memory
// copy goes stale, and recall keeps working from the server so nothing looks wrong.
//
// This does, automatically and safely, what the five-step manual recovery did:
//   1. fetch, and list every path the incoming commits touch
//   2. an UNTRACKED local file at such a path is moved to .sync-trash/<time>/, never deleted
//   3. a TRACKED local file that is modified AND incoming is restored from the remote ONLY if its
//      content is identical to what the remote holds (line endings ignored). If it differs, it is
//      left alone and named, because discarding it could destroy work. That identity check is the
//      whole safety of this tool.
//
//   node tools/unwedge-pull.mjs [--dir <repo>] [--remote origin]
//
// Exit 0 always. It prepares the pull; the pull itself decides. Called by check-session-start.mjs
// before its pull, and safe to run by hand.

import { existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const DIR = resolve(opt('dir', resolve(dirname(fileURLToPath(import.meta.url)), '..')));
const REMOTE = opt('remote', 'origin');
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const say = (s) => process.stdout.write(s + NL);

function git(args, opts = {}) {
  return execFileSync('git', ['-C', DIR, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], ...opts });
}
function gitOk(args) { try { git(args); return true; } catch { return false; } }
const norm = (t) => String(t).split(CR + NL).join(NL);

try {
  if (!existsSync(join(DIR, '.git'))) { say('unwedge: no .git at ' + DIR + ', nothing to do'); process.exit(0); }
  if (!gitOk(['fetch', '--quiet', REMOTE])) { say('unwedge: fetch failed, leaving the tree alone'); process.exit(0); }

  // The branch the pull will merge: the remote's HEAD, falling back to the current branch's upstream.
  let ref = '';
  try { ref = git(['symbolic-ref', '-q', '--short', 'refs/remotes/' + REMOTE + '/HEAD']).trim(); } catch { /* none */ }
  if (!ref) { try { ref = git(['rev-parse', '--abbrev-ref', '@{upstream}']).trim(); } catch { /* none */ } }
  if (!ref) { const b = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); ref = REMOTE + '/' + b; }

  const incoming = git(['diff', '--name-only', 'HEAD..' + ref]).split(NL).map((s) => s.trim()).filter(Boolean);
  if (!incoming.length) { say('unwedge: nothing incoming from ' + ref); process.exit(0); }

  const stamp = new Date().toISOString().split(':').join('-').split('.').join('-');
  const trash = join(DIR, '.sync-trash', stamp);
  let moved = 0;
  let restored = 0;
  const kept = [];

  for (const rel of incoming) {
    const abs = join(DIR, rel);
    if (!existsSync(abs)) continue;
    const tracked = gitOk(['ls-files', '--error-unmatch', '--', rel]);
    if (!tracked) {
      // The mirror wrote it, the remote now adds it. Move aside; the mirror rewrites it next minute.
      const dest = join(trash, rel);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(abs, dest);
      moved += 1;
      continue;
    }
    const modified = !gitOk(['diff', '--quiet', '--', rel]);
    if (!modified) continue;
    // Tracked, modified, and incoming. Restore ONLY if the local bytes are what the remote holds.
    let remote = null;
    try { remote = git(['show', ref + ':' + rel]); } catch { remote = null; }
    let local = null;
    try { local = readFileSync(abs, 'utf8'); } catch { local = null; }
    if (remote !== null && local !== null && norm(remote) === norm(local)) {
      if (gitOk(['checkout', '--', rel])) restored += 1; else kept.push(rel);
    } else {
      kept.push(rel);
    }
  }

  say('unwedge: ' + incoming.length + ' incoming path(s), moved ' + moved + ' untracked to .sync-trash, restored ' + restored + ' identical, kept ' + kept.length + ' that differ');
  for (const k of kept) say('  kept, differs from the remote, pull may stop on it: ' + k);
} catch (e) {
  say('unwedge: ' + String(e.message).split(NL)[0].slice(0, 160));
}
process.exit(0);
