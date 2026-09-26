// Recall, shared by the brain server (tools/brain-server.mjs) and a local install (tools/embed-server.mjs).
//
// The owner found on 2026-09-26 that a local install ranked with a plain top 5 in hooks/pre-turn.mjs while
// the server ran threshold recall with links, so the product a client installs was not the one measured.
// One copy of the code closes that gap: the caller passes the brain folder, the embedder and the index
// version, and gets the same recall() the server has always run. The body below is moved, not rewritten.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { terms as qterms } from './tokenize.mjs';

// A message this short ("why", "ok do it") carries no topic of its own, so the conversation leads it
// as before: with the message leading, the hand-written case "why" lost its WhatsApp answer (2026-09-26).
// Exported because the callers apply it to the request before calling recall.
export const SHORT_FOLLOW_UP = 25;

export function makeRecall({ brain, getEmbedder, indexVersion }) {
  const BRAIN = brain;
  let idxCache = null;
  function loadIndexes() {
    const v = indexVersion();
    if (idxCache && idxCache.v === v.version) return idxCache;
    idxCache = {
      v: v.version,
      kw: JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8')),
      emb: JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8')),
    };
    return idxCache;
  }

  // Every constant here is measured, and the measurements live in hooks/pre-turn.mjs next to the
  // original. Changing one without re-running tools/eval-recall.mjs is how a tuned system silently
  // detunes itself.
  const RRF_K = 60;
  const SPARSE_MIN = Number(process.env.RECALL_MIN || 0.10);
  const PER_CHANNEL = 20;

  /* RECALL BY THRESHOLD PLUS LINKS, NO CAP. The owner, 2026-09-25: "when I recall, I recall in terms of
     what memories match the context best, not limited to 5 or 2 links", and later the same day, when a cap
     of 12 had crept in: "memories gather is a threshold, not a cap... if it is passing the threshold, we
     bring it. If not, we don't." So every memory passes or fails its OWN fixed bar, and the count is
     whatever passes:
       - the fused top ALWAYS_FUSED (a floor, not a cap: without it a keyword-only hit such as a name or a
         table is lost, and the threshold alone scored WORSE than a fixed top 5);
       - every memory whose meaning match is at least MEANING_BAR;
       - every memory whose activation, spread along the links (personalized PageRank from the fused scores,
         restart 1 - SPREAD), is at least LINK_BAR of the strongest activation.
     The link bar is relative to the STRONGEST, never to the weakest memory already taken: with no cap, a
     weakest-member bar sinks as the list grows, and one prompt pulled in 567 memories, the whole brain.
     Measured offline on 282 of his real questions (eval-multihop.json 115, eval-cases.json plus
     eval-single-real.json 167): top 5 answered 31/115 two-memory and 126/167 single; the capped version
     (9 plus 3 linked) 48 and 132 at 7.8 memories; this one, meaning 0.40 and links 0.6, 51 and 130 at 8.5
     on average (median 7, p90 16, max 41). Links 0.5 gives 56 and 134 at 12.5 on average: the next step
     on the dial. Links computed from meaning added nothing over hand wikilinks but did no harm, so both are
     used. Only the first BODY_HITS carry their body to a machine with no memories: that limits the cost
     of each result, never how many results come back.
     RECALL_MODE=topk brings back the old behaviour. A caller that sends an explicit limit gets top k. */
  const RECALL_MODE = process.env.RECALL_MODE || 'threshold';
  // 0.50 and 0.5 since the vectors include the body start (embed-text.mjs, 2026-09-25): on the 282 real
  // messages, singles 130 to 145 of 167 and two-memory 51 to 59 of 115, about 12 memories a prompt on
  // average (median 10, p90 20, max 49). With body vectors a meaning bar of 0.35 let one prompt pull 160.
  const MEANING_BAR = Number(process.env.RECALL_MEANING_BAR || 0.50);
  const LINK_BAR = Number(process.env.RECALL_LINK_BAR || 0.5);
  /* A LINKED MEMORY MUST BEAT AN EVEN SHARE, scaled by brain size (2026-09-26). In a new brain of 22
     memories nearly everything links to everything, so spreading from weak seeds lifted 11 to 19 of them
     above the relative link bar for "what is the capital of Canada". Activation sums to 1, so 1/N is what
     every memory would hold if it spread evenly; a linked memory now needs LINK_FLOOR times that. Measured:
     on the owner's 632-memory brain 0 to 5 change nothing on any set (single 110/118, two-memory 75/115,
     long 18/46, far 8/30); on the 22-memory fresh brain 1.2 keeps every how-to request found (28/28) with
     about 6 memories on trivial requests, against 15.4 at 0 and 26/28 from 1.6 up. Rejected the same day:
     spreading only from seeds above the meaning bar, which took the owner's two-memory set from 75 to 27. */
  const LINK_FLOOR = Number(process.env.RECALL_LINK_FLOOR || 1.2);
  const ALWAYS_FUSED = 3;
  const CONTEXT_WEIGHT = 0.9;
  const PART_K = 2;
  const BODY_HITS = 5;
  const SPREAD = 0.5;
  const SPREAD_ITERS = 20;
  const MEANING_K = 5;
  const MEANING_FLOOR = 0.55;

  let graphCache = null;
  function linkGraph(emb, version) {
    if (graphCache && graphCache.v === version) return graphCache.g;
    const n = emb.slugs.length;
    const at = new Map(emb.slugs.map((s, i) => [s, i]));
    const g = Array.from({ length: n }, () => new Map());
    const link = (i, j, w) => { if (i === j) return; g[i].set(j, Math.max(g[i].get(j) || 0, w)); g[j].set(i, Math.max(g[j].get(i) || 0, w)); };
    for (const s of emb.slugs) {
      let text = '';
      try { text = readFileSync(join(BRAIN, 'memory', s + '.md'), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)) { const j = at.get(m[1]); if (j !== undefined) link(at.get(s), j, 1); }
    }
    for (let i = 0; i < n; i++) {
      const vi = emb.vectors[i];
      const sims = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const vj = emb.vectors[j]; let d = 0;
        for (let k = 0; k < vi.length; k++) d += vi[k] * vj[k];
        sims.push([j, d]);
      }
      sims.sort((a, b) => b[1] - a[1]);
      for (const [j, d] of sims.slice(0, MEANING_K)) if (d >= MEANING_FLOOR) link(i, j, d);
    }
    graphCache = { v: version, g };
    return g;
  }

  function spreadActivation(seed, g) {
    const total = seed.reduce((a, b) => a + b, 0) || 1;
    const s0 = seed.map((x) => x / total);
    const out = g.map((m) => { let w = 0; for (const v of m.values()) w += v; return w; });
    let s = Float64Array.from(s0);
    for (let t = 0; t < SPREAD_ITERS; t++) {
      const nx = new Float64Array(s.length);
      for (let i = 0; i < s.length; i++) {
        if (!s[i]) continue;
        if (!out[i]) { nx[i] += SPREAD * s[i]; continue; }
        for (const [j, w] of g[i]) nx[j] += SPREAD * s[i] * w / out[i];
      }
      for (let i = 0; i < s.length; i++) nx[i] += (1 - SPREAD) * s0[i];
      s = nx;
    }
    return s;
  }

  async function recall(prompt, queries, limit, bodyChars = 0, explicitLimit = true, parts = 0, contextIndex = -1) {
    const { kw, emb } = loadIndexes();
    let qEmb = null;
    try { qEmb = JSON.parse(readFileSync(join(BRAIN, 'index', 'question-embeddings.json'), 'utf8')); }
    catch { /* no questions written yet, which is the state every brain starts in */ }

    // DENSE, max-pooled across chunks rather than averaged. Taking the best chunk is the entire
    // point; a mean reintroduces exactly the dilution that chunking was added to remove.
    const e = await getEmbedder();
    const best = new Float64Array(emb.slugs.length).fill(-Infinity);
    const queryVectors = [];
    let embedded = 0;
    /* THE MESSAGE LEADS, THE CONVERSATION ADDS (2026-09-26). The hook sends the recent conversation as
       one extra query and says which (contextIndex). Scored with the same weight as the message, the
       conversation's topic pushed the message's own best matches out: tested on 272 real messages with
       their real conversation, two-memory 80 to 72. So the conversation no longer ranks, seeds or feeds
       the keyword-meaning fusion; it only adds memories whose match to it, times CONTEXT_WEIGHT, clears the
       meaning bar. Then: singles 111 to 112, two-memory 80 to 82, and follow-ups like "ok lower it to
       1700" are found. */
    const ctxBest = new Float64Array(emb.slugs.length).fill(-Infinity);
    for (let qi = 0; qi < queries.length; qi++) {
      const o = await e(String(queries[qi]).slice(0, 4000), { pooling: 'mean', normalize: true });
      const qv = o.data;
      queryVectors.push(qv);
      embedded++;
      const target = qi === contextIndex ? ctxBest : best;
      for (let i = 0; i < emb.slugs.length; i++) {
        const v = emb.vectors[i];
        let dot = 0;
        for (let k = 0; k < v.length; k++) dot += qv[k] * v[k];
        if (dot > target[i]) target[i] = dot;
      }
    }
    /* THE QUESTIONS A MEMORY ANSWERS ARE SCORED BESIDE ITS DESCRIPTION, and a memory keeps the better
       of the two. Measured 2026-09-21: "I need to know who did what action" scores 0.144 against the
       description of the memory that answers it and 0.523 against the question itself; "stop writing
       so much" 0.216 against 0.622. A description says what a memory is about, which is not what
       anyone types. Max, never a mean: averaging the two is the dilution this exists to remove.
       The file is optional, so a brain with no questions written behaves exactly as before. */
    const qBest = new Map();
    if (qEmb && qEmb.vectors && qEmb.vectors.length) {
      // The query vectors are already computed above. Embedding each query a second time here cost a
      // measured 42 ms a prompt for an identical vector, which is the kind of waste that looks like
      // the feature being expensive.
      for (const qv of queryVectors) {
        for (let i = 0; i < qEmb.vectors.length; i++) {
          const v = qEmb.vectors[i];
          let dot = 0;
          for (let k = 0; k < v.length; k++) dot += qv[k] * v[k];
          const slug = qEmb.slugs[i];
          if (dot > (qBest.get(slug) ?? -Infinity)) qBest.set(slug, dot);
        }
      }
    }
    const denseRanked = embedded
      ? emb.slugs.map((s, i) => [s, Math.max(best[i], qBest.get(s) ?? -Infinity)])
        .sort((a, b) => b[1] - a[1]).slice(0, PER_CHANNEL)
      : [];

    // SPARSE reads the FULL prompt, capped, never a head slice. The hook learned this the hard way:
    // reusing a 2000-char head returned NOTHING for "how do i log creatine" when 4000 characters of
    // pasted filler came first, and the owner pastes logs and bank messages constantly.
    const words = new Set(qterms(String(prompt).slice(0, 20000).toLowerCase()));
    const score = new Map();
    for (const w of words) {
      const slugs = kw.terms[w];
      if (!slugs) continue;
      const weight = 1 / slugs.length; // rarer term, stronger signal
      for (const s of slugs) score.set(s, (score.get(s) || 0) + weight);
    }
    const sparseRanked = [...score.entries()]
      .filter(([, v]) => v >= SPARSE_MIN)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PER_CHANNEL);

    const fused = new Map();
    sparseRanked.forEach(([s], r) => fused.set(s, (fused.get(s) || 0) + 1 / (RRF_K + r + 1)));
    denseRanked.forEach(([s], r) => fused.set(s, (fused.get(s) || 0) + 1 / (RRF_K + r + 1)));

    const bySparse = new Set(sparseRanked.map(([s]) => s));
    const byDense = new Set(denseRanked.map(([s]) => s));
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
    let chosen = ranked.slice(0, limit).map(([s]) => s);
    const linked = new Set();
    if (RECALL_MODE === 'threshold' && !explicitLimit && embedded) {
      chosen = ranked.slice(0, ALWAYS_FUSED).map(([s]) => s);
      const meaning = emb.slugs.map((s, i) => [s, Math.max(best[i], qBest.get(s) ?? -Infinity, ctxBest[i] * CONTEXT_WEIGHT)])
        .filter(([, v]) => v >= MEANING_BAR).sort((a, b) => b[1] - a[1]);
      for (const [s] of meaning) if (!chosen.includes(s)) chosen.push(s);
      // EACH PART OF A MESSAGE BRINGS ITS OWN BEST MEMORIES (2026-09-26). The hook sends the whole message
      // first, then its parts (queries 1..parts), then the conversation. A long message touches many topics,
      // and a part's best memory often scores 0.34 to 0.47, under the shared meaning bar. Offline on the real
      // sets: long messages 17 to 19 of 46 (pieces 98 to 104 of 142), two-memory 77 to 80 of 115, about one
      // more memory a prompt.
      for (let qi = 1; qi <= Math.min(parts, queryVectors.length - 1); qi++) {
        const qv = queryVectors[qi];
        emb.vectors.map((v, i) => { let d = 0; for (let k = 0; k < v.length; k++) d += qv[k] * v[k]; return [emb.slugs[i], d]; })
          .sort((a, b) => b[1] - a[1]).slice(0, PART_K)
          .forEach(([s]) => { if (!chosen.includes(s)) chosen.push(s); });
      }
      const at = new Map(emb.slugs.map((s, i) => [s, i]));
      const seed = new Array(emb.slugs.length).fill(0);
      for (const [s, v] of fused) if (at.has(s)) seed[at.get(s)] = v;
      const act = spreadActivation(seed, linkGraph(emb, idxCache.v));
      let strongest = 0;
      for (const v of act) if (v > strongest) strongest = v;
      emb.slugs.map((s, i) => [s, act[i]])
        .filter(([s, v]) => !chosen.includes(s) && v > 0 && v >= strongest * LINK_BAR && v >= LINK_FLOOR / emb.slugs.length)
        .sort((a, b) => b[1] - a[1])
        .forEach(([s]) => { chosen.push(s); linked.add(s); });
    }
    return chosen
      .map((slug, rank) => {
        const hit = {
          slug,
          how: linked.has(slug) ? 'linked' : bySparse.has(slug) && byDense.has(slug) ? 'both' : byDense.has(slug) ? 'meaning' : 'keyword',
          description: kw.descriptions[slug] || '',
        };
        /* THE BODY TRAVELS WITH THE HIT WHEN THE CALLER ASKS. The owner, 2026-09-21: "local recall, and
           local brain copy is not an option." With no copy anywhere, a machine that gets slugs and
           descriptions has to ask again for the thing it actually needs, 216 ms per memory measured,
           and an agent under time pressure answers from the description instead. That is the single
           failure the recall system exists to prevent, so the body comes down with the ranking.
           Frontmatter is stripped: name and description are already in the hit, and repeating them
           would spend a fifth of the budget saying what was just said. */
        if (bodyChars > 0 && rank < BODY_HITS) {
          try {
            const raw = readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8').replace(/\r\n/g, '\n');
            const afterFm = raw.startsWith('---') ? raw.slice(Math.max(raw.indexOf('\n---', 3) + 4, 0)) : raw;
            const body = afterFm.trim();
            hit.chars = body.length;
            hit.body = body.slice(0, bodyChars);
            hit.truncated = body.length > bodyChars;
          } catch { /* a hit whose file vanished mid-request is still a useful slug */ }
        }
        return hit;
      });
  }
  return recall;
}
