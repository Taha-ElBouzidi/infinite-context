// Stop hook: inspect the final assistant message. the owner rule: his agent writes in plain handwritten language, so
// the chat reply must contain no em dash, no emoji, no arrows, no checkmarks, no decorative symbols, no slang. If it
// does, the slip is noted for the next message (no rewrite: the owner 2026-10-22, a forced rewrite costs a whole extra
// reply); hooks/style-note.mjs puts it in front of the agent on its next message.
// The rules are in content-rules.mjs, shared with the mod (which runs them first; this hook is its backup
// through dispatch.mjs). The reply comes from the Stop input's last_assistant_message; the transcript is read only
// when Claude Code did not send it (hook review 2026-10-30: the whole-transcript read took 1.6 s a turn).
// Honors stop_hook_active so it can never infinite-loop. Fails open on any error.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { styleProblems } from './content-rules.mjs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

// If we are already inside a stop-hook-triggered continuation, do not block again.
if (data.stop_hook_active === true) process.exit(0);

let text = typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '';
if (!text && typeof data.last_assistant_message !== 'string') {
  const tp = data.transcript_path;
  if (!tp) process.exit(0);
  try {
    const lines = readFileSync(tp, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      const content = obj && obj.message && obj.message.content;
      if (obj && obj.type === 'assistant' && Array.isArray(content)) {
        const t = content
          .filter(c => c && c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text)
          .join('\n');
        if (t) { text = t; break; }
      }
    }
  } catch { process.exit(0); }
}

if (!text) process.exit(0);

const reasons = styleProblems(text);
if (reasons.length) {
  try {
    const dir = join(homedir(), '.claude', 'havok-style-notes');
    mkdirSync(dir, { recursive: true });
    const sid = String(data.session_id || 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'none';
    writeFileSync(join(dir, sid + '.json'), JSON.stringify({ at: new Date().toISOString(), reasons }));
  } catch { /* best effort */ }
}
process.exit(0);
