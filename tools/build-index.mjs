// Rebuild the tiered recall index from memory/ frontmatter.
//
// Why this exists: MEMORY.md used to be a hand-maintained flat list of ~90 pointers,
// loaded in full every session (~4,800 tokens) and free to drift from the files it
// described. Here the index is DERIVED from each memory file's own frontmatter, so
// drift is structurally impossible: regenerate and it is correct by construction.
//
// Writes:
//   index/<type>.md   one browsable index per memory type (Tier 1 drill-down)
//   memory/MEMORY.md  the router: counts, active hot list, where to look (Tier 1 entry)
//
// Nothing new is written under memory/ apart from MEMORY.md, which already existed:
// the mind-map builder (separate repo) scans memory/ and treats one file as one node,
// so index files deliberately live outside it.
//
// Run: node tools/build-index.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { terms } from './tokenize.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const IDX = join(BRAIN, 'index');

// --check verifies the committed index matches what the memory files would generate,
// without writing anything. Exits 1 on drift so CI or a hook can fail loudly. Only
// meaningful because generation is deterministic (see the dates comment below).
const CHECK = process.argv.includes('--check');
const drift = [];

function emit(path, content) {
  if (!CHECK) { writeFileSync(path, content, 'utf8'); return; }
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { drift.push(`${path} (missing)`); return; }
  // Compare normalized: CRLF checkouts must not read as drift.
  if (current.replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) drift.push(path);
}

const TYPES = ['user', 'contact', 'project', 'feedback', 'reference'];
const TYPE_TITLE = {
  user: 'Identity',
  contact: 'People',
  project: 'Projects',
  feedback: 'Rules and feedback',
  reference: 'Reference',
};
// Filename prefix is the fallback when frontmatter omits metadata.type.
const PREFIX_TYPE = { user: 'user', contact: 'contact', project: 'project', feedback: 'feedback', reference: 'reference' };

function parseFrontmatter(input) {
  // The repo checks out CRLF on Windows. A trailing \r defeats the `$` anchor below,
  // which silently drops name/description and degrades the whole index. Normalize first.
  const raw = input.replace(/\r\n/g, '\n');
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end);
  const out = {};
  let inMeta = false;
  for (const line of block.split('\n')) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const m = line.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, val] = m;
    if (indent.length > 0 && inMeta) out['meta_' + key] = val.trim();
    else { inMeta = false; out[key] = val.trim(); }
  }
  return out;
}

// Dates come from frontmatter (`asserted`, `updated`), never from git history.
//
// This is load-bearing. An earlier version derived recency from `git log`, which made the
// index self-invalidating: generate, commit, and the act of committing changed the dates
// the index displayed, so it was stale the instant it landed. Reading dates from the files
// makes the index a pure function of content: regenerating after a commit is a no-op, and
// a drift check becomes meaningful. `updated` is maintained by tools/backfill-metadata.mjs
// and by the memory write path.
const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();

const entries = [];
for (const f of files) {
  const raw = readFileSync(join(MEM, f), 'utf8');
  const fm = parseFrontmatter(raw);
  const prefix = f.split('_')[0];
  // Two schemas coexist in the brain: older files declare `type:` at the top level,
  // newer ones nest it under `metadata:`. Accept both, fall back to the filename prefix.
  const type = fm.meta_type || fm.type || PREFIX_TYPE[prefix] || 'reference';
  const meta = (k) => fm['meta_' + k] || fm[k] || null; // tolerate both frontmatter schemas
  entries.push({
    file: f,
    title: fm.name || f.replace(/\.md$/, ''),
    // Strip wrapping quotes: YAML descriptions containing a colon must be quoted, and those
    // quotes leaked verbatim into the manifest, which is read by a model as literal text.
    desc: (fm.description || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '').trim(),
    type: TYPES.includes(type) ? type : 'reference',
    updated: meta('updated') || meta('asserted') || null,
    asserted: meta('asserted') || null,
    links: (raw.match(/\[\[[^\]]+\]\]/g) || []).length,
    // Always-on behaviour rules. A memory with a `rule:` line is injected on EVERY turn by
    // hooks/pre-turn.mjs. Everything else is recall-only, surfaced when the prompt matches.
    // Unescape too: a rule containing a quote must be escaped in YAML, and those backslashes
    // rendered literally in the injected text (`\"now\"`), which a model reads as characters.
    rule: (fm.rule || '').replace(/^["']|["']$/g, '').split('\\"').join('"').split("\'").join("'").trim() || null,
    ruleOrder: Number(fm.rule_order || 999),
  });
}

mkdirSync(IDX, { recursive: true });

// Tier 1 drill-down: one index per type, newest first so recency is visible.
for (const type of TYPES) {
  const rows = entries.filter((e) => e.type === type)
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  if (!rows.length) continue;
  const lines = [
    `# ${TYPE_TITLE[type]} (${rows.length})`,
    '',
    `Generated by tools/build-index.mjs. Do not hand-edit: edit the memory file's frontmatter instead.`,
    'Newest first. Read only the entries relevant to the task at hand.',
    '',
  ];
  for (const r of rows) {
    const when = r.updated ? ` \`${r.updated}\`` : '';
    lines.push(`- [${r.title}](../memory/${r.file})${when} - ${r.desc}`);
  }
  emit(join(IDX, `${type}.md`), lines.join('\n') + '\n');
}

// Hot list: the projects actually moving right now, so the router carries live state
// rather than an alphabetical dump.
const hot = entries.filter((e) => e.type === 'project' && e.updated)
  .sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8);

