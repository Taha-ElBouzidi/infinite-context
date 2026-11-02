// The limit reserve (check-limit.mjs) as rules, in one place: the command hook and the mod import this file.
// Pure: no Node imports; the callers read the files and pass what they read.
//
// Keeps the last 3 percent of the Claude plan for the main assistant. The owner, 2026-10-02: at 97 percent of the 5 hour
// or the weekly limit, every other session stops taking new prompts and launching helper agents, so the main assistant still has
// room for an emergency. Every tool call too since 2026-10-16 ("the last two times we hit the limit, we hit them
// with other agents, not by you"). Bypass: the owner starts a prompt with "urgent", which opens the session for BYPASS_MS.

export const BAR = 97;
export const BYPASS_MS = 2 * 60 * 60 * 1000;
export const KEEP_WARM_PROMPT = 'keep-warm ping';

// Only what the owner typed opens the reserve (audit 2026-11-01): a scheduled, loop or system wakeup, or a message relayed
// from another agent, that starts with "urgent" opened it too. A missing or unknown source still counts as typed.
export const AUTOMATED_SOURCES = new Set(['schedule_wakeup', 'loop_wakeup', 'poll_event', 'system']);
export const URGENT = /^\s*urgent\b/i;

// This machine's own reading, from its status line (~/.claude/havok-limits.json). Inside one window usage only rises;
// a reading counts until its window resets (resets_at), so an old number never blocks work.
export function hitsOf(lim, now) {
  const live = (w) => (w && typeof w.used_percentage === 'number' && Number(w.resets_at) * 1000 > now ? w : null);
  const five = live(lim && lim.five);
  const week = live(lim && lim.week);
  return { five, week, hits: [['5 hour', five], ['weekly', week]].filter(([, w]) => w && w.used_percentage >= BAR) };
}

export const promptOf = (data) => (data && data.hook_event_name === 'UserPromptSubmit' ? String(data.prompt || '') : '');

export function isTyped(data) {
  return !AUTOMATED_SOURCES.has(String((data && data.source) || '')) && !(data && data.origin && data.origin.kind && data.origin.kind !== 'human');
}

export const typedUrgent = (data) => URGENT.test(promptOf(data)) && isTyped(data);

export const isPing = (data) => promptOf(data).trim() === KEEP_WARM_PROMPT;

// A transcript row a person typed: { text, at }, or null. Only entries a person typed (origin.kind "human", or no
// origin in older transcripts) count; tool results, meta rows and compaction summaries do not.
export function typedRow(e, now) {
  if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || !e.message) return null;
  if (e.origin && e.origin.kind && e.origin.kind !== 'human') return null;
  const at = Date.parse(e.timestamp) || now;
  const c = e.message.content;
  if (typeof c === 'string') return { text: c, at };
  if (Array.isArray(c)) {
    if (c.some((p) => p && p.type === 'tool_result')) return null;
    const t = c.find((p) => p && p.type === 'text');
    if (t) return { text: String(t.text || ''), at };
  }
  return null;
}

// Two hours from when he typed it, not from now: re-armed from now, one "urgent" kept the reserve open for as long as
// the turn ran.
export const urgentStillOpen = (last, now) => !!last && URGENT.test(last.text) && last.at + BYPASS_MS > now;

export function blockMessage(hits) {
  const when = (w) => (w.resets_at ? new Date(w.resets_at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown');
  return hits.map(([name, w]) => name + ' limit at ' + Math.round(w.used_percentage) + '%, resets ' + when(w)).join('; ')
    + '. The rest is kept for the main assistant. Start your message with "urgent" to open this session for 2 hours.';
}

export const TOOL_STOP = ' Stop working now: write where you stopped so the work can resume after the reset, and end your turn.';
export const PING_BLOCKED = 'keep-warm: limit reserve reached, ping skipped';

export const blockKind = (event, tool) => (event === 'UserPromptSubmit' ? 'prompt' : /^(Agent|Task)$/.test(String(tool || '')) ? 'agent' : 'tool');

export function blockRow(at, session, kind, event, five, week) {
  return JSON.stringify({ at, session, kind, event, five: five && five.used_percentage, week: week && week.used_percentage });
}

export const bypassName = (session) => String(session || '').replace(/[^\w-]/g, '') + '.txt';
