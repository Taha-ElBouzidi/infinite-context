// Reflection pass over the brain.
//
// A memory system does not rot from missing data, it rots from silent contradiction:
// two files quietly asserting different values, a link pointing nowhere, a fact nobody
// has reconfirmed in six months. This sweeps for exactly that and prints a report.
// It changes nothing on disk on purpose, findings are for a human or an agent to act on.
//
// Checks:
//   1. broken wikilinks      [[x]] that resolves to no memory
//   2. orphans               memories with no inbound and no outbound links
//   3. type mismatches       filename prefix disagrees with declared type
//   4. missing description   the retrieval surface is empty, so the memory is unfindable
//   5. duplicate candidates  high title/description token overlap between two memories
//   6. stale                 asserted long ago and untouched since
//
// Run: node tools/reflect.mjs [--stale-days 120]

import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const argIdx = process.argv.indexOf('--stale-days');
const STALE_DAYS = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 120;
const VALID = new Set(['user', 'contact', 'project', 'feedback', 'reference']);

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'his',
  'her', 'not', 'never', 'always', 'when', 'what', 'how', 'use', 'used', 'using', 'into',
  'per', 'via', 'any', 'all', 'one', 'two', 'new', 'has', 'have', 'are', 'was', 'were']);

function frontmatter(input) {
  // CRLF checkouts on Windows leave a trailing \r that defeats the `$` anchor below,
  // silently reporting every field as missing. Normalize before parsing.
  const raw = input.replace(/\r\n/g, '\n');
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const out = {};
  for (const line of raw.slice(3, end).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]+):\s*(.*)$/);
    if (m && m[2]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// One git pass for every file's last-commit date. Spawning `git log` per memory cost 94
// process launches and ~5.5s, which is most of the commit gate's latency. Same data, one
// spawn, roughly 10x faster.
function lastCommitDates() {
  const map = new Map();
  let log = '';
  try {
    log = execSync('git log --pretty=format:@@C@@%cs --name-only -- memory/', {
      cwd: BRAIN, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch { return map; }
  for (const chunk of log.split('@@C@@')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    const date = lines.shift();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const t of lines) {
      if (!t.startsWith('memory/')) continue;
      const f = t.slice('memory/'.length);
      if (!map.has(f)) map.set(f, date); // newest-first walk, first hit is the latest
    }
  }
  return map;
}
const lastCommits = lastCommitDates();

const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();

// The mind map reads `type` at the TOP LEVEL only (MINDMAP_NODES.md), and silently files
// anything else under REFERENCES. Parse it strictly and separately from the tolerant
// reader above: accepting a looser schema than the consumer does is how 65 of 95 nodes
// ended up mis-filed while every check reported clean.
function topLevelType(input) {
  const raw = input.replace(/\r\n/g, '\n');
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end < 0) return null;
  for (const line of raw.slice(3, end).split('\n')) {
    const m = line.match(/^type:\s*(\S+)/); // no leading whitespace: top level only
    if (m) return m[1];
  }
  return null;
}

const mem = files.map((f) => {
  const raw = readFileSync(join(MEM, f), 'utf8');
  const fm = frontmatter(raw);
  return {
    file: f,
    stem: f.replace(/\.md$/, ''),
    name: fm.name || '',
    desc: fm.description || '',
    type: fm.type || f.split('_')[0],
    topType: topLevelType(raw),
    asserted: fm.asserted || null,
    outLinks: [...raw.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()),
  };
});

// A wikilink may name either the filename stem or the frontmatter `name`. Accept both,
// normalized, so [[my-memory]] and [[my_memory]] both resolve.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const resolvable = new Set();
for (const m of mem) { resolvable.add(norm(m.stem)); if (m.name) resolvable.add(norm(m.name)); }

const findings = { broken: [], orphan: [], mistyped: [], nodesc: [], dupes: [], stale: [], mindmap: [] };
const inbound = new Map(mem.map((m) => [m.file, 0]));

for (const m of mem) {
  for (const l of m.outLinks) {
    if (!resolvable.has(norm(l))) findings.broken.push(`${m.file} -> [[${l}]]`);
    else {
      const target = mem.find((x) => norm(x.stem) === norm(l) || (x.name && norm(x.name) === norm(l)));
      if (target) inbound.set(target.file, inbound.get(target.file) + 1);
    }
  }
  if (!VALID.has(m.type)) findings.mistyped.push(`${m.file} declares unknown type "${m.type}"`);
  else if (VALID.has(m.file.split('_')[0]) && m.file.split('_')[0] !== m.type)
    findings.mistyped.push(`${m.file} prefix=${m.file.split('_')[0]} declared=${m.type}`);
  if (!m.desc) findings.nodesc.push(m.file);
  // Mind-map contract: top-level `type`, or the node silently lands in REFERENCES.
  if (!m.topType) findings.mindmap.push(`${m.file} has no TOP-LEVEL type, map files it under REFERENCES`);
  else if (!VALID.has(m.topType)) findings.mindmap.push(`${m.file} top-level type "${m.topType}" is not a valid region`);
}

for (const m of mem) if (!m.outLinks.length && inbound.get(m.file) === 0) findings.orphan.push(m.file);

// Duplicate candidates: Jaccard overlap on content words of name + description.
const tokens = (m) => new Set((m.name + ' ' + m.desc).toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));
const tok = new Map(mem.map((m) => [m.file, tokens(m)]));
for (let i = 0; i < mem.length; i++) {
  for (let j = i + 1; j < mem.length; j++) {
    const a = tok.get(mem[i].file), b = tok.get(mem[j].file);
    if (a.size < 3 || b.size < 3) continue;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= 0.4) findings.dupes.push(`${(jac * 100).toFixed(0)}%  ${mem[i].file}  <->  ${mem[j].file}`);
  }
}

