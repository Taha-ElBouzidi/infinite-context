// PreToolUse hook (Bash and PowerShell, git commit only): the commit message never mentions an AI, as author
// or otherwise. The rules themselves are in commit-message-rules.mjs, shared with git/commit-msg and the mod
// (which runs them first; this hook is its backup through dispatch.mjs). Fails open on any error.
import { readFileSync } from 'node:fs';
import { commandProblems, HOW_TO_WRITE } from './commit-message-rules.mjs';

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

const problems = commandProblems(String((data.tool_input || {}).command || ''));

if (problems.length) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Commit blocked: ' + problems.join(', ') + '. ' + HOW_TO_WRITE,
    },
  }));
}
process.exit(0);
