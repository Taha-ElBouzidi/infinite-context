// The one store on the host for analytics rows from every machine (The owner, 2026-11-02: every analytic is saved on the
// server, so nobody has to fetch it from the machines later). Kinds:
//   usage        one row per finished turn of an agent, sent by the mod when one is installed: tokens, model, context, cost
//   hook-backup  one row each time the old command hooks had to run because the mod did not handle an event
//                (hooks/dispatch.mjs), with why when it is knowable
// Rows land in <brain>/.analytics/<kind>.jsonl, one JSON object per line, as sent plus `received`. Each row carries
// an `id` given where it was made: a row sent twice (a lost answer, a retry) is kept once. Kept always, never
// committed (.gitignore). Count them with: node tools/analytics-count.mjs
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['usage', 'hook-backup'];
export const MAX_ROWS = 200;
export const MAX_ROW_CHARS = 4000;
export const MAX_BODY_CHARS = 1_000_000;
const ID_RE = /^[A-Za-z0-9:._@-]{1,120}$/;

export const storeDir = (brain) => join(brain, '.analytics');
export const storeFile = (brain, kind) => join(storeDir(brain), kind + '.jsonl');

const seen = new Map();
function idsOf(brain, kind) {
  const key = brain + '|' + kind;
  if (seen.has(key)) return seen.get(key);
  const ids = new Set();
  try {
    for (const line of readFileSync(storeFile(brain, kind), 'utf8').split('\n')) {
      if (!line) continue;
      try { const id = JSON.parse(line).id; if (id) ids.add(id); } catch { /* a torn line */ }
    }
  } catch { /* no file yet */ }
  seen.set(key, ids);
  return ids;
}

// { status, body }: 200 with the ids taken (new or already kept), or 400 with the reason.
export function accept(brain, payload, now = Date.now()) {
  const kind = String((payload && payload.kind) || '');
  if (!KINDS.includes(kind)) return { status: 400, body: { error: 'kind must be one of ' + KINDS.join(', ') } };
  const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, MAX_ROWS) : [];
  const ids = idsOf(brain, kind);
  const fresh = [];
  const taken = [];
  const refused = [];
  for (const r of rows) {
    const id = r && typeof r === 'object' && !Array.isArray(r) ? String(r.id || '') : '';
    if (!ID_RE.test(id)) { refused.push(id || '(no id)'); continue; }
    const line = JSON.stringify({ ...r, received: new Date(now).toISOString() });
    if (line.length > MAX_ROW_CHARS) { refused.push(id); continue; }
    taken.push(id);
    if (ids.has(id) || fresh.some((f) => f.id === id)) continue;
    fresh.push({ id, line });
  }
  if (!taken.length) return { status: 400, body: { error: 'no row with a valid id', refused } };
  if (fresh.length) {
    mkdirSync(storeDir(brain), { recursive: true });
    appendFileSync(storeFile(brain, kind), fresh.map((f) => f.line).join('\n') + '\n', 'utf8');
    for (const f of fresh) ids.add(f.id);
  }
  return { status: 200, body: { ok: true, kind, accepted: taken, added: fresh.length, duplicates: taken.length - fresh.length, refused } };
}

// Rows per kind and machine, with the first and last time seen.
export function counts(brain) {
  const out = {};
  for (const kind of KINDS) {
    const f = storeFile(brain, kind);
    if (!existsSync(f)) continue;
    const per = {};
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = String(o.machine || 'unknown');
      const at = String(o.at || o.received || '');
      const c = per[m] || (per[m] = { rows: 0, first: at, last: at });
      c.rows++;
      if (at && (!c.first || at < c.first)) c.first = at;
      if (at > c.last) c.last = at;
    }
    out[kind] = per;
  }
  return out;
}
