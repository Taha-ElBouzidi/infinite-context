// Sends a machine's analytics rows to the one store on the host (POST /analytics, tools/analytics-store.mjs; The owner,
// 2026-11-02: analytics live on the server only). The machine keeps a row only until the server has accepted it:
//   node send-analytics.mjs <kind> <outbox.jsonl> [--legacy <folder>]
// The outbox is one JSON row per line, each with its own `id`. The sender first takes the whole outbox by renaming it
// (so a row appended meanwhile goes to a new outbox and is never lost), sends it, and appends back only the rows the
// server did not confirm; a claim a crashed sender left is taken over after CLAIM_STALE_MS. The server keeps a row
// once per id, so a row sent twice is not counted twice.
// --legacy: the daily usage files of mod 0.1.10 and before (<agent>@<MACHINE>-<date>.jsonl) are sent once, each row
// with an id made from its content, and a file the server fully confirmed moves into <folder>/sent.
// Called by the mod after each turn and at session start, and by dispatch.mjs, never waited for. Never throws.
import { readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BATCH = 200;
export const SEND_MS = 8000;
export const CLAIM_STALE_MS = 2 * 60_000;
export const LEGACY_FILE = /^[a-z0-9][a-z0-9._-]*@[A-Z0-9_-]+-\d{4}-\d{2}-\d{2}\.jsonl$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
export const parseLines = (text) => text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && typeof o === 'object');

// Where the server is and how to reach it: the same discovery as the brain's other callers (pre-turn.mjs), with the
// server's own certificate pinned. HAVOK_ANALYTICS_URL (plain http) is for tests only.
export function endpoint() {
  const token = ['havok-server-token', 'havok-token-cache'].map((f) => { try { return readFileSync(join(homedir(), '.claude', f), 'utf8').trim(); } catch { return ''; } }).find(Boolean) || '';
  if (process.env.HAVOK_ANALYTICS_URL) return { url: new URL('/analytics', process.env.HAVOK_ANALYTICS_URL), token };
  const ep = readJson(join(ROOT, 'server-endpoint.json'));
  if (!ep || !ep.url || !token) return null;
  const url = new URL('/analytics', ep.url);
  let servername = '';
  const host = String((readJson(join(ROOT, 'vault-recipients.json')) || {}).host || '').toUpperCase();
  const me = String(process.env.HAVOK_MACHINE_NAME || process.env.COMPUTERNAME || hostname()).toUpperCase();
  if (host && host === me) url.hostname = '127.0.0.1';
  else if (ep.tailnet && ep.tailnet.magicdns) servername = ep.tailnet.magicdns;
  let ca;
  try { ca = readFileSync(join(ROOT, ep.cert || 'server-cert.pem'), 'utf8'); } catch { return null; }
  return { url, token, ca, servername };
}

export async function post(ep, kind, rows) {
  const body = JSON.stringify({ kind, rows });
  const mod = await import(ep.url.protocol === 'https:' ? 'node:https' : 'node:http');
  return new Promise((done) => {
    const rq = mod.request(ep.url, {
      method: 'POST', agent: false, ca: ep.ca, servername: ep.servername || undefined,
      headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => { let o = null; try { o = JSON.parse(t); } catch { /* not json */ } done(r.statusCode === 200 && o && Array.isArray(o.accepted) ? new Set(o.accepted) : new Set()); });
      r.on('error', () => done(new Set()));
    });
    rq.on('error', () => done(new Set()));
    rq.setTimeout(SEND_MS, () => rq.destroy());
    rq.end(body);
  });
}

// The ids the server confirmed, out of `rows`, in batches.
export async function sendRows(ep, kind, rows) {
  const ok = new Set();
  for (let i = 0; i < rows.length; i += BATCH) {
    const got = await post(ep, kind, rows.slice(i, i + BATCH));
    if (!got.size) break;
    for (const id of got) ok.add(id);
  }
  return ok;
}

// Takes the outbox and any claim a crashed sender left, by renaming: what this sender sends is its own.
function claim(outbox, now) {
  const dir = dirname(outbox), name = basename(outbox);
  const mine = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(name + '.sending-')) continue;
      const p = join(dir, f);
      try { if (now - statSync(p).mtimeMs > CLAIM_STALE_MS) { const t = p + '.' + process.pid; renameSync(p, t); mine.push(t); } } catch { /* another sender took it */ }
    }
  } catch { /* no folder */ }
  if (existsSync(outbox)) {
    const t = outbox + '.sending-' + process.pid + '-' + now;
    try { renameSync(outbox, t); mine.push(t); } catch { /* another sender took it */ }
  }
  return mine;
}

export async function flushOutbox(kind, outbox, ep, now = Date.now()) {
  const claimed = claim(outbox, now);
  if (!claimed.length) return { sent: 0, left: 0 };
  const rows = claimed.flatMap((f) => { try { return parseLines(readFileSync(f, 'utf8')); } catch { return []; } }).filter((r) => r.id);
  const ok = ep && rows.length ? await sendRows(ep, kind, rows) : new Set();
  const left = rows.filter((r) => !ok.has(r.id));
  if (left.length) appendFileSync(outbox, left.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const f of claimed) { try { unlinkSync(f); } catch { /* gone */ } }
  return { sent: rows.length - left.length, left: left.length };
}

export const legacyId = (line) => 'legacy-' + createHash('sha256').update(line).digest('hex').slice(0, 32);

// The daily files of mod 0.1.10 and before: sent once, then moved into <folder>/sent.
export async function sendLegacy(dir, ep) {
  const moved = {};
  let files = [];
  try { files = readdirSync(dir).filter((f) => LEGACY_FILE.test(f)); } catch { return moved; }
  for (const f of files) {
    const p = join(dir, f);
    let lines;
    try { lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()); } catch { continue; }
    const rows = lines.map((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' ? { id: o.id || legacyId(l), ...o } : null; } catch { return null; } }).filter(Boolean);
    const ok = rows.length ? await sendRows(ep, 'usage', rows) : new Set();
    if (ok.size < rows.length) break;
    mkdirSync(join(dir, 'sent'), { recursive: true });
    try { renameSync(p, join(dir, 'sent', f)); } catch { continue; }
    const machine = String((rows[0] && rows[0].machine) || f.replace(/^.*@/, '').replace(/-\d{4}-\d{2}-\d{2}\.jsonl$/, ''));
    moved[machine] = (moved[machine] || 0) + rows.length;
  }
  if (Object.keys(moved).length) {
    try { appendFileSync(join(dir, 'sent', 'moved.log'), JSON.stringify({ at: new Date().toISOString(), rows: moved }) + '\n'); } catch { /* bookkeeping only */ }
  }
  return moved;
}

async function main() {
  const [kind, outbox] = process.argv.slice(2);
  const li = process.argv.indexOf('--legacy');
  try {
    const ep = endpoint();
    if (kind && outbox) await flushOutbox(kind, outbox, ep);
    if (li > 0 && process.argv[li + 1] && ep) await sendLegacy(process.argv[li + 1], ep);
  } catch { /* the rows stay in the outbox for the next call */ }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
