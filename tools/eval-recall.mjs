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
  ['which model should I use for this', ['feedback_best_model_for_each_task']],
  ['how do I brief an agent running in the background', ['feedback_sub_agents_get_a_ready_brief']],
  ['there are two notes saying different things about the same fact', ['feedback_one_fact_one_memory']],
  // The how-to memories (kit/memory), asked the way a person would, never with the memory's own title.
  ['make me some slides for the investor meeting on friday', ['reference_how_to_make_a_presentation_deck']],
  ['turn this into a clean pdf report I can print and send', ['reference_how_to_make_a_printable_document']],
  ['can you draft a proposal for the new client', ['reference_how_to_write_a_document']],
  ['find out which accounting software is best for a small shop and how much it costs', ['reference_how_to_research_with_sources']],
  ['split this into parallel agents so it goes faster', ['reference_how_to_brief_sub_agents_and_pick_models']],
  ['remember that my accountant is called Sara', ['reference_how_to_save_a_memory']],
  ['build the export feature for the app', ['reference_how_to_plan_test_and_verify']],
  ['the script crashes with a null error every time I run it', ['reference_how_to_debug_systematically']],
  ['is the analysis finished and correct, can I send it', ['reference_how_to_review_work_before_calling_it_done']],
  ['I want to lose 5 kilos before summer', ['reference_how_to_set_and_follow_a_goal']],
  ['prep me for my call with the supplier tomorrow', ['reference_how_to_handle_meetings_and_follow_ups']],
  ['set up a folder to track my job applications', ['reference_how_to_start_a_new_project']],
  ['change your name and answer me in french from now on', ['reference_how_to_set_up_the_assistant']],
  ['I keep asking you to do the weekly report the same way, keep that', ['reference_how_to_turn_a_repeated_task_into_a_method']],
];
// --multihop scores the questions whose answer needs SEVERAL memories (eval-multihop.json, real
// questions from the owner's transcripts, 2026-09-25). A case counts only when EVERY expected memory
// comes back, because half an answer to a two-part question is how a wrong answer gets stated as fact.
// --cases <file> runs any case file with the same all-must-be-found scoring (long messages, far-apart sets).
const casesFlag = process.argv.indexOf('--cases');
const CASES_FILE = casesFlag > -1 ? process.argv[casesFlag + 1] : null;
const MULTIHOP = process.argv.includes('--multihop') || !!CASES_FILE;
// --real scores single-memory questions taken from the owner's own transcripts (eval-single-real.json,
// labelled 2026-09-25), beside the hand-written eval-cases.json the constants were tuned on.
const REAL = process.argv.includes('--real');
export const CASES = CASES_FILE ? JSON.parse(__rf(CASES_FILE, 'utf8'))
  : MULTIHOP
  ? JSON.parse(__rf(__jn(__BRAIN, 'eval-multihop.json'), 'utf8'))
  : REAL ? JSON.parse(__rf(__jn(__BRAIN, 'eval-single-real.json'), 'utf8'))
  : __ex(__jn(__BRAIN, 'eval-cases.json'))
    ? JSON.parse(__rf(__jn(__BRAIN, 'eval-cases.json'), 'utf8'))
    : GENERIC_CASES;

let hits = 0, misses = [], totalMs = 0, totalTokens = 0, silent = 0, returnedTotal = 0, pieces = 0, piecesFound = 0;

// A case may carry a THIRD element: the conversation that came before it. A short follow-up like
// "who did what action" is meaningless on its own, and recall that only sees the prompt matches the
// wrong topic entirely. Cases without it behave exactly as before.
// PACED, because the brain server allows 120 requests a minute per address and each prompt costs
// the hook two or three. Unpaced, the run passed that limit after about 20 prompts, the server
// answered 429, the hook fell back to its local top 5 without a word, and the benchmark measured
// the fallback instead of the recall it was run to test (2026-09-25, the threshold change looked
// like 13 of 28 when the server was answering 7 memories to the hand-run prompt). --pace 0 for a
// machine with a local index and no server.
const paceFlag = process.argv.indexOf('--pace');
const PACE_MS = paceFlag > -1 ? Number(process.argv[paceFlag + 1]) : 1600;
const pause = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

for (const [q, expected, context] of CASES) {
  pause(PACE_MS);
  const t0 = Date.now();
  const payload = context ? { prompt: q, context } : { prompt: q };
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
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
    .map((l) => l.slice(2).replace(/^\[(keyword|meaning|both|linked)\]\s*/, '').split(':')[0].trim());
  if (!returned.length) silent++;
  returnedTotal += returned.length;
  pieces += expected.length;
  piecesFound += expected.filter((e) => returned.includes(e)).length;
  const hit = MULTIHOP ? expected.every((e) => returned.includes(e)) : expected.some((e) => returned.includes(e));
  if (hit) hits++;
  else misses.push({ q, expected, returned });
}

const n = CASES.length;
console.log(`queries          ${n}`);
console.log(`${MULTIHOP ? 'all found       ' : 'recall@5        '} ${hits}/${n} = ${(100 * hits / n).toFixed(1)}%`);
console.log(`memories         ${(returnedTotal / n).toFixed(1)} avg per prompt`);
if (MULTIHOP) console.log(`pieces found     ${piecesFound}/${pieces} = ${(100 * piecesFound / pieces).toFixed(1)}%`);
console.log(`returned nothing ${silent}`);
console.log(`latency          ${(totalMs / n).toFixed(0)}ms avg per prompt`);
console.log(`injected         ${Math.round(totalTokens / n)} tokens avg per prompt`);
console.log(`\nMISSES (${misses.length}):`);
for (const m of misses) {
  console.log(`  "${m.q}"`);
  console.log(`     wanted : ${m.expected.join(' | ')}`);
  console.log(`     got    : ${m.returned.length ? m.returned.join(', ') : '(nothing)'}`);
}
