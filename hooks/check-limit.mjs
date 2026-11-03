// Keeps the last 5 percent of the Claude plan for the main assistant (The owner, 2026-10-02). The rules and why each
// exists are in limit-rules.mjs, shared with the mod (which runs them first; this hook is its backup through
// dispatch.mjs). Plain code, no tokens: below the bar it exits silently, and a blocked prompt never reaches the model.
//
// Runs on UserPromptSubmit (blocks the prompt) and on PreToolUse for EVERY tool (refuses the call).
// The percentages come from this machine's status line, the only place Claude Code exposes them (hooks receive
// no limit fields); it writes them to ~/.claude/havok-limits.json. the owner chose local over a shared server copy:
// a machine back from idle may run one prompt past the bar, until its first reply brings the real number.
//
// Exempt: the agent brain.json names for this machine's Claude subscription (limitReserve.accounts), matched on
// HAVOK_MOD_AGENT (set by the launcher; not when only inherited by a session started from its tool shell), and the session ~/.claude/havok-main-session.txt holds. Bypass: the owner starts a prompt with "urgent", which opens this session for 2 hours.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BYPASS_MS, reserveOf, accountOf, agentExempt, claudeFiles, hitsOf, typedUrgent, isPing, typedRow, urgentStillOpen, blockMessage, TOOL_STOP, PING_BLOCKED, blockKind, blockRow, bypassName, BYPASS_OUTBOX, BYPASS_REASON, bypassUseRow, BYPASS_MARKER, bypassMarkerAfter } from './limit-rules.mjs';

const HOME = join(homedir(), '.claude');
const BYPASS_DIR = join(HOME, 'havok-limit-bypass');

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const session = String(data.session_id || '');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };

const files = claudeFiles(homedir(), process.env.CLAUDE_CONFIG_DIR);
const reserve = reserveOf(parse(read(join(dirname(dirname(fileURLToPath(import.meta.url))), 'brain.json'))), accountOf(parse(read(files.claudeJson))));
if (!reserve.enabled) process.exit(0);
const { five, week, hits } = hitsOf(parse(read(files.limits)), Date.now());

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

// Lets the session through a bypass file.
const through = (file, reason) => {
  try {
  } catch { /* bookkeeping only */ }
  process.exit(0);
};
const bypassFileName = 'havok-limit-bypass/' + bypassName(session);

if (session && read(join(HOME, 'havok-main-session.txt')) === session) through('havok-main-session.txt', BYPASS_REASON.main);
if (agentExempt(process.env, reserve)) process.exit(0);

if (typed) through(bypassFileName, BYPASS_REASON.urgent);
if (Number(read(bypassFile)) > Date.now()) through(bypassFileName, BYPASS_REASON.urgent);

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
  if (urgentStillOpen(last, Date.now())) { openBypass(last.at + BYPASS_MS); through(bypassFileName, BYPASS_REASON.urgent); }
}

const msg = blockMessage(hits, reserve.mainAgent);
logBlock(blockKind(data.hook_event_name, data.tool_name));
if (data.hook_event_name === 'UserPromptSubmit') {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
} else {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg + TOOL_STOP } }));
}
process.exit(0);
