// Shows the agent, at the start of its next message, the notes its last reply left (The owner, 2026-10-22: "it shouldn't
// regenerate its message, because that will cost us. What it should do is fix it for the next message"):
//   <session>.json        a writing slip, from hooks/check-stop.mjs
//   <session>.learn.json  a correction or decision from the owner that was not saved, from hooks/check-memory-written.mjs
//   <session>.work.json   once per session, real work and nothing written to the brain, same hook
// Each note is shown once and deleted. The slip's wording is in content-rules.mjs, shared with the mod (which
// keeps its notes itself; this hook is its backup through dispatch.mjs). Fails open.
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { slipNote } from './content-rules.mjs';

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const sid = String(data.session_id || 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'none';
const dir = join(homedir(), '.claude', 'havok-style-notes');

const take = (name) => {
  const file = join(dir, name);
  if (!existsSync(file)) return null;
  let note = null;
  try { note = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable: drop it */ }
  try { unlinkSync(file); } catch { /* best effort */ }
  return note;
};

const out = [];
const slip = take(sid + '.json');
if (slip && Array.isArray(slip.reasons) && slip.reasons.length) out.push(slipNote(slip.reasons));
for (const kind of ['learn', 'work']) {
  const n = take(sid + '.' + kind + '.json');
  if (n && n.text) out.push(n.text);
}
if (!out.length) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.join('\n\n') },
}));
process.exit(0);
