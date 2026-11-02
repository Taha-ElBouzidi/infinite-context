// Keep-warm pings (the mod and the backup check-keep-warm.mjs import this file). Pure.
// The owner, 2026-10-05: the prompt cache lives about an hour; a resume after that re-processes the whole conversation.
// The mod keeps a session warm by itself (its keepwarm.ts decides when, and submits the ping). The old way, a
// CronCreate timer per session whose pings a command hook let through or blocked, is retired (The owner, 2026-11-02: every
// blocked ping showed "UserPromptSubmit operation blocked by hook" in his chat). A ping is never blocked here any more:
//   - the mod's own ping goes through with ALLOWED_CONTEXT (answer one word);
//   - a ping fired by an old timer still alive in a session started before the change goes through once with
//     OLD_TIMER_CONTEXT, which has the agent delete that timer, so no ping of it comes again. A block cannot be quiet
//     (Claude Code shows its reason in the chat); one short turn per old timer is the cost of a quiet clean-up.

export const KEEP_WARM_PROMPT = 'keep-warm ping';

export const ALLOWED_CONTEXT = 'Automatic keep-warm ping to refresh the cache. Reply with the single word ok. No tools, no thinking.';
export const OLD_TIMER_CONTEXT = 'This keep-warm ping came from an old session timer that is retired (keep-warm timers are no longer used). '
  + 'Silently run CronList and CronDelete every job whose prompt is "keep-warm ping", then reply with the single word ok. No other tools, no thinking, nothing else.';

export const isPingText = (prompt) => String(prompt || '').trim() === KEEP_WARM_PROMPT;

// A scheduled task fired it: a CronCreate timer, never the mod (the mod submits its ping itself).
export const fromTimer = (data) => String((data || {}).source || '') === 'schedule_wakeup';

// What the model reads beside a ping.
export const pingContext = (own) => (own ? ALLOWED_CONTEXT : OLD_TIMER_CONTEXT);