const counts = TYPES.map((t) => [t, entries.filter((e) => e.type === t).length]).filter(([, n]) => n > 0);

const router = [
  '# MEMORY - Router',
  '',
  `${entries.length} memories. This file is the Tier 1 entry point and is intentionally small:`,
  'it tells you WHERE to look, it is not a dump of everything known.',
  'Generated by tools/build-index.mjs, do not hand-edit.',
  '',
  '## Recall protocol',
  '',
  'Before acting on a task, run the recall loop in CLAUDE.md: ask whether the brain',
  'already knows something, search for it, read only what matches, then decide.',
  'Do not preload every index.',
  '',
  '## Where to look',
  '',
  '| Looking for | Go to |',
  '|---|---|',
  '| Who the owner is, preferences, profile | `index/user.md` |',
  '| A person, client, or contact | `index/contact.md` |',
  '| Status of a project or engagement | `index/project.md` |',
  '| A rule or correction the owner has given | `index/feedback.md` |',
  '| How a tool, MCP, or system works | `index/reference.md` |',
  '| Anything, by keyword | `grep -ril "<term>" memory/` |',
  '',
  '## Counts',
  '',
  counts.map(([t, n]) => `- ${TYPE_TITLE[t]}: ${n}`).join('\n'),
  '',
  '## Active now (most recently updated projects)',
  '',
  hot.map((h) => `- [${h.title}](${h.file}) \`${h.updated}\``).join('\n'),
  '',
  '## Never-miss rules',
  '',
  'Hard rules live in `REFLEX.md` and are always loaded. Full operating rulebook is',
  '`METHODOLOGIES.md`, read it when planning, coding, or making judgment calls.',
  '',
].join('\n');

emit(join(MEM, 'MEMORY.md'), router);

// Tier 1.5: the RECOGNITION manifest.
//
// Added 2026-08-06, after the owner reported for the second time that connected chats still were
// not recalling anything before acting, even once REFLEX and the router were injected in full.
//
// The reason is structural, not laziness. The router tells an agent WHERE to look. Acting on
// that requires the agent to first suspect there is something to find, and you cannot decide
// to search for something you do not know exists. A pointer to a filing cabinet only helps
// someone who already believes the file is in there.
//
// So this injects WHAT the brain knows rather than where it is kept: every memory's slug and
// its one-line description. Recall stops being a deliberate grep the agent may skip, and
// becomes recognition it cannot avoid. the owner's framing: a human does not run a query, the name
// arrives and the association fires.
//
// The description IS the retrieval surface. A memory with a vague description is invisible
// here no matter how good its contents, which is why verify.mjs enforces a minimum length.
const manifest = [
  '# MANIFEST - everything the brain knows',
  '',
  `All ${entries.length} memories with their one-line descriptions.`,
  'Generated by tools/build-index.mjs, do not hand-edit.',
  '',
  'This exists so you RECOGNISE rather than search. Scan it against whatever you are about',
  'to do. If a line is relevant, open `memory/<slug>.md` and read it BEFORE acting, not after.',
  'Seeing a slug here is not the same as knowing its contents: the description tells you',
  'whether to open the file, never what the file says.',
  '',
];
for (const type of TYPES) {
  const rows = entries.filter((e) => e.type === type).sort((a, b) => a.file.localeCompare(b.file));
  if (!rows.length) continue;
  manifest.push(`## ${TYPE_TITLE[type] || type} (${rows.length})`, '');
  for (const e of rows) manifest.push(`- ${e.file.replace(/\.md$/, '')}: ${e.desc}`);
  manifest.push('');
}
const manifestText = manifest.join('\n');
emit(join(BRAIN, 'MANIFEST.md'), manifestText);

