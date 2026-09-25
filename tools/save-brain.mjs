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
// Machines that are not SERVER write through `brain-client.mjs write`, which the server now also
// indexes and backs up in the background.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const [, message, ...extra] = argv;
const run = (cmd, args, timeout) => execFileSync(cmd, args, { cwd: BRAIN, timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
log('start: ' + message);
try { run(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 180000); } catch (e) { log('build-index failed: ' + String(e.stderr || e.message).split(NL)[0].slice(0, 160)); }
const why = (e) => (String(e.stdout || '') + String(e.stderr || '') + String(e.message || '')).replace(/\s+/g, ' ');
// Another writer (the brain server's queue, another agent) may hold the git lock for a moment.
for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    run('git', ['add', 'memory/', 'index/', 'MANIFEST.md', ...extra], 60000);
    run('git', ['commit', '-q', '-m', message], 240000);
    break;
  } catch (e) {
    const w = why(e);
    // Someone else's commit may already have taken these files. The push below still runs.
    if (/nothing to commit|no changes added/i.test(w)) { log('nothing new to commit: ' + message); break; }
    if (/index\.lock|cannot lock ref|Another git process/i.test(w) && attempt < 4) { sleep(3000 * attempt); continue; }
    // The agent kept writing after this run indexed, which is the whole point of not waiting. Drift
    // from that is healed by indexing again, never reported as a failure. Seen on the first real run.
    if (/index drift/i.test(w) && attempt < 4) {
      try { run(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 180000); } catch { /* the retry will say */ }
      continue;
    }
    log('FAILED to commit: ' + message + ' | ' + w.slice(0, 240));
    process.exit(1);
  }
}
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try { run('git', ['push', '-q', 'origin', 'HEAD'], 120000); log('done: ' + message); process.exit(0); }
  catch (e) {
    if (attempt < 3) { sleep(5000 * attempt); continue; }
    log('committed but NOT pushed: ' + message + ' | ' + why(e).slice(0, 240));
    process.exit(1);
  }
}
