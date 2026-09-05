// PreToolUse gate on `git commit` inside the brain. This is the mechanism that replaced
// the PR requirement for non-memory brain changes.
//
// Rationale: the PR rule had one reviewer who merged without diffing, so it caught none
// of the three bugs shipped into brain tooling on 2026-07-26. Meanwhile a syntax error in
// hooks/ exits non-zero, and a non-zero PreToolUse hook blocks every Write, Edit, and Bash
// on every machine within one sync cycle. Ceremony was not protecting against that; a
// parse check is. Any conversation may now edit the brain directly, but it cannot commit
// a brain that fails verification.
//
// Deliberately scoped to git commit, NOT to Write/Edit. If this file itself ever breaks,
// it blocks commits only, which is recoverable from any plain terminal. Blocking edits
// would be self-trapping.
//
// Fails OPEN on anything unexpected (not a brain commit, node missing, verifier absent).
// Fails CLOSED only on an actual verification failure, which is the entire point.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Where this script LIVES is not where the commit is happening.
//
// This resolved BRAIN from its own path, then ran git with cwd: BRAIN. The plugin registers it
// under CLAUDE_PLUGIN_ROOT, so it inspected the plugin clone, whose index is always empty. The
// "nothing staged, allow" branch therefore fired on every commit in every repo, making the gate
// a universal no-op. Verified by a red-team pass, 2026-08-18.
//
// The PreToolUse payload carries the real cwd. Resolve the repo root from there and gate that.
const SELF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function allow() { process.exit(0); }

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { allow(); }

let cmd = '';
let payloadCwd = '';
try {
  const payload = JSON.parse(input || '{}');
  cmd = payload?.tool_input?.command || '';
  payloadCwd = payload?.cwd || '';
} catch { allow(); }

// Repo root of the directory the command actually runs in. Falls back to this script location
// only when the payload carries no cwd, preserving old behaviour rather than failing open in a
// new way.
let BRAIN = SELF_DIR;
try {
  if (payloadCwd) {
    BRAIN = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: payloadCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || SELF_DIR;
  }
} catch { BRAIN = SELF_DIR; }

// Only gate the Havok brain. Any other repo is none of this hook business.
if (!existsSync(join(BRAIN, 'REFLEX.md')) || !existsSync(join(BRAIN, 'memory'))) allow();

// Only gate an actual commit.
if (!/\bgit\b[^|;&]*\bcommit\b/.test(cmd)) allow();

// Only gate commits that touch the brain. A commit in another repo is none of our business.
let staged = '';
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch { allow(); }
if (!staged.trim()) allow();

// Memory-only commits skip the heavy checks: memory is open by design, and a fact cannot
// brick a session. Anything touching hooks, tools, or the rulebook gets verified.
const files = staged.split('\n').map((s) => s.trim()).filter(Boolean);
// Memory-only commits used to skip the heavy checks, reasoning that a fact cannot brick a
// session. That stopped being true when the always-on behaviour rules moved INTO memory
// frontmatter: memory/*.md plus index/rules.json ARE the rules pipeline, and they were exactly
// the allow-list, so a commit deleting a rule was waved through. Touching the rules is always
// risky now, whatever directory the file sits in.
const touchesRules = files.some((f) => f === 'index/rules.json' || (f.startsWith('memory/') && f.endsWith('.md')));
const risky = files.filter((f) => !/^(memory|index)\//.test(f));
if (!risky.length && !touchesRules) allow();

const verifier = join(BRAIN, 'tools', 'verify.mjs');
if (!existsSync(verifier)) allow();

try {
  execFileSync(process.execPath, [verifier, '--quiet'], {
    cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  allow();
} catch (e) {
  const detail = String((e.stdout || '') + (e.stderr || '')).trim();
  if (e.code === 'ETIMEDOUT' || e.signal) allow(); // verifier hung: do not wedge the session
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Brain verification FAILED, commit blocked. This commit touches ' + risky.length +
        ' non-memory file(s) and would leave the shared brain broken for every machine.\n\n' +
        detail + '\n\nFix, then re-run: node tools/verify.mjs',
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