const today = new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
for (const m of mem) {
  const last = lastCommits.get(m.file) || null;
  if (last && daysBetween(last, today) > STALE_DAYS) findings.stale.push(`${m.file} last touched ${last}`);
}

// Index drift: the generated router and indexes must match what memory/ would produce.
// Delegated to build-index --check so there is exactly one definition of "correct",
// rather than a second copy of the generation logic that could itself drift.
const driftRows = [];
try {
  execSync('node "' + join(BRAIN, 'tools', 'build-index.mjs') + '" --check', {
    cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  const out = ((e.stdout || '') + (e.stderr || '')).toString().trim();
  driftRows.push(...out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('Fix:')));
}

const section = (title, rows, note) => {
  console.log(`\n## ${title} (${rows.length})`);
  if (note && rows.length) console.log(note);
  if (!rows.length) console.log('  none');
  else rows.slice(0, 25).forEach((r) => console.log('  ' + r));
  if (rows.length > 25) console.log(`  ... and ${rows.length - 25} more`);
};

console.log(`# Brain reflection report  (${mem.length} memories, stale threshold ${STALE_DAYS}d)`);
section('Index drift', driftRows, '  Generated index does not match memory/. Fix: node tools/build-index.mjs');
section('Mind-map contract', findings.mindmap, '  `type` must be TOP LEVEL (MINDMAP_NODES.md). Nested under metadata: the map cannot see it.');
section('Broken wikilinks', findings.broken, '  These edges point nowhere. Fix the link or create the memory.');
section('Type mismatches', findings.mistyped, '  Filename and declared type disagree. Misfiles the memory and the mind map.');
section('Missing description', findings.nodesc, '  No description means the memory cannot be found by scanning the index.');
section('Duplicate candidates', findings.dupes, '  High overlap. Merge, or sharpen the descriptions so they are distinguishable.');
section('Orphans (no links in or out)', findings.orphan, '  Disconnected from the graph. Link them or accept they are leaf references.');
section(`Stale (untouched > ${STALE_DAYS}d)`, findings.stale, '  Reconfirm or mark superseded. Old facts are the ones that silently go wrong.');

const total = Object.values(findings).reduce((n, a) => n + a.length, 0) + driftRows.length;
console.log(`\nTotal findings: ${total}`);
