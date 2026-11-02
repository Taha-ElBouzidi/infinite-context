// PreToolUse hook (Bash and PowerShell, git commit only): scan the staged diff for secrets and block the commit if
// any are found. The patterns are in secret-rules.mjs, shared with the mod (which runs the scan first; this
// hook is its backup through dispatch.mjs). Not a git repository or no staged diff: nothing to scan.
// A diff that cannot be read in time blocks: a slow scan must never let the commit through unchecked.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isCommitAttempt, commitDir, secretsIn, secretDenyReason, SCAN_UNFINISHED } from './secret-rules.mjs';

const SCAN_MS = 10000;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
};

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

const cmd = String((data.tool_input || {}).command || '');
if (!isCommitAttempt(cmd)) process.exit(0);

let diff = '';
try {
  diff = execFileSync('git', ['diff', '--cached', '--no-color'], { encoding: 'utf8', cwd: commitDir(cmd, data.cwd || process.cwd()), timeout: SCAN_MS, maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  if (e && (e.code === 'ETIMEDOUT' || e.signal || e.code === 'ENOBUFS')) deny(SCAN_UNFINISHED);
  process.exit(0);
}
if (!diff) process.exit(0);

const hits = secretsIn(diff);
if (hits.length) deny(secretDenyReason(hits));
process.exit(0);