// ---------------------------------------------------------------------------
// index/keywords.json - the inverted index behind per-prompt recall.
//
// MANIFEST.md solved "the agent cannot search for what it does not know exists" by putting
// every slug in front of it at session start. That works on turn 1 and decays from there:
// by turn 50 it is buried under a hundred thousand tokens of conversation and loses to
// recency every time. the owner's complaint, and he was right: "any chat that I talk to doesn't
// recall the brain first to check if he remembers something."
//
// Prose cannot fix that, because the instruction to recall decays exactly as fast as the
// thing it is pointing at. So the matching moves out of the model entirely: this index lets
// a UserPromptSubmit hook do the recognition in code, on every single turn, and name the
// specific memories that match what the owner just asked. The agent stops needing to remember to
// remember.
//
// Scored by inverse document frequency, so a term in one memory ("acme") outweighs one in
// thirty ("dashboard"). Terms appearing in more than DF_MAX memories are dropped entirely:
// they cost bytes and match everything, which is the same as matching nothing.
// Tokenizer lives in tools/tokenize.mjs so the indexer and the query side cannot drift apart.
// No DF cap any more: a common term should weigh little at query time (1/df), not be deleted.
// Deleting it removed the chance for several weak signals to combine, which is how phrases like
// "when does the day start for logging" are supposed to resolve.
const postings = new Map();
for (const e of entries) {
  const slug = e.file.replace(/\.md$/, '');
  // Slug and description only. Body text was tried on 2026-08-07 and measurably regressed
  // recall: the index went from 1,099 terms to 5,460, every good query picked up three or four
  // unrelated memories, and "creatine" went from missing to SILENT. The real gap was a
  // description that omitted the word the owner says, so the fix belongs in the description.
  for (const t of terms(slug + ' ' + e.desc)) {
    if (!postings.has(t)) postings.set(t, new Set());
    postings.get(t).add(slug);
  }
}

const keywords = {};
for (const [t, slugs] of [...postings].sort((a, b) => a[0].localeCompare(b[0]))) {
  keywords[t] = [...slugs].sort();
}
const descs = {};
for (const e of entries) descs[e.file.replace(/\.md$/, '')] = e.desc;

// index/rules.json - the always-on behaviour rules, GENERATED from memory frontmatter.
//
// This exists because the per-turn injection used to be hardcoded inside hooks/pre-turn.mjs.
// The same rules were then also written in REFLEX.md, METHODOLOGIES.md, both CLAUDE.md files
// and their own feedback memories: "verify" appeared in 7 files, "em dash" in 6. Editing
// feedback_reply_length.md changed nothing, because the sentence the agent actually saw lived
// in the hook. That is exactly the split-brain the brain was built to prevent, rebuilt one
// layer up.
//
// Now the memory is the source and the injection is derived. Change the `rule:` line, run this,
// and every turn on every machine changes with it.
const ruleRows = entries.filter((e) => e.rule)
  .sort((a, b) => a.ruleOrder - b.ruleOrder || a.file.localeCompare(b.file))
  .map((e) => ({ slug: e.file.replace(/\.md$/, ''), order: e.ruleOrder, rule: e.rule }));
emit(join(BRAIN, 'index', 'rules.json'), JSON.stringify({ rules: ruleRows }, null, 2));

const keywordsText = JSON.stringify({ terms: keywords, descriptions: descs }, null, 0);
emit(join(BRAIN, 'index', 'keywords.json'), keywordsText);

