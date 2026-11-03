// Turn recall, shared by hooks/pre-turn.mjs and the brain server's POST /recall/turn (context release, 2026-11-02).
//
// The query building below was in hooks/pre-turn.mjs and is moved, not rewritten: the hook imports it, so it gives
// the same output until it is retired, and the server runs the same code for the mod, which asks for recall in one
// request per message. The measurements behind each step are in the comments, kept with the code they justify.
//
// The server side (makeRecallTurn) also keeps what pre-turn.mjs kept on each machine's disk: which memories a
// session was already shown. Amendment 4 of the release plan (HAVOK, 2026-11-02): the old "shown earlier in this
// conversation" line repeated up to about 100 names on every message; now an earlier memory is kept only when the
// current message still matches it itself (not through a link or only through the conversation), and it comes back
// with its description.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { terms as qterms } from './tokenize.mjs';
import { layerVersions } from './layer-host.mjs';
import { releaseSummary } from './release-host.mjs';

// Recent conversation, for recall only. Capped hard: it is a topic hint, not a second prompt, and an unbounded tail
// would push the question out of the way exactly as a long paste does.
export const CONTEXT_CHARS = 700;

// Skip the harness noise: hook injections and tool dumps are not what the turn is about.
export const HARNESS_NOISE = /HOW TO REPLY|BRAIN RECALL|system-reminder|<function_/i;

// One message as the hook reads it from the transcript: whitespace folded, too short or harness text skipped, the
// first 400 characters kept. Returns '' for a message that does not count.
export function contextMessage(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 12) return '';
  if (HARNESS_NOISE.test(t)) return '';
  return t.slice(0, 400);
}

// The server is sent the last user messages instead of a transcript: newest first until there is enough, then the
// last CONTEXT_CHARS, the same steps the hook applies to the transcript.
export function contextFromPrevious(previous) {
  const msgs = [];
  const list = Array.isArray(previous) ? previous.filter((x) => typeof x === 'string') : [];
  for (let i = list.length - 1; i >= 0 && msgs.join(' ').length < CONTEXT_CHARS * 2; i -= 1) {
    const m = contextMessage(list[i]);
    if (m) msgs.unshift(m);
  }
  return msgs.join(' ').slice(-CONTEXT_CHARS);
}

// A background-task or system notification arrives like a prompt, but it is not a question: on 2026-09-26 one
// pulled 40 memories of noise.
export const isSystemEvent = (prompt) => String(prompt).trimStart().startsWith('<task-notification>') || String(prompt).includes('[SYSTEM NOTIFICATION - NOT USER INPUT]');

export const hasArabicText = (text) => /[؀-ۿݐ-ݿ]/.test(text);

// Translate a non-English prompt with the local claude CLI.
//
// Deliberately the smallest possible invocation: haiku, no MCP, no skills, no tools, and its
// own system prompt file so it cannot inherit the brain hooks. Without --system-prompt-file
// the call picked up this very brain and ANSWERED the question instead of translating it.
export function translateSync(text, brainDir) {
  try {
    const sys = join(brainDir, 'index', 'translate-system.txt');
    if (!existsSync(sys)) return null;
    const out = execFileSync('claude', [
      '-p', '--model', 'haiku', '--output-format', 'json',
      '--system-prompt-file', sys,
      '--strict-mcp-config', '--disable-slash-commands',
      '--disallowed-tools', 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task Agent TodoWrite Monitor Skill SlashCommand',
    ], {
      input: Buffer.from(text, 'utf8'),
      encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const r = JSON.parse(out || '{}').result;
    return (typeof r === 'string' && r.trim() && r.length < 500) ? r.trim() : null;
  } catch { return null; }
}

// CHUNK a long prompt instead of averaging it into one vector.
//
// Found 2026-08-22 by watching a live prompt from a laptop client log as chars=2000 exactly,
// which is a cap and not a coincidence. Sending MORE text does not fix it. Measured on a
// 2402-char prompt whose question started at char 2341, target memories at:
//   head 2000 (the shipped behaviour) : rank 74 and 37
//   head 2000 + tail 2000             : rank 68 and 38
//   tail 500 alone                    : rank 10 and  5
//   the question with no paste at all : rank  1 and  3
// One 384-dim vector cannot represent a long paste AND a short question: the mean washes the question out.
// So: split into sentence-packed chunks and take each memory's BEST-matching chunk rather than its similarity to
// the average. Measured: paste then question rank 1 and 5 (was 74 and 37); question then paste rank 4 and 9 (was
// 19 and 13). Chunking only happens above 2000 chars, at most 10 calls.
const CHUNK_CHARS = 400, MAX_CHUNKS = 8;
export function chunkPrompt(text) {
  const parts = text.split(/(?<=[.!?\n])\s+/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).length > CHUNK_CHARS && cur) { out.push(cur.trim()); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur.trim()) out.push(cur.trim());
  let kept = out;
  if (out.length > MAX_CHUNKS) {
    const end = Math.ceil(MAX_CHUNKS / 2);
    kept = [...out.slice(0, MAX_CHUNKS - end), ...out.slice(-end)];
  }
  // The packer glues short sentences together until a chunk is full, which buries a 62-char question inside 400
  // chars of paste. Embed the first and last SENTENCE on their own too, because that is where a question actually
  // lives. Without this, the "question then paste" shape scored 0 of 2; with it, 1 of 2.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 1) {
    for (const edge of [sentences[0], sentences[sentences.length - 1]]) {
      if (edge.length >= 12 && edge.length <= CHUNK_CHARS && !kept.includes(edge)) kept.push(edge);
    }
  }
  return kept;
}

