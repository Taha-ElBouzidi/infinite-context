#!/usr/bin/env node
// Save the brain in the background: reindex, verify, commit and push, without making anyone wait.
//
// The owner, 2026-09-17: "that call should be in the back end, no need to block us, and this should be the
// standard for all agent brain functionalities, it should be in the background, it shouldn't affect
// the flow of the conversation."
//
// An agent used to write a memory and then sit through build-index, verify and a commit hook, 20 to 60
// seconds of a conversation spent on bookkeeping. Now it writes the file and runs this, which returns
// at once and does the rest in a detached process. Results go to .save-brain.log.
//
//   node tools/save-brain.mjs "commit message"                  memory/, index/, MANIFEST.md
//   node tools/save-brain.mjs "commit message" tools/x.mjs      those paths as well
//   node tools/save-brain.mjs --status                          the last runs
//
// Machines that are not the brain host write through `brain-client.mjs write`, which the server now also
// indexes and backs up in the background.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPriority as osSetPriority, constants as osConstants } from 'node:os';
import { withBrainLockSync } from './brain-git-lock.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.save-brain.log');
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const log = (s) => { try { appendFileSync(LOG, new Date().toISOString() + '  ' + s + NL); } catch { /* the log is a courtesy */ } };

if (argv[0] === '--status') {
  const lines = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split(NL).slice(-12) : ['no runs yet'];
  process.stdout.write(lines.join(NL) + NL);
  process.exit(0);
}

if (argv[0] !== '--worker') {
  const message = argv[0];
  if (!message) { process.stderr.write('usage: node tools/save-brain.mjs "commit message" [paths...]' + NL); process.exit(1); }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...argv], {
    cwd: BRAIN, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  process.stdout.write('saving in the background: index, verify, commit, push. Check with node tools/save-brain.mjs --status' + NL);
  process.exit(0);
}

