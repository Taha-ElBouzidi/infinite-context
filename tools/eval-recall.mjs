// Measures the recall hook against a fixed query set. node tools/eval-recall.mjs
//
// Exists because "the retrieval feels fine" is not a claim anyone can check, and because a
// change that looks obviously good can make things worse: body-text indexing was tried on
// 2026-08-07, looked like a strict improvement, and degraded both precision and recall. That
// was caught by hand. This makes it catchable by running one command.
//
// Queries are phrased the way the owner actually types, including the terse and misspelled ones,
// because a benchmark written in tidy English measures a system he does not use.
//
// EXPECTED is the memory that SHOULD come back. Where more than one is defensible, any of them
// counts as a hit; the point is whether the right knowledge surfaces, not exact ranking.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(BRAIN, 'hooks', 'pre-turn.mjs');

// The query set is CONTENT, not engine. This brain keeps its own in eval-cases.json, which is
// instance data and is never exported. A fresh install evaluates against the five seed rules
// with the generic cases below, so the tool is meaningful on any brain and ships nothing
// personal. Split on 2026-09-05 when the owner's real contacts and clients were found inline here.
import { existsSync as __ex, readFileSync as __rf } from 'node:fs';
import { fileURLToPath as __fu } from 'node:url';
import { dirname as __dn, resolve as __rs, join as __jn } from 'node:path';
const __BRAIN = __rs(__dn(__fu(import.meta.url)), '..');
const GENERIC_CASES = [
  ['do not say it is fixed before testing it', ['feedback_verify_before_claiming']],
  ['tell me straight away when memory is unreachable', ['feedback_say_when_the_brain_is_down']],
  ['open the memory file instead of the one line summary', ['feedback_open_the_memory_not_the_description']],
  ['save what you learn as you learn it', ['feedback_write_it_the_moment_you_learn_it']],
  ['just do it if it can be undone, ask if it cannot', ['feedback_reversible_act_irreversible_ask']],
];
export const CASES = __ex(__jn(__BRAIN, 'eval-cases.json'))
  ? JSON.parse(__rf(__jn(__BRAIN, 'eval-cases.json'), 'utf8'))
  : GENERIC_CASES;

let hits = 0, misses = [], totalMs = 0, totalTokens = 0, silent = 0;

for (const [q, expected] of CASES) {
  const t0 = Date.now();
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ prompt: q }), encoding: 'utf8' });
  const ms = Date.now() - t0;
  totalMs += ms;

  let ctx = '';
  try { ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || ''; } catch { /* none */ }
  totalTokens += Math.round(ctx.length / 4);

  // Strip the channel tag. pre-turn.mjs started prefixing every hit with [keyword], [meaning] or
  // [both] on 2026-08-22, and this parser silently reported 0/40 because it was comparing
  // "[both] feedback_havok_is_pm" against "feedback_havok_is_pm". The eval looked like a total
  // recall collapse when nothing about recall had changed, which is the most expensive kind of
  // false alarm: it invites "fixing" retrieval that was never broken.
  const returned = ctx.split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/^\[(keyword|meaning|both)\]\s*/, '').split(':')[0].trim());
  if (!returned.length) silent++;
  const hit = expected.some((e) => returned.includes(e));
  if (hit) hits++;
  else misses.push({ q, expected, returned });
}

const n = CASES.length;
console.log(`queries          ${n}`);
console.log(`recall@5         ${hits}/${n} = ${(100 * hits / n).toFixed(1)}%`);
console.log(`returned nothing ${silent}`);
console.log(`latency          ${(totalMs / n).toFixed(0)}ms avg per prompt`);
console.log(`injected         ${Math.round(totalTokens / n)} tokens avg per prompt`);
console.log(`\nMISSES (${misses.length}):`);
for (const m of misses) {
  console.log(`  "${m.q}"`);
  console.log(`     wanted : ${m.expected.join(' | ')}`);
  console.log(`     got    : ${m.returned.length ? m.returned.join(', ') : '(nothing)'}`);
}
