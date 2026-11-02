// PreToolUse hook: block banned characters in file writes, shell commands and outbound messages.
// the owner rule: his communication and documents use plain handwritten language, no em dash, no emoji, no arrows,
// no checkmarks, no slang. The rules themselves are in content-rules.mjs, shared with the mod (which runs
// them first; this hook is its backup through dispatch.mjs).
// Fails open on any error so a hook bug can never block legitimate work.
import { readFileSync } from 'node:fs';
import { contentProblems, contentDenyReason } from './content-rules.mjs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

const p = contentProblems(String(data.tool_name || ''), data.tool_input || {});
if (p) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: contentDenyReason(p) },
  }));
}
process.exit(0);
