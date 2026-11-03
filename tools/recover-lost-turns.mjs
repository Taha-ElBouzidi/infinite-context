#!/usr/bin/env node
// RECOVER TURNS A RESUME DROPPED (DEV 2, the locked-down client machine, 2026-11-03). Before mod 0.1.32 the re-apply at session start could
// drop every turn written since the last clean-up: those rows stay in the session file, off the live chain. This
// writes a NEW session file (new session id, the original is only read) whose chain is the live one with the lost
// turns put back in time order, so the agent can be resumed on it with `--resume <new id>`.
//
//   node tools/recover-lost-turns.mjs --file <copy of session.jsonl> --since <ISO time> [--out <dir>] [--dry-run]
//
// --since: the time of the last real clean-up before the lost work (the turns after it are the candidates). Rows off
// the live chain written after --since come back, except compaction rows and rows whose content the live chain already
// holds (the copies each re-apply made). They are inserted before the first live row written after --since, and the
// whole chain is relinked in order. --dry-run prints what would be done and writes nothing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAIN = new Set(['user', 'assistant']);
const time = (r) => Date.parse(r.timestamp || '') || 0;
const contentKey = (r) => createHash('sha1').update(String(r.type) + '|' + JSON.stringify(r.message?.content ?? '')).digest('hex');
const textOf = (r) => {
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_use' ? '[tool ' + p.name + ']' : p.type === 'tool_result' ? '[result]' : '')).join(' ');
  return '';
};

export function planRecovery(lines, since) {
  const rows = [];
  for (const l of lines) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* a torn line */ } }
  const byId = new Map(rows.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  // The live chain: from the last main row of the file back through parentUuid.
  let leaf = null;
  for (let i = rows.length - 1; i >= 0; i--) if (MAIN.has(rows[i].type) && !rows[i].isSidechain && rows[i].uuid) { leaf = rows[i]; break; }
  if (!leaf) return { ok: false, reason: 'no main row in the file' };
  const chain = [];
  const seen = new Set();
  for (let r = leaf; r && !seen.has(r.uuid); r = r.parentUuid ? byId.get(r.parentUuid) : null) { seen.add(r.uuid); chain.unshift(r); }
  const onChain = new Set(chain.map((r) => r.uuid));
  const held = new Set(chain.map(contentKey));
  const lost = [];
  for (const r of rows) {
    if (!MAIN.has(r.type) || r.isSidechain || !r.uuid || onChain.has(r.uuid)) continue;
    if (time(r) < since || r.isCompactSummary || r.isMeta) continue;
    const k = contentKey(r);
    if (held.has(k)) continue;
    held.add(k);
    lost.push(r);
  }
  lost.sort((a, b) => time(a) - time(b));
  let at = chain.findIndex((r, i) => i > 0 && MAIN.has(r.type) && time(r) >= since);
  if (at < 0) at = chain.length;
  const result = [...chain.slice(0, at), ...lost, ...chain.slice(at)];
  return { ok: true, chain, lost, at, result };
}

function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const file = arg('--file');
  const since = Date.parse(arg('--since') || '');
  if (!file || !existsSync(file) || !Number.isFinite(since)) { console.error('usage: --file <copy of session.jsonl> --since <ISO time> [--out <dir>] [--dry-run]'); process.exit(2); }
  const plan = planRecovery(readFileSync(file, 'utf8').split(/\r?\n/), since);
  if (!plan.ok) { console.error(plan.reason); process.exit(1); }
  console.log(`live chain: ${plan.chain.length} rows (${plan.chain[0]?.timestamp} to ${plan.chain.at(-1)?.timestamp})`);
  console.log(`lost rows to put back: ${plan.lost.length}, inserted before live row ${plan.at + 1}`);
  const est = (list) => Math.round(list.reduce((n, r) => n + JSON.stringify(r.message?.content ?? '').length, 0) / 3.5);
  console.log(`conversation size, estimated: live chain about ${est(plan.chain)} tokens, after recovery about ${est(plan.result)} tokens`);
  for (const r of plan.lost) if (r.type === 'user' && typeof r.message?.content === 'string') console.log(`  ${r.timestamp} user: ${r.message.content.replace(/\s+/g, ' ').slice(0, 80)}`);
  for (const r of plan.lost.filter((x) => x.type === 'user' && Array.isArray(x.message?.content) && x.message.content.some((p) => p.type === 'text'))) console.log(`  ${r.timestamp} user: ${textOf(r).replace(/\s+/g, ' ').slice(0, 80)}`);
  if (process.argv.includes('--dry-run')) return;
  const id = randomUUID();
  let parent = null;
  const out = plan.result.map((r) => { const n = { ...r, sessionId: id, parentUuid: parent }; parent = r.uuid; return JSON.stringify(n); });
  const dest = join(arg('--out') || dirname(file), id + '.jsonl');
  writeFileSync(dest, out.join('\n') + '\n', 'utf8');
  console.log(`written: ${dest}`);
  console.log(`resume it with: claude --resume ${id}  (from the same project folder; the original ${basename(file)} is unchanged)`);
}

if (process.argv[1] && process.argv[1].split(String.fromCharCode(92)).join('/').endsWith('tools/recover-lost-turns.mjs')) main();