// A short message that mixes topics ("log my lunch, also did a client pay") is split into its parts, each searched on
// its own beside the whole, and each memory keeps its best score. Measured 2026-09-25 on 30 messages each needing 2
// to 4 unrelated memories: fully answered 8 to 15, and on the 280 real questions two-memory 75 to 77, singles 157 to
// 158, with no more memories returned.
export function splitParts(t) {
  const parts = String(t).split(/(?<=[.?!])\s+|\s+(?:also|and also|et aussi|aussi|btw|plus)\s+|,\s+(?:and|et)\s+|;\s+/i)
    .map((s) => s.trim()).filter((s) => s.length >= 15);
  return parts.length > 1 ? parts.slice(0, 8) : [];
}

// The queries one prompt is recalled with. The conversation is an EXTRA query, never a replacement: scoring takes
// the best chunk, so a prompt that names its own subject keeps winning on its own chunk, and a bare follow-up gains
// a second chance through the topic it sits in.
// Arabic: the model is English-only by choice and scores near zero on Arabic, so the prompt is translated first
// (measured 2026-08-19: a multilingual model and transliteration both made it worse). The translation costs about
// 5.5 s, paid only on an Arabic prompt. If it fails, the brain is not consulted and the note says so.
export function prepareQueries(prompt, recentContext, { translate } = {}) {
  const hasArabic = hasArabicText(prompt);
  let queryText = prompt.slice(0, 2000);
  let note = '';
  if (hasArabic) {
    const translated = translate ? translate(queryText) : null;
    if (translated) {
      queryText = translated;
      note = "NOTE: your prompt was in Arabic. It was translated to English for recall (\"" + translated.slice(0, 80) + "\"). If that translation is wrong, the memories below are the wrong ones.";
    } else {
      note = "NOTE: this prompt is in Arabic and the translation step failed, so the brain was NOT consulted. Ask again in English or French, or tell the owner the brain was not searched for this one.";
    }
  }
  const baseQueries = (!hasArabic && prompt.length > 2000) ? chunkPrompt(prompt) : [queryText, ...(hasArabic ? [] : splitParts(queryText))];
  const queries = (!hasArabic && recentContext) ? baseQueries.concat([recentContext]) : baseQueries;
  const translationFailed = hasArabic && queryText === prompt.slice(0, 2000);
  return {
    hasArabic, queryText, note, translationFailed, baseQueries, queries,
    parts: baseQueries.length - 1,
    contextIndex: queries.length > baseQueries.length ? baseQueries.length : -1,
  };
}

// Keyword-only ranking from index/keywords.json, as the hook did with no server and no daemon: rarer terms weigh
// more, 0.10 the measured bar (tools/eval-recall.mjs sweep, 2026-08-18), top 5.
export function keywordRecall(kw, text, limit = 5) {
  const score = new Map();
  for (const w of new Set(qterms(String(text).slice(0, 20000).toLowerCase()))) {
    const slugs = kw && kw.terms ? kw.terms[w] : null;
    if (!slugs) continue;
    const weight = 1 / slugs.length;
    for (const s of slugs) score.set(s, (score.get(s) || 0) + weight);
  }
  return [...score.entries()]
    .filter(([, v]) => v >= Number(process.env.RECALL_MIN || 0.10))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([slug]) => ({ slug, how: 'keyword', direct: true, description: (kw.descriptions && kw.descriptions[slug]) || '' }));
}

const SESSION = /^[A-Za-z0-9_-]{6,80}$/;
const STATE_KEEP_MS = 7 * 24 * 3600 * 1000;
const SHORT_FOLLOW_UP_DEFAULT = 25;

