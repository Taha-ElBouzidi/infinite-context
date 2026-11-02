// The mod runs the brain's hook jobs; the command hooks are only the backup (The owner, 2026-11-02: "the mods run
// and the hook is only a backup if the mods fail"). The mod handles an event first (its hooks run above the command
// hooks of the same event), then writes ~/.claude/havok-mod/alive/<session>.json naming the event it just handled.
// hooks/dispatch.mjs, the one command hook per event, reads it: when the mod handled this very event (same key,
// within FRESH_MS) it exits at once; otherwise it runs the old hooks itself and logs that it had to.
//
// The key is per event, not one time for the session: the mod handling the last tool call says nothing about this
// one (a mod hook that threw or ran out of time on this call writes nothing, so the backup runs for it). Both sides
// compute it from the same hook input, so this file is the one place it is defined. Pure: no Node imports.

export const ALIVE_DIR = '.claude/havok-mod/alive';
export const FRESH_MS = 60_000;
// Tool calls can run in parallel: the marker keeps the last few handled ones.
export const KEEP_KEYS = 32;
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'PostCompact'];

export const safeSession = (sid) => String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

export function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

// The same input gives the same key in the mod and in the command hook.
export function markerKey(event, data) {
  const d = data || {};
  if (event === 'PreToolUse') return String(d.tool_use_id || '') || ('h' + hash(String(d.tool_name || '') + JSON.stringify(d.tool_input || {})));
  if (event === 'UserPromptSubmit') return String(d.prompt_id || '') + '|' + hash(d.prompt);
  if (event === 'Stop') return String(d.prompt_id || '') + '|' + (d.stop_hook_active ? 1 : 0) + '|' + hash(d.last_assistant_message);
  if (event === 'SessionStart') return String(d.source || '');
  if (event === 'PostCompact') return String(d.trigger || '') + '|' + hash(d.compact_summary);
  return '';
}

// The marker after the mod handled `event` with `key` at `now`.
export function marked(marker, version, event, key, now) {
  const m = marker && typeof marker === 'object' && marker.ev && typeof marker.ev === 'object' ? marker : { ev: {} };
  const list = (Array.isArray(m.ev[event]) ? m.ev[event] : []).filter((x) => Array.isArray(x) && x[0] !== key && now - x[1] < FRESH_MS);
  list.push([key, now]);
  return { v: version, at: now, ev: { ...m.ev, [event]: list.slice(-KEEP_KEYS) } };
}

// Whether the mod handled this event, with this input, within FRESH_MS.
export function handled(marker, event, data, now) {
  if (!marker || !marker.ev || !Array.isArray(marker.ev[event])) return false;
  const key = markerKey(event, data);
  return marker.ev[event].some((x) => Array.isArray(x) && x[0] === key && now - Number(x[1]) < FRESH_MS && Number(x[1]) <= now + 5000);
}