// ---------------------------------------------------------------- the worker
// BELOW NORMAL PRIORITY, inherited by build-index and build-embeddings. On the brain host a save competes with the
// brain server for the CPU; at normal priority a rebuild slowed recall from other machines to 17 s and
// made secret reads time out (2026-09-28). Background work waits; recall does not.
try { osSetPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here: run at normal */ }
const [, message, ...extra] = argv;
const run = (cmd, args, timeout) => execFileSync(cmd, args, { cwd: BRAIN, timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// git's own index.lock can still be held by something outside the brain write lock (an agent running git by hand).
const OUTSIDE_LOCK_WAIT_MS = 180000;
const why = (e) => (String(e.stdout || '') + String(e.stderr || '') + String(e.message || '')).replace(/\s+/g, ' ');
log('start: ' + message);
let provenance = null;
try { provenance = await import('./provenance.mjs'); } catch (e) { log('provenance skipped: ' + String(e.message).slice(0, 120)); }
let exitCode = 0;
try { exitCode = withBrainLockSync('save-brain: ' + message, saveUnderLock); }
catch (e) { log('FAILED to commit: ' + message + ' | ' + String(e.message).slice(0, 240)); exitCode = 1; }
// After the lock, not under it: reflect only reads and takes about 18 s on the host, which every other writer waited
// through on each save (audit 2026-11-01, tools/save-brain-lock.test.mjs).
if (exitCode === 0) warnIfBrainHasFindings();
process.exit(exitCode);

// Index, commit and push in one turn of the brain write lock (tools/brain-git-lock.mjs), so two saves never collide:
// the second one waits for the first instead of failing on git's index.lock. Returns the exit code.
function saveUnderLock() {
  try { run(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 180000); } catch (e) { log('build-index failed: ' + String(e.stderr || e.message).split(NL)[0].slice(0, 160)); }
  // Who wrote what (tools/provenance.mjs): every memory file this save is about to commit gets a ledger line. The
  // worker inherits the agent's environment, so it sees the same session as the agent that ran the save. In a shared
  // folder another session's unsaved edits are swept in too; they are stamped with this writer, marked via save-brain.
  if (provenance) {
    try {
      const st = run('git', ['status', '--porcelain', '--', 'memory/'], 30000).split(NL).filter(Boolean);
      const entries = st.map((l) => ({ code: l.slice(0, 2), file: l.slice(3).trim().replace(/^"|"$/g, '') }))
        .filter((x) => /\.md$/.test(x.file) && !/MEMORY\.md$/.test(x.file))
        .map((x) => ({ slug: x.file.split('/').pop().replace(/\.md$/, ''), action: /D/.test(x.code) ? 'delete' : /\?|A/.test(x.code) ? 'new' : 'update' }));
      if (entries.length) provenance.record(entries, provenance.whoAmI(), 'save-brain');
    } catch (e) { log('provenance skipped: ' + String(e.message).slice(0, 120)); }
  }
  const outsideUntil = Date.now() + OUTSIDE_LOCK_WAIT_MS;
  let drift = 0;
  // An install ignores index/ and MANIFEST.md, and git add refuses a named path that is ignored, so every save there
  // failed before it committed (2026-11-02, tools/save-brain-push.test.mjs). Ignored or missing paths are left out.
  const notIgnored = (p) => { try { run('git', ['check-ignore', '-q', '--', p], 30000); return false; } catch { return true; } };
  const paths = [...['memory/', 'index/', 'MANIFEST.md', 'provenance/'].filter((p) => existsSync(join(BRAIN, p))), ...extra].filter(notIgnored);
  for (let attempt = 1; ; attempt += 1) {
    try {
      run('git', ['add', ...paths], 60000);
      // Only what this save added: the folder is shared, and a plain commit sweeps in another session's staged code.
      run('git', ['commit', '-q', '-m', message, '--', ...paths], 240000);
      break;
    } catch (e) {
      const w = why(e);
      // Someone else's commit may already have taken these files. The push below still runs.
      if (/nothing to commit|no changes added/i.test(w)) { log('nothing new to commit: ' + message); break; }
      if (/index\.lock|cannot lock ref|Another git process/i.test(w) && Date.now() < outsideUntil) { sleep(Math.min(2000 * attempt, 10000)); continue; }
      // The agent kept writing after this run indexed, which is the whole point of not waiting. Drift
      // from that is healed by indexing again, never reported as a failure. Seen on the first real run.
      if (/index drift/i.test(w) && ++drift < 4) {
        try { run(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 180000); } catch { /* the retry will say */ }
        continue;
      }
      log('FAILED to commit: ' + message + ' | ' + w.slice(0, 240));
      return 1;
    }
  }
  const target = pushTarget();
  if (target.skip) { log('committed, not pushed: ' + target.skip); return 0; }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { run('git', ['push', '-q', target.remote, 'HEAD'], 120000); log('done: ' + message); return 0; }
    catch (e) {
      if (attempt < 3) { sleep(5000 * attempt); continue; }
      log('committed but NOT pushed: ' + message + ' | ' + why(e).slice(0, 240));
      return 1;
    }
  }
  return 1;
}

// A clone of the public repository keeps that repository as origin, so a plain push after a save sent the person's
// memories to the upstream engine, and a public fork as origin would publish them (2026-11-02,
// tools/save-brain-push.test.mjs). In an install (package.json names infinite-context) the save pushes only to the backup
// remote the person names in brain.json ("backupRemote": a remote name or address), never to origin by default. A brain
// that is not an install pushes to origin as before.
function repoKey(u) {
  return String(u || '').trim().replace(/^git\+/i, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/\\]+@/, '').replace(/^([^/\\:]{2,}):(?!\d)/, '$1/').replace(/[\\/]+$/, '').replace(/\.git$/i, '').toLowerCase();
}
function pushTarget() {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(BRAIN, 'package.json'), 'utf8')); } catch { return { remote: 'origin' }; }
  if (pkg.name !== 'infinite-context') return { remote: 'origin' };
  let backup = '';
  try { backup = String(JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).backupRemote || '').trim(); } catch { /* none */ }
  if (!backup) return { skip: 'no backup remote is named. To back the brain up, create a private repository of your own and set "backupRemote" to its address in brain.json' };
  let urls = [backup];
  try { urls = run('git', ['remote', 'get-url', '--push', '--all', backup], 30000).split(NL).map((s) => s.trim()).filter(Boolean); } catch { /* an address, not a remote name */ }
  const r = pkg.repository;
  const upstream = repoKey(typeof r === 'string' ? r : r && r.url);
  if (upstream && urls.some((u) => repoKey(u) === upstream)) return { skip: 'the backup remote is the public Infinite Context repository; name a private repository of your own in brain.json "backupRemote"' };
  return { remote: backup };
}

// Memory problems (a broken link, a near duplicate) no longer block a save (hooks/git/pre-commit, 2026-11-01); they
// are reported here instead, in the log every agent reads with --status after a save, naming what to fix.
function warnIfBrainHasFindings() {
  try {
    const out = run(process.execPath, [join(BRAIN, 'tools', 'reflect.mjs')], 120000);
    // Index drift is left out: after a save it is almost always another agent's memory written but not indexed yet,
    // which its own save is about to fix, and the line read as this agent's problem (audit 2026-11-01).
    const drift = Number((out.match(/^##\s*Index drift \((\d+)\)/m) || [])[1] || 0);
    const total = Number((out.match(/Total findings:\s*(\d+)/) || [])[1] || 0) - drift;
    if (total <= 0) return;
    const sections = out.split(NL).filter((l) => /^##\s/.test(l) && !/\(0\)\s*$/.test(l) && !/^##\s*Index drift/.test(l)).map((l) => l.replace(/^##\s*/, ''));
    const lines = out.split(NL).filter((l) => /->|<->/.test(l)).slice(0, 3).map((l) => l.trim());
    log('WARN after "' + message + '": brain has ' + total + ' finding(s), fix them (node tools/reflect.mjs): ' + sections.join('; ') + (lines.length ? ' | ' + lines.join(' | ') : ''));
  } catch (e) { log('WARN after "' + message + '": could not run reflect.mjs: ' + String(e.message).slice(0, 120)); }
}
