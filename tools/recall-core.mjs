// Recall, shared by the brain server (tools/brain-server.mjs) and a local install (tools/embed-server.mjs).
//
// The owner found on 2026-09-26 that a local install ranked with a plain top 5 in hooks/pre-turn.mjs while
// the server ran threshold recall with links, so the product a client installs was not the one measured.
// One copy of the code closes that gap: the caller passes the brain folder, the embedder and the index
// version, and gets the same recall() the server has always run. The body below is moved, not rewritten.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { terms as qterms } from './tokenize.mjs';

// A message this short ("why", "ok do it") carries no topic of its own, so the conversation leads it
// as before: with the message leading, the hand-written case "why" lost its WhatsApp answer (2026-09-26).
// Exported because the callers apply it to the request before calling recall.
export const SHORT_FOLLOW_UP = 25;

export function makeRecall({ brain, getEmbedder, indexVersion }) {
  const BRAIN = brain;

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
  // The whole message must be embedded within this, or recall answers keyword only. The hook gives /recall 9 s in all.
  const EMBED_BUDGET_MS = Number(process.env.RECALL_EMBED_BUDGET_MS || 6000);

  let partBar = null, partLinkBar = null;

  /* NO FREEZE WHEN THE INDEX CHANGES (2026-10-31, the owner: "we need to fix the freeze"). Recall reads one snapshot
     of everything it needs (keywords, vectors, link graph, contacts) that belongs to one index version. When the
     version changes, the next snapshot is built in the background, the link graph on a worker thread (it was 1.8 s
     on the only thread, 17.7 s under load, and every request of the brain server waited behind it), and recall
     keeps answering from the current snapshot until the new one is complete; then it takes over in one step. Only
     the very first recall after a start waits for a build. A worker that fails falls back to the old way on this
     thread, so recall never stops working, and says so on stderr. */
  let current = null, currentSeq = 0, building = null, buildSeq = 0;
  function graphFromEdges(n, from, to, weight) {
    const g = Array.from({ length: n }, () => new Map());
    for (let e = 0; e < from.length; e++) g[from[e]].set(to[e], weight[e]);
    return g;
  }
  // A worker that never answers, or exits without answering, was waited on forever: the first recall after a start
  // never returned (audit 2026-11-01, tools/recall-snapshot.test.mjs). Far above the 17.7 s measured under load.
  const GRAPH_TIMEOUT_MS = Number(process.env.RECALL_GRAPH_TIMEOUT_MS || 120000);
  function graphInWorker(emb) {
    const n = emb.slugs.length;
    const dim = n ? emb.vectors[0].length : 0;
    const vectors = new Float64Array(n * dim);
    for (let i = 0; i < n; i++) vectors.set(emb.vectors[i], i * dim);
    return new Promise((ok, fail) => {
      const w = new Worker(new URL('./recall-graph-worker.mjs', import.meta.url), {
        workerData: { brain: BRAIN, slugs: emb.slugs, dim, vectors, meaningK: MEANING_K, meaningFloor: MEANING_FLOOR },
        transferList: [vectors.buffer],
      });
      const timer = setTimeout(() => { w.terminate(); fail(new Error('graph worker gave no answer in ' + GRAPH_TIMEOUT_MS + ' ms')); }, GRAPH_TIMEOUT_MS);
      w.once('message', (m) => { clearTimeout(timer); ok({ graph: graphFromEdges(n, m.from, m.to, m.weight), contacts: new Map(m.contacts) }); });
      w.once('error', (e) => { clearTimeout(timer); fail(e); });
      // After an answer this settles nothing; before one it is a failure whatever the exit code.
      w.once('exit', (code) => { clearTimeout(timer); fail(new Error('graph worker exited with code ' + code + ' before answering')); });
    });
  }
  async function buildSnapshot(v) {
    const [kwRaw, embRaw] = await Promise.all([
      readFile(join(BRAIN, 'index', 'keywords.json'), 'utf8'),
      readFile(join(BRAIN, 'index', 'embeddings.json'), 'utf8'),
    ]);
    const kw = JSON.parse(kwRaw);
    const emb = JSON.parse(embRaw);
    let parts;
    try { parts = await graphInWorker(emb); }
    catch (e) {
      process.stderr.write('recall: graph worker failed (' + String(e && e.message).slice(0, 160) + '), building on the main thread\n');
      parts = { graph: linkGraph(emb), contacts: contactsByFirstName(emb) };
    }
    return { v, kw, emb, graph: parts.graph, contacts: parts.contacts };
  }
  async function snapshot() {
    const v = indexVersion().version;
    if (current && current.v === v) return current;
    // ONE BUILD AT A TIME (audit 2026-11-01): every new version seen started another full build beside the running
    // one, 13 workers at once in a probe of a save burst. A newer version now waits for the running build; the first
    // recall after it ends starts the next one.
    if (!building) {
      const seq = ++buildSeq;
      const promise = buildSnapshot(v).then((s) => {
        if (seq > currentSeq) { current = s; currentSeq = seq; }
        return s;
      }).finally(() => { if (building && building.seq === seq) building = null; });
      building = { v, seq, promise };
      // A background build that fails is not this request's problem; the next request tries again.
      if (current) promise.catch((e) => process.stderr.write('recall: index rebuild failed (' + String(e && e.message).slice(0, 160) + ')\n'));
    }
    if (current) return current;
    return building.promise;
  }

  // The same work as the worker, on this thread: only the fallback when a worker cannot run.
  function linkGraph(emb) {
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
    return g;
  }

  // First name to contact memories, built once per snapshot (the fallback twin of the worker's map).
  function contactsByFirstName(emb) {
    const map = new Map();
    for (const s of emb.slugs.filter((x) => x.startsWith('contact_'))) {
      let nm = '';
      try { nm = (readFileSync(join(BRAIN, 'memory', s + '.md'), 'utf8').match(/^name:\s*(.*)$/m) || [])[1] || ''; } catch { /* gone */ }
      const first = (nm.replace(/^contact_/, '').split(/[\s,_-]+/)[0] || '').toLowerCase();
      if (first.length >= 3) map.set(first, (map.get(first) || []).concat([s]));
    }
    return map;
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
    const snap = await snapshot();
    const { kw, emb } = snap;
    let qEmb = null;
    try { qEmb = JSON.parse(readFileSync(join(BRAIN, 'index', 'question-embeddings.json'), 'utf8')); }
    catch { /* no questions written yet, which is the state every brain starts in */ }

    // DENSE, max-pooled across chunks rather than averaged. Taking the best chunk is the entire
    // point; a mean reintroduces exactly the dilution that chunking was added to remove.
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
    /* ALL OR NOTHING, AND BOUNDED (2026-11-02 freeze). The embedder may fail or time out (tools/embed-guard.mjs), and a
       slow machine can answer each call just under its limit, many times over. Either every query is embedded within
       EMBED_BUDGET_MS, or none is used and recall answers from the keyword channel alone, the path it already takes
       with no vectors, and the result carries why (degraded) so the caller can say so. Half the queries would rank
       the message on some of its parts and not others, which is worse than an honest keyword answer. */
    let vectors = [];
    let degraded = '';
    try {
      const e = await getEmbedder();
      const t0 = Date.now();
      for (let qi = 0; qi < queries.length; qi++) {
        if (qi > 0 && Date.now() - t0 > EMBED_BUDGET_MS) throw new Error('embedding the message took over ' + EMBED_BUDGET_MS + ' ms');
        vectors.push((await e(String(queries[qi]).slice(0, 4000), { pooling: 'mean', normalize: true })).data);
      }
    } catch (err) {
      vectors = [];
      degraded = String((err && err.message) || err).slice(0, 160);
    }
    for (let qi = 0; qi < vectors.length; qi++) {
      const qv = vectors[qi];
      queryVectors.push(qv);
      embedded++;
      const target = (contextIndex >= 0 && qi >= contextIndex) ? ctxBest : best;
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
    // Chosen only because the CONVERSATION matched them, not the message itself. Turn recall (tools/recall-turn.mjs) uses
    // it to re-match the memories a session was already shown: a link or the conversation alone does not keep one.
    const viaContext = new Set();
    if (RECALL_MODE === 'threshold' && !explicitLimit && embedded) {
      chosen = ranked.slice(0, ALWAYS_FUSED).map(([s]) => s);
      const meaning = emb.slugs.map((s, i) => [s, Math.max(best[i], qBest.get(s) ?? -Infinity, ctxBest[i] * CONTEXT_WEIGHT)])
        .filter(([, v]) => v >= (partBar ?? MEANING_BAR)).sort((a, b) => b[1] - a[1]);
      const bar = partBar ?? MEANING_BAR;
      const at0 = new Map(emb.slugs.map((s, i) => [s, i]));
      for (const [s] of meaning) {
        if (chosen.includes(s)) continue;
        chosen.push(s);
        const i = at0.get(s);
        if (Math.max(best[i], qBest.get(s) ?? -Infinity) < bar) viaContext.add(s);
      }
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
      // EACH PART ALSO BRINGS ITS BEST KEYWORD MATCHES (2026-09-26), so a part that names a person reaches
      // that person's memory even when the rest of a long message is about other things. Measured on the
      // real sets with the hook's own preparation: long 19 to 21 of 46 (pieces 103 to 107 of 142), far
      // apart 14 to 17 of 30, two-memory 80 to 81, single 113 to 114, for about 4 more memories on a long
      // message. 3 per part added one far case for 2 more memories; a stricter bar (0.35, 0.5) lost gains.
      // Rejected the same day: weighting rare words harder (1/df^1.5 and ^2), worse on every set.
      const CTX_PART_K = Number(process.env.RECALL_CTX_PART_K || 0);
      const CTX_PART_MIN = Number(process.env.RECALL_CTX_PART_MIN || 0.45);
      if (CTX_PART_K > 0 && contextIndex >= 0) {
        for (let qi = contextIndex; qi < queryVectors.length; qi++) {
          const qv = queryVectors[qi];
          emb.vectors.map((v, i) => { let d = 0; for (let k = 0; k < v.length; k++) d += qv[k] * v[k]; return [emb.slugs[i], d]; })
            .filter(([, d]) => d >= CTX_PART_MIN).sort((a, b) => b[1] - a[1]).slice(0, CTX_PART_K)
            .forEach(([s]) => { if (!chosen.includes(s)) chosen.push(s); });
        }
      }
      const PART_SPARSE_K = Number(process.env.RECALL_PART_SPARSE_K || 2);
      if (PART_SPARSE_K > 0) {
        for (let qi = 1; qi <= Math.min(parts, queries.length - 1); qi++) {
          const sc = new Map();
          for (const w of new Set(qterms(String(queries[qi]).toLowerCase()))) {
            const ss = kw.terms[w]; if (!ss) continue;
            for (const s of ss) sc.set(s, (sc.get(s) || 0) + 1 / ss.length);
          }
          [...sc.entries()].filter(([, v]) => v >= Number(process.env.RECALL_PART_SPARSE_MIN || 0.25)).sort((a, b) => b[1] - a[1]).slice(0, PART_SPARSE_K)
            .forEach(([s]) => { if (!chosen.includes(s)) chosen.push(s); });
        }
      }
      // A MESSAGE THAT NAMES A PERSON BRINGS THAT PERSON'S CONTACT MEMORY (2026-09-26), when exactly one
      // contact has that first name. Inside a long message a common first name carries too little keyword
      // weight: "a client" appears in many descriptions, and his contact was missed in 2 of the 4 long
      // messages that needed it. Measured: long pieces 107 to 109 of 142, no change on the other sets,
      // 0.2 more memories on average. RECALL_ENTITY=0 turns it off.
      if (process.env.RECALL_ENTITY !== '0') {
        const words = new Set(String(prompt).toLowerCase().match(/[a-zà-ÿ]{3,}/g) || []);
        for (const [first, ss] of snap.contacts) if (ss.length === 1 && words.has(first) && !chosen.includes(ss[0])) chosen.push(ss[0]);
      }
      const at = new Map(emb.slugs.map((s, i) => [s, i]));
      const seed = new Array(emb.slugs.length).fill(0);
      for (const [s, v] of fused) if (at.has(s)) seed[at.get(s)] = v;
      const act = spreadActivation(seed, snap.graph);
      let strongest = 0;
      for (const v of act) if (v > strongest) strongest = v;
      emb.slugs.map((s, i) => [s, act[i]])
        // RECALL_LINK_MEANING_MIN (experiment, off at 0): a linked memory is accepted only if its own meaning match with
        // the message is at least this, so a link cannot bring in a memory that has nothing to do with what was asked.
        // The owner, 2026-10-11: no limit of any kind, "we need to adapt the threshold at which the memories get accepted".
        .filter(([s]) => { const m = Number(process.env.RECALL_LINK_MEANING_MIN || 0); return m <= 0 || best[at.get(s)] >= m; })
        .filter(([s, v]) => !chosen.includes(s) && v > 0 && v >= strongest * (partLinkBar ?? LINK_BAR) && v >= LINK_FLOOR / emb.slugs.length)
        .sort((a, b) => b[1] - a[1])
        .forEach(([s]) => { chosen.push(s); linked.add(s); });
    }
    /* A LONG MESSAGE IS RECALLED AS SEVERAL SMALL ONES (2026-09-26). Each part of a message of SPLIT_MIN
       characters or more gets the full recall a message of its own would get, bar and links included.
       Measured on the real sets: long messages 21 to 32 of 46 (pieces 109 to 127 of 142), about 71
       memories on a long message, every other set unchanged because their messages are shorter. A local
       1.5B model as the splitter reached 33 of 46 for 0.8 s a message, not worth running a model for.
       RECALL_SPLIT_MIN=0 turns it off. */
    const SPLIT_MIN = Number(process.env.RECALL_SPLIT_MIN ?? 400);
    if (RECALL_MODE === 'threshold' && !explicitLimit && SPLIT_MIN > 0 && String(prompt).length >= SPLIT_MIN) {
      for (let qi = 1; qi <= Math.min(parts, queries.length - 1); qi++) {
        if (contextIndex >= 0 && qi >= contextIndex) continue;
        // EXPERIMENT SWITCHES, off by default (2026-10-11): real long messages return 60 memories on average
        // because every part brings its own links. RECALL_PART_LINKS=0 drops the linked memories of a part,
        // RECALL_PART_BAR sets a stricter meaning bar for a part than for the whole message, RECALL_PART_LINK_BAR a
        // stricter link bar (share of the strongest activation) for a part.
        const pb = Number(process.env.RECALL_PART_BAR || 0);
        if (pb > 0) partBar = pb;
        const plb = Number(process.env.RECALL_PART_LINK_BAR || 0);
        if (plb > 0) partLinkBar = plb;
        let sub; try { sub = await recall(queries[qi], [queries[qi]], limit, 0, false, 0, -1); } finally { partBar = null; partLinkBar = null; }
        // RECALL_PART_LINK_TOP (experiment): a part keeps only its N strongest linked memories.
        const plt = Number(process.env.RECALL_PART_LINK_TOP || 0); let partLinked = 0;
        for (const h of sub) {
          if (plt > 0 && h.how === 'linked' && ++partLinked > plt) continue;
          if ((process.env.RECALL_PART_LINKS === '0' || process.env.RECALL_PART_LINKS === 'global') && h.how === 'linked') continue;
          if (chosen.includes(h.slug)) continue;
          chosen.push(h.slug);
          if (h.how === 'linked') linked.add(h.slug);
        }
      }
    }
    // RECALL_PART_LINKS=global (experiment): the parts bring only their direct matches, then the links are followed
    // ONCE from everything chosen, with one bar relative to the strongest, instead of once per part.
    if (process.env.RECALL_PART_LINKS === 'global' && RECALL_MODE === 'threshold' && !explicitLimit && SPLIT_MIN > 0 && String(prompt).length >= SPLIT_MIN && parts > 0) {
      const at2 = new Map(emb.slugs.map((s, i) => [s, i]));
      const seed2 = new Array(emb.slugs.length).fill(0);
      chosen.forEach((s, r) => { if (at2.has(s) && !linked.has(s)) seed2[at2.get(s)] = 1 / (RRF_K + r + 1); });
      const act2 = spreadActivation(seed2, snap.graph);
      let top2 = 0; for (const v of act2) if (v > top2) top2 = v;
      const gb = Number(process.env.RECALL_GLOBAL_LINK_BAR || LINK_BAR);
      emb.slugs.map((s, i) => [s, act2[i]])
        .filter(([s, v]) => !chosen.includes(s) && v > 0 && v >= top2 * gb && v >= LINK_FLOOR / emb.slugs.length)
        .sort((a, b) => b[1] - a[1])
        .forEach(([s]) => { chosen.push(s); linked.add(s); });
    }
    const idxOf = new Map(emb.slugs.map((s, i) => [s, i]));
    const matchOf = (s) => {
      const i = idxOf.get(s);
      if (!embedded || i === undefined) return null;
      const v = Math.max(best[i], qBest.get(s) ?? -Infinity);
      return Number.isFinite(v) ? +v.toFixed(3) : null;
    };
    const out = chosen
      .map((slug, rank) => {
        const hit = {
          slug,
          how: linked.has(slug) ? 'linked' : bySparse.has(slug) && byDense.has(slug) ? 'both' : byDense.has(slug) ? 'meaning' : 'keyword',
          direct: !linked.has(slug) && !viaContext.has(slug),
          // How well the message itself matches it (best meaning over the message and its parts, conversation excluded).
          match: matchOf(slug),
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
    // Not enumerable, so it never reaches a JSON answer by accident; the server reads it and says so itself.
    if (degraded) Object.defineProperty(out, 'degraded', { value: degraded });
    return out;
  }
  // Which index version recall is answering from now (null before the first build). Read by tests and /health.
  recall.snapshotVersion = () => (current ? current.v : null);
  return recall;
}
