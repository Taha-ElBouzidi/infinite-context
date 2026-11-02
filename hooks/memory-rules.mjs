// "Nothing saved" note (check-memory-written.mjs and the mod import this file). Pure: no Node imports.
// A session that did real work and wrote NOTHING to the brain gets one note, once per session, at the start of its
// next message (never a forced rewrite). Measured 2026-08-23: weeks of project work left no memory at all, and a
// rule injected every turn changed nothing; this asks at the one moment the work is finished. The owner, 2026-10-23:
// "let the agent decide if he learned anything new". Eight completed turns: a judgement call, low enough to catch a
// real working session, high enough to leave a quick question alone.

export const SUBSTANTIAL_STOPS = 8;

// entries: [{ name, mtimeMs }] of the memory folder.
export function snapshotOf(entries) {
  const files = entries.filter((f) => f.name.endsWith('.md') && f.name !== 'MEMORY.md');
  let newest = 0;
  for (const f of files) { const m = Math.floor(f.mtimeMs || 0); if (m > newest) newest = m; }
  return { count: files.length, newest };
}

// state: null at the first stop of the session. Returns { state, note? }.
export function afterStop(state, now, memDir) {
  if (!state) return { state: { base: now, stops: 1, nudged: false } };
  const wrote = now.count > (state.base?.count ?? now.count) || now.newest > (state.base?.newest ?? now.newest);
  const stops = (state.stops || 1) + 1;
  const shouldNudge = !wrote && !state.nudged && stops >= SUBSTANTIAL_STOPS;
  const next = { base: state.base, stops, nudged: state.nudged || shouldNudge };
  if (!shouldNudge) return { state: next };
  return { state: next, note: 'BRAIN CHECK, once per session: ' + stops + ' turns of work and nothing written to the brain. If anything became true and durable (a decision and its reason, a fact about a client or system, a correction, a thing that broke and why), save it now in ' + String(memDir).split('\\').join('/') + ' and run node tools/save-brain.mjs. If genuinely nothing, ignore this.' };
}
