// Compaction analytics (The owner, 2026-10-16: "add analytics to it so that we can track it, so that we can see if it's
// actually good or not"). PostCompact: records one row per compaction (session, machine, trigger, size before, length
// of the summary), and arms a watch so hooks/pre-turn.mjs follows the next 10 messages: size after, and whether the owner
// had to repeat or correct something ("you forgot", "I told you"), the sign a compaction lost what mattered.
// Rows go to ~/.claude/havok-compact-log.jsonl; pre-turn.mjs forwards them to the brain server (/compaction-log).
// The row and the watch are in compact-rules.mjs, shared with the mod (which records them first; this hook is
// its backup through dispatch.mjs).
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { compactRow, watchState, contextOf } from './compact-rules.mjs';

const HOME = join(homedir(), '.claude');
let d = {}; try { d = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const sid = String(d.session_id || '').replace(/[^\w-]/g, '');

// Size before: the last model reply's usage in the transcript, read from the file's last 2 MB.
let ctxBefore = 0;
try {
  const tp = String(d.transcript_path || '');
  if (tp && existsSync(tp)) {
    const size = statSync(tp).size, len = Math.min(size, 2 * 1024 * 1024), buf = Buffer.alloc(len), fd = openSync(tp, 'r');
    readSync(fd, buf, 0, len, size - len); closeSync(fd);
    for (const l of buf.toString('utf8').split('\n').reverse()) {
      if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const u = o && o.type === 'assistant' && o.message && o.message.usage;
      if (u) { ctxBefore = contextOf(u); break; }
    }
  }
} catch { /* size stays 0 */ }

try {
  mkdirSync(join(HOME, 'havok-compact-watch'), { recursive: true });
  appendFileSync(join(HOME, 'havok-compact-log.jsonl'), compactRow(new Date().toISOString(), hostname(), sid, d.trigger, ctxBefore, d.compact_summary));
  if (sid) writeFileSync(join(HOME, 'havok-compact-watch', sid + '.json'), watchState(Date.now()));
} catch { /* analytics never block anything */ }
process.exit(0);