// The server's turn recall. recall is recall-core's recall(); stateDir holds one small file per session (the slugs
// shown so far), pruned after 7 days; layersDir is the layer host folder; releasesDir the release host folder.
export function makeRecallTurn({ brain, recall, layersDir, releasesDir, stateDir, translate, shortFollowUp = SHORT_FOLLOW_UP_DEFAULT }) {
  let lastPrune = 0;
  const stateFile = (sid) => join(stateDir, sid + '.json');
  function readShown(sid) {
    try { return JSON.parse(readFileSync(stateFile(sid), 'utf8')); } catch { return []; }
  }
  function writeShown(sid, list) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(stateFile(sid), JSON.stringify(list));
      if (Date.now() - lastPrune > 3600 * 1000) {
        lastPrune = Date.now();
        for (const f of readdirSync(stateDir)) {
          try { if (Date.now() - statSync(join(stateDir, f)).mtimeMs > STATE_KEEP_MS) unlinkSync(join(stateDir, f)); } catch { /* raced */ }
        }
      }
    } catch { /* remembering what was shown must never cost the turn its recall */ }
  }
  const keywords = () => { try { return JSON.parse(readFileSync(join(brain, 'index', 'keywords.json'), 'utf8')); } catch { return { terms: {}, descriptions: {} }; } };

  return async function recallTurn(body) {
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const sid = SESSION.test(String(body.session || '')) ? String(body.session) : null;
    const answer = { memories: [], droppedEarlier: [], note: '' };
    if (body.machine) answer.layers = layerVersions(layersDir, String(body.machine), Array.isArray(body.groups) ? body.groups.map(String) : []);
    // The latest release rides the same answer (task 18): the machine's main agent learns of it on its next message.
    const release = body.machine && releasesDir ? releaseSummary(releasesDir) : null;
    if (release) answer.release = release;
    if (!prompt.trim() || isSystemEvent(prompt)) return answer;

    const prep = prepareQueries(prompt, contextFromPrevious(body.previous), { translate: translate ? (t) => translate(t) : null });
    answer.note = prep.note;
    if (prep.translationFailed) return answer;

    const bodyChars = body.bodies ? 1500 : 0;
    let hits;
    try {
      hits = await recall(prompt, prep.queries, 5, bodyChars, false, Math.max(0, Math.min(prep.parts, 16)),
        prompt.trim().length >= shortFollowUp ? prep.contextIndex : -1);
      // Recall answered from the keyword channel alone because the embedder failed or ran out of time (recall-core).
      if (hits.degraded) answer.note = (answer.note ? answer.note + ' ' : '') + 'NOTE: semantic recall missed this turn, so the recall below is keyword only and a paraphrase may not match. Why: '
        + hits.degraded + '.';
    } catch (e) {
      // Recall needs the embedder; with it down the turn still gets the keyword channel, and says so.
      hits = keywordRecall(keywords(), prep.contextIndex >= 0 ? prep.queries[prep.contextIndex] + ' ' + prompt : prompt);
      answer.note = (answer.note ? answer.note + ' ' : '') + 'NOTE: semantic recall missed this turn, so the recall below is keyword only and a paraphrase may not match. Why: '
        + String((e && e.message) || e).slice(0, 120) + '.';
    }

    const shown = sid ? readShown(sid) : [];
    const before = new Set(shown);
    const earlier = [];
    for (const h of hits) {
      if (!h || !h.slug) continue;
      const m = { slug: h.slug, description: h.description || '', why: h.how || 'keyword' };
      for (const k of ['body', 'chars', 'truncated']) if (h[k] !== undefined) m[k] = h[k];
      if (before.has(h.slug)) {
        if (h.direct === false) { answer.droppedEarlier.push(h.slug); continue; }
        m.why = 'earlier';
        earlier.push([m, typeof h.match === 'number' ? h.match : -Infinity]);
        continue;
      }
      answer.memories.push(m);
    }
    // Stable sort: equal matches (or none, on the keyword path) keep recall's own order.
    earlier.sort((a, b) => b[1] - a[1]);
    // No fixed count (The owner, feedback_recall_is_limitless): the re-match above is the threshold each earlier memory
    // passes or fails on its own; every one that still matches the message stays (HAVOK, 2026-11-02).
    for (const [m] of earlier) answer.memories.push(m);
    if (sid) writeShown(sid, [...new Set([...shown, ...hits.filter((h) => h && h.slug).map((h) => h.slug)])]);
    return answer;
  };
}