// VECTOR PARITY. Keeping the embedding build separate is right, but staying SILENT about it was
// not, and it cost real recall.
//
// Found 2026-08-22: six memories written on 21 and 22 August had no vector at all and could only
// be found by keyword. One of them was the memory recording the arguments the owner banned. The cause
// was not a bug in either tool. CLAUDE.md tells an agent to write the file and run build-index,
// and following that instruction exactly produces a half-indexed memory every single time,
// because vectors come from build-embeddings.mjs, which is documented nowhere.
//
// The fence stays: this script runs on every commit via the pre-commit hook and must be instant,
// and embedding costs about 2.2 seconds and needs the embedding model, which build-embeddings fetches on first run. So the
// cost is paid ONLY when the memory set actually changed, and a machine that cannot pay it is
// told loudly rather than left to discover the gap weeks later.
// Must match build-embeddings.mjs exactly, or the two hashes can never agree and every run would
// rebuild. djb2, same as there.
function descHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function vectorParity() {
  const slugs = readdirSync(join(BRAIN, 'memory'))
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((f) => f.replace(/\.md$/, ''));
  let have = [];
  let storedHash = null;
  try {
    const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
    have = emb.slugs || [];
    storedHash = emb.descriptionsHash || null;
  } catch { /* no index yet, everything is missing */ }
  const has = new Set(have);

  // DESCRIPTIONS TOO, not just which slugs exist.
  //
  // The first version of this compared slug sets only, which missed the most common edit there is.
  // A vector is built from the slug plus the DESCRIPTION, and the description is the entire
  // retrieval surface, so rewriting one to make a memory findable changed the keyword index and
  // left the semantic vector pointing at the old wording. Silently. That is the same class of bug
  // this whole function exists to prevent, reintroduced one level down, and it was caught the same
  // day by editing a description and watching nothing rebuild.
  //
  // build-embeddings already publishes descriptionsHash; nothing was reading it.
  let descChanged = false;
  try {
    const kw = JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8'));
    const now = descHash(Object.keys(kw.descriptions).sort()
      .map((s) => s + '\u0000' + kw.descriptions[s]).join('\u0001'));
    descChanged = storedHash != null && now !== storedHash;
  } catch { /* no keyword index yet */ }

  return {
    missing: slugs.filter((s) => !has.has(s)),
    stale: have.filter((s) => !slugs.includes(s)),
    descChanged,
  };
}

const parity = vectorParity();
if (parity.missing.length || parity.stale.length || parity.descChanged) {
  if (CHECK) {
    // Deliberately NOT a failure. verify.mjs gates commits, and a machine with no model could
    // then never commit a memory at all. Warn where it will be read; the server repairs it.
    const bits = [];
    if (parity.missing.length) bits.push(`${parity.missing.length} memory(s) have NO vector and are invisible to semantic recall`);
    if (parity.stale.length) bits.push(`${parity.stale.length} vector(s) point at deleted memories`);
    console.error('WARNING: ' + bits.join('; ') + '. Fix on the server: node tools/build-embeddings.mjs');
  } else if (!existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
    console.error('');
    console.error('  VECTORS ARE STALE AND THIS MACHINE CANNOT BUILD THEM (no local model).');
    parity.missing.forEach((s) => console.error('    no vector: ' + s));
    console.error('  These memories are findable by KEYWORD ONLY until the server rebuilds.');
    console.error('');
  } else {
    const why = [];
    if (parity.missing.length) why.push(parity.missing.length + ' new');
    if (parity.stale.length) why.push(parity.stale.length + ' removed');
    if (parity.descChanged) why.push('descriptions changed');
    console.log('rebuilding vectors (' + why.join(', ') + ')');
    execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-embeddings.mjs')], { stdio: 'inherit' });
    const after = vectorParity();
    if (after.missing.length) console.error(`WARNING: ${after.missing.length} still without a vector after rebuild`);
  }
}

const orphans = entries.filter((e) => e.links === 0).length;
if (CHECK) {
  if (drift.length) {
    console.error(`INDEX DRIFT: ${drift.length} generated file(s) do not match memory/`);
    drift.forEach((d) => console.error('  ' + d));
    console.error('Fix: node tools/build-index.mjs');
    process.exit(1);
  }
  console.log(`index in sync (${entries.length} memories)`);
} else {
  console.log(`indexed ${entries.length} memories into ${counts.length} type indexes`);
  console.log(`router: memory/MEMORY.md (${Buffer.byteLength(router)} bytes)`);
  console.log(`manifest: MANIFEST.md (${Buffer.byteLength(manifestText)} bytes, ~${Math.round(Buffer.byteLength(manifestText) / 4)} tokens)`);
  console.log(`hot list: ${hot.length} active projects`);
  console.log(`orphans (no wikilinks): ${orphans}`);
}
