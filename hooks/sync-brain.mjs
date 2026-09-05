// Scheduled sync engine for the Havok brain. Runs TWICE DAILY (08:00, 20:00) as a safety
// net only: conversations push their own work on commit via hooks/git/post-commit, so this
// exists purely to catch anything left behind. Commits what is safe to commit, pulls,
// pushes. Logs every run to .sync.log. Never throws.
//
// It used to run every 5 minutes AND do the pushing, which is how it twice swallowed
// in-progress work under a junk commit message, and how it raced the mind-map Action.
//
// Three guards, each earned the hard way on 2026-07-26:
//   grace period  do not swallow an in-progress session's work under a junk message
//   verify        do not propagate a brain that fails its own checks
//   reindex       do not commit memory without regenerating the index it feeds
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { appendFileSync, statSync, existsSync , readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.sync.log');
// Commit identity is instance config, brain.json.git {name, email}. With none, the repo's own
// git config applies. It was one person's Gmail address hardcoded until 2026-09-05.
function gitAuthorFlags() {
  try { const g = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).git || {}; if (g.email) return ['-c', 'user.email=' + g.email, '-c', 'user.name=' + (g.name || 'brain')]; } catch { /* none */ }
  return [];
}
const AUTHOR = gitAuthorFlags();

function git(args, opts = {}) {
  return execSync('git ' + args, { cwd: BRAIN, encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function log(line) {
  try { appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {}
}

let committed = false;
let pulled = false;
let pushed = false;
let note = '';

// Grace period. This engine previously fired every 5 minutes and committed whatever was
// dirty, which twice on 2026-07-26 swallowed an in-progress session's work under the
// meaningless message "sync: auto memory sync", losing the rationale from git history.
// If anything in the tree was touched within GRACE_MS, an author is probably still
// working: skip this cycle and let them write their own commit. Anything genuinely left
// behind gets picked up on a later run, which is what this engine is actually for.
const GRACE_MS = 4 * 60 * 1000;

function recentlyTouched() {
  let files = [];
  try {
    files = git('status --porcelain').split('\n').map((l) => l.slice(3).trim())
      .filter(Boolean).map((f) => f.replace(/^"|"$/g, ''));
  } catch { return false; }
  const now = Date.now();
  for (const f of files) {
    try {
      if (now - statSync(join(BRAIN, f)).mtimeMs < GRACE_MS) return true;
    } catch { /* deleted or unreadable, not a signal of active work */ }
  }
  return false;
}

try {
  const status = git('status --porcelain');
  if (status.trim() && recentlyTouched()) {
    note += 'grace-wait(active-edits) ';
  } else if (status.trim()) {
    // Refresh derived state BEFORE staging, or the index silently rots: this engine is
    // the main committer, and a commit that changes memory/ without regenerating leaves
    // the router and index describing a brain that no longer exists. Both steps are
    // idempotent and best-effort, a failure here must never block the sync.
    try {
      execSync('node "' + join(BRAIN, 'tools', 'stamp-updated.mjs') + '"', { cwd: BRAIN, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      execSync('node "' + join(BRAIN, 'tools', 'build-index.mjs') + '"', { cwd: BRAIN, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { note += 'reindex-failed '; }

    // The PR requirement is gone: any conversation may edit the brain directly. What
    // replaced it is verification, and this engine must honour it too. It runs unattended
    // as a scheduled task, so the Claude Code commit gate does NOT apply here. Without
    // this check the safe path is gated and the automated path is wide open,
    // which is the more dangerous of the two.
    //
    // Verify passes: stage everything, push direct. Verify fails: stage memory and index
    // only, so facts keep flowing while broken tooling stays on this machine instead of
    // reaching every other one. A syntax error in hooks/ blocks every Write, Edit and Bash
    // on whatever machine pulls it.
    let healthy = true;
    try {
      execSync('node "' + join(BRAIN, 'tools', 'verify.mjs') + '" --quiet', { cwd: BRAIN, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { healthy = false; }

    if (healthy) {
      git('add -A');
    } else {
      // index/rules.json is deliberately EXCLUDED from the degraded stage.
      //
      // The reasoning above ("facts keep flowing while broken tooling stays on this machine")
      // held while memory carried only facts. It stopped holding when the always-on behaviour
      // rules moved into memory frontmatter: rules.json is now the behaviour of every agent on
      // every machine, and it sits inside index/, so a verify failure CAUSED by a broken rule
      // was being pushed everywhere unattended, with the only trace a line in a log nobody
      // reads. A fact reaching other machines while tooling is broken is acceptable. A broken
      // rule reaching them is the failure this whole gate exists to prevent.
      git('add -- memory/ MANIFEST.md');
      git('add -- index/');
      try { git('reset -q -- index/rules.json'); } catch { /* not staged, nothing to unstage */ }
      const held = git('status --porcelain').split('\n')
        .filter((l) => l.trim() && !/^[AMDR ]{2} (memory|index)\//.test(l));
      note += 'VERIFY-FAILED-held-non-memory(' + held.length + ')+held-rules.json ';
    }

    // Only commit if the scoped stage actually produced something. Without this, a tree
    // dirty ONLY with non-memory changes stages nothing and `git commit` exits non-zero,
    // which would log a false commit-failed on every run until the PR lands.
    const staged = git('diff --cached --name-only').trim();
    if (staged) {
      const ts = new Date().toISOString();
      // execFileSync with an arg array so the author name with spaces is one argument
      // (a shell string split "the owner" into separate tokens and broke commit).
      execFileSync('git', [...AUTHOR, 'commit', '-q', '-m', 'sync: auto memory sync ' + ts], { cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      committed = true;
    }
  }
} catch (e) { note += 'commit-failed '; }

try {
  git('pull --no-rebase --quiet', { timeout: 45000 });
  pulled = true;
} catch (e) {
  note += 'pull-failed(maybe-conflict) ';
  try { git('merge --abort'); note += 'merge-aborted '; } catch {}
}

if (pulled) {
  try {
    git('push --quiet', { timeout: 45000 });
    pushed = true;
  } catch (e) { note += 'push-failed '; }
}

// Pull the PLUGIN copy too, which this job never did.
//
// BRAIN above resolves to this script's own location, the dev checkout. But the plugin clone
// under ~/.claude/plugins is what every OTHER conversation actually loads: its hooks.json, its
// enforcement hooks, its keyword index. Until now the only thing that ever pulled it was
// check-session-start, which runs once when a session begins. A session left open for days
// never re-pulls, so every chat opened during that window loads a stale brain.
//
// Found 2026-08-17 with the plugin 10 commits behind, missing the per-turn recall hook and the
// tokenizer fixes entirely. the owner's report was "some chats have issues syncing", and this was it.
//
// Generated files are discarded first for the same reason as everywhere else: they are rebuilt
// from memory/, so a local diff carries no information but will abort the pull and strand the
// clone. Failure here is logged, never fatal: the dev checkout is already synced by this point.
try {
  const plugin = resolve(homedir(), '.claude', 'plugins', 'marketplaces', 'havok-brain');
  if (existsSync(join(plugin, '.git'))) {
    const inPlugin = (args, timeout = 45000) =>
      execSync('git ' + args, { cwd: plugin, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    try { inPlugin('checkout -- memory/MEMORY.md index/ MANIFEST.md', 15000); } catch { /* nothing to discard */ }
    const before = inPlugin('rev-parse HEAD', 10000).trim();
    inPlugin('pull --no-rebase --quiet');
    const after = inPlugin('rev-parse HEAD', 10000).trim();
    note += before === after ? 'plugin-current ' : 'plugin-updated ';
  }
} catch (e) { note += 'plugin-pull-failed '; }

log('committed=' + committed + ' pulled=' + pulled + ' pushed=' + pushed + (note ? ' ' + note.trim() : ' ok'));
process.exit(0);
