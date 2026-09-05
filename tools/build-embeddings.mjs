// Build index/embeddings.json from memory slugs and descriptions.
//
// SEPARATE from build-index.mjs on purpose. Embedding 120 memories takes about 3 seconds and
// loads a 120MB model; build-index runs on every commit via the pre-commit hook and must stay
// instant. This runs only when memory changes, and the hook that consumes it degrades to
// keyword-only when the file is stale or missing.
//
// WHY MULTILINGUAL AND NOT THE SMALLER ENGLISH MODEL
// all-MiniLM-L6-v2 scored 100% on the 40-query eval AS THE CORPUS STOOD THEN, and is half the
// size. Re-measured 2026-08-22 at 127 memories: 97.5%, one miss ("make the brain update itself"
// wants reference_brain_v2_design and gets reference_brain_machine_update). Nothing regressed;
// the corpus grew and two brain-update memories now compete. Quote the number with its date or
// it becomes a claim nobody can check. It also scored
// -0.001 on "كيفاش نسجل الكرياتين", worse than an unrelated memory, because it is English-only
// and Arabic tokenizes to nothing. the owner writes Darija in Arabic script. paraphrase-multilingual
// -MiniLM-L12-v2 scores 0.180 on that same query and picks the right memory, at the cost of
// dropping the English eval to 92.5%. Measured 2026-08-19, both numbers on this corpus.
//
// The keyword channel is kept alongside, not replaced: it holds the exact-name queries
// ("a specific person and a specific vendor") that dense retrieval blurs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDX = join(BRAIN, 'index');
export const MODEL = 'Xenova/all-MiniLM-L6-v2';

const keywords = JSON.parse(readFileSync(join(IDX, 'keywords.json'), 'utf8'));
const slugs = Object.keys(keywords.descriptions).sort();

// Embed exactly what the keyword index sees: slug plus description. Feeding the dense channel
// more text than the sparse one would measure the extra text, not the method.
const docs = slugs.map((s) => `${s.replace(/_/g, ' ')}. ${keywords.descriptions[s]}`);

const t0 = Date.now();
const embed = await pipeline('feature-extraction', MODEL);
const loadMs = Date.now() - t0;

const t1 = Date.now();
const vectors = [];
for (const d of docs) {
  const out = await embed(d, { pooling: 'mean', normalize: true });
  // 4 decimals: the full float wastes about 60% of the file for cosine differences far below
  // anything that changes a ranking.
  vectors.push(Array.from(out.data).map((x) => Math.round(x * 1e4) / 1e4));
}
const embedMs = Date.now() - t1;

mkdirSync(IDX, { recursive: true });
const payload = {
  model: MODEL,
  dims: vectors[0]?.length ?? 0,
  count: slugs.length,
  // Fingerprint of the input, so the consumer can tell a stale index from a current one without
  // re-embedding anything. Descriptions are the only thing embedded, so they are the only thing
  // that needs hashing.
  descriptionsHash: hash(slugs.map((s) => s + '\u0000' + keywords.descriptions[s]).join('\u0001')),
  slugs,
  vectors,
};
writeFileSync(join(IDX, 'embeddings.json'), JSON.stringify(payload), 'utf8');

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`embeddings: ${slugs.length} memories, ${payload.dims} dims, ${Math.round(bytes / 1024)}KB`);
console.log(`model load ${loadMs}ms, embed ${embedMs}ms`);
