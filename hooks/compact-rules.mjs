// Compaction analytics (post-compact.mjs and the mod import this file). The owner, 2026-10-16: "add analytics to
// it so that we can track it, so that we can see if it's actually good or not". One row per compaction to
// ~/.claude/havok-compact-log.jsonl, and a watch so hooks/pre-turn.mjs follows the next WATCH_TURNS messages.
// Pure: no Node imports.

export const WATCH_TURNS = 10;

export function compactRow(atIso, host, session, trigger, ctxBefore, summary) {
  return JSON.stringify({ at: atIso, host, session, ev: 'compacted', trigger, ctxBefore, summaryChars: String(summary || '').length }) + '\n';
}

export const watchState = (nowMs) => JSON.stringify({ at: nowMs, turnsLeft: WATCH_TURNS, turn: 0 });

// The size before, from a model reply's usage.
export const contextOf = (u) => (u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0);
