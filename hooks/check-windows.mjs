// Refuses a Bash or PowerShell call that would open a visible window or start a timer-based watcher. The rules and the
// reasons are in window-rules.mjs, shared with the mod (which runs them first; this hook is its backup through
// dispatch.mjs). Fails open on input it cannot read.
import { readFileSync } from 'node:fs';
import { windowProblems, windowDenyReason } from './window-rules.mjs';

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
let problems = [];
try { problems = windowProblems(data.tool_name, data.tool_input || {}); } catch { process.exit(0); }
if (!problems.length) process.exit(0);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: windowDenyReason(problems) },
}));
process.exit(0);
