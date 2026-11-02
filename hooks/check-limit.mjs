// Keeps the last 3 percent of the Claude plan for the main assistant (The owner, 2026-10-02). The rules and why each
// exists are in limit-rules.mjs, shared with the mod (which runs them first; this hook is its backup through
// dispatch.mjs). Plain code, no tokens: below the bar it exits silently, and a blocked prompt never reaches the model.
//
// Runs on UserPromptSubmit (blocks the prompt) and on PreToolUse for EVERY tool (refuses the call).
// The percentages come from this machine's status line, the only place Claude Code exposes them (hooks receive
// no limit fields); it writes them to ~/.claude/havok-limits.json. the owner chose local over a shared server copy:
// a machine back from idle may run one prompt past the bar, until its first reply brings the real number.
//
// Exempt: the main assistant, whose session id ~/.claude/havok-main-session.txt holds (written by
// the launcher of the main session). Bypass: the owner starts a prompt with "urgent", which opens this session for 2 hours.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BYPASS_MS, hitsOf, typedUrgent, isPing, typedRow, urgentStillOpen, blockMessage, TOOL_STOP, PING_BLOCKED, blockKind, blockRow, bypassName } from './limit-rules.mjs';

const HOME = join(homedir(), '.claude');
const BYPASS_DIR = join(HOME, 'havok-limit-bypass');

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const session = String(data.session_id || '');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };

const { five, week, hits } = hitsOf(parse(read(join(HOME, 'havok-limits.json'))), Date.now());

const typed = typedUrgent(data);
const bypassFile = join(BYPASS_DIR, bypassName(session));
const openBypass = (until) => { try { mkdirSync(BYPASS_DIR, { recursive: true }); writeFileSync(bypassFile, String(until)); } catch { /* still let it through */ } };
// Recorded below the bar too: "urgent" typed at 96 percent was lost, and the same session was blocked minutes later.
if (typed) openBypass(Date.now() + BYPASS_MS);
if (!hits.length) process.exit(0);

// Every block is logged so a reserve that runs out can be traced (the 6 October one could not).
const logBlock = (kind) => { try { appendFileSync(join(HOME, 'havok-limit-blocks.jsonl'), blockRow(Date.now(), session, kind, data.hook_event_name, five, week) + String.fromCharCode(10)); } catch { /* bookkeeping only */ } };

// Keep-warm pings are blocked above the bar in EVERY session, the main session's included, and "urgent" does not open them:
// on 2026-10-06 the main session's own pings, exempt as such, used up the reserve they were meant to protect.
if (isPing(data)) {
  logBlock('keep-warm');
  process.stdout.write(JSON.stringify({ decision: 'block', reason: PING_BLOCKED }));
  process.exit(0);
}

if (session && read(join(HOME, 'havok-main-session.txt')) === session) process.exit(0);

if (typed) process.exit(0);
if (Number(read(bypassFile)) > Date.now()) process.exit(0);

// The prompt-time run can miss "urgent" (seen 2026-10-28 on one machine: the hook timed out or got no
// prompt, so no bypass file and every tool stayed blocked). So a tool call also reads the owner's last typed message and
// when he sent it. A growing tail, not the whole file: transcripts reach 993 MB (over 2 GiB a full read throws), and
// the old fixed 400 KB tail missed the prompt behind large tool results in 14 of 319 turns (audit 2026-11-01).
function lastTypedPrompt(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    for (const span of [1 << 20, 8 << 20, 64 << 20]) {
      const len = Math.min(size, span);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split(String.fromCharCode(10));
      for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) {
        const row = typedRow(parse(lines[i]), Date.now());
        if (row) return row;
      }
      if (len === size) break;
    }
  } catch { /* no transcript, no bypass */ } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } } }
  return { text: '', at: 0 };
}
if (data.hook_event_name === 'PreToolUse' && data.transcript_path) {
  const last = lastTypedPrompt(data.transcript_path);
  if (urgentStillOpen(last, Date.now())) { openBypass(last.at + BYPASS_MS); process.exit(0); }
}

const msg = blockMessage(hits);
logBlock(blockKind(data.hook_event_name, data.tool_name));
if (data.hook_event_name === 'UserPromptSubmit') {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
} else {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg + TOOL_STOP } }));
}
process.exit(0);
