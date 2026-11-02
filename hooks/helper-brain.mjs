// Connects every helper to the brain (The owner, 2026-10-22: "we should activate that for hidden helpers ... we
// should make them connect"). A helper started with the Agent tool gets no brain recall of its own
// (reference_subagents_get_no_brain_recall), so: Agent / Task get the brain block in their prompt, and a message to
// a running helper (SendMessage) gets the brain's recall for it. The rules are in helper-rules.mjs, shared with the
// mod (which runs them first; this hook is its backup through dispatch.mjs). Messages to other sessions are
// left alone: those sessions run their own recall. Fails open: any error leaves the call untouched.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withHelperBlock, recallQuery, withRecall } from './helper-rules.mjs';

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const input = data.tool_input || {};
const tool = String(data.tool_name || '');

const root = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(root, 'tools', 'brain-client.mjs').replace(/\\/g, '/');

const allow = (updated) => {
  if (!updated) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated },
  }));
  process.exit(0);
};

if (tool === 'SendMessage') {
  const q = recallQuery(input);
  if (!q) process.exit(0);
  let recall = '';
  try {
    recall = execFileSync('node', [client, 'search', q], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  } catch { process.exit(0); }
  allow(withRecall(input, recall, client));
}

allow(withHelperBlock(input, client));
