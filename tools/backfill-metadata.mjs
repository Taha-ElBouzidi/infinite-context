// One-shot, idempotent backfill of memory frontmatter.
//
// Adds two things so contradictions become detectable instead of silent:
//   metadata.type      inferred from the filename prefix when missing (30 files had none)
//   metadata.asserted  the file's FIRST commit date, i.e. when the fact was first claimed
//
// Never overwrites a value that is already present, never reorders or rewrites body text.
// Run `node tools/backfill-metadata.mjs --dry` first to see the blast radius.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const DRY = process.argv.includes('--dry');
const VALID = new Set(['user', 'contact', 'project', 'feedback', 'reference']);

// One git pass: file -> { first, last } commit dates.
//   first -> when the fact was first asserted
//   last  -> when it was last genuinely touched, seeding the `updated` field
// Bulk maintenance commits are excluded from `last` so a sweep over every memory does
// not make all 94 look freshly updated. `first` deliberately ignores that filter: the
// creation commit is real regardless of how many files it carried.
const BULK_THRESHOLD = 20;

function commitDates() {
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
    const touched = lines.filter((l) => l.startsWith('memory/')).map((l) => l.slice('memory/'.length));
    const bulk = touched.length > BULK_THRESHOLD;
    for (const f of touched) {
      const e = map.get(f) || { first: null, last: null };
      e.first = date;                                   // newest-first walk, so last write wins = oldest
      if (!bulk && !e.last) e.last = date;              // first non-bulk seen = most recent real edit
      map.set(f, e);
    }
  }
  return map;
}

const commits = commitDates();
const first = new Map([...commits].map(([f, e]) => [f, e.first]));
const last = new Map([...commits].map(([f, e]) => [f, e.last || e.first]));
const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();

const report = { typed: [], dated: [], updated: [], noFrontmatter: [], noMetaBlock: [], untouched: 0 };

for (const f of files) {
  const raw = readFileSync(join(MEM, f), 'utf8');
  if (!raw.startsWith('---')) { report.noFrontmatter.push(f); continue; }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) { report.noFrontmatter.push(f); continue; }

  const head = raw.slice(0, end);          // includes opening ---
  const tail = raw.slice(end);             // starts with \n---
  const lines = head.split('\n');

  // Two schemas coexist: older files declare `type:` flat at the top level, newer ones
  // nest under `metadata:`. Write into whichever shape the file already uses rather than
  // migrating 30 files, since the mind-map builder (separate repo) may depend on shape.
  const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  const nested = metaIdx >= 0;
  const indent = nested ? '  ' : '';

  let blockStart, blockEnd;
  if (nested) {
    blockStart = metaIdx + 1;
    blockEnd = blockStart;
    while (blockEnd < lines.length && /^\s+\S/.test(lines[blockEnd])) blockEnd++;
  } else {
    blockStart = 1;          // just after the opening ---
    blockEnd = lines.length; // flat frontmatter runs to the closing ---
  }
  const block = lines.slice(blockStart, blockEnd);

  const typeRe = nested ? /^\s+type:/ : /^type:/;
  const assertedRe = nested ? /^\s+asserted:/ : /^asserted:/;
  const updatedRe = nested ? /^\s+updated:/ : /^updated:/;
  const hasType = block.some((l) => typeRe.test(l));
  const hasAsserted = block.some((l) => assertedRe.test(l));
  const hasUpdated = block.some((l) => updatedRe.test(l));

  const add = [];
  if (!hasType) {
    const prefix = f.split('_')[0];
    if (VALID.has(prefix)) { add.push(`${indent}type: ${prefix}`); report.typed.push(`${f} -> ${prefix}`); }
  }
  if (!hasAsserted) {
    const d = first.get(f);
    if (d) { add.push(`${indent}asserted: ${d}`); report.dated.push(`${f} -> ${d}`); }
  }
  // `updated` moves the recency signal out of git history and into the file itself.
  // The index is then a pure function of content, so committing it cannot change it.
  if (!hasUpdated) {
    const d = last.get(f) || first.get(f);
    if (d) { add.push(`${indent}updated: ${d}`); report.updated.push(`${f} -> ${d}`); }
  }

  if (!add.length) { report.untouched++; continue; }

  lines.splice(blockEnd, 0, ...add);
  if (!DRY) writeFileSync(join(MEM, f), lines.join('\n') + tail, 'utf8');
}

console.log(DRY ? '=== DRY RUN, nothing written ===' : '=== APPLIED ===');
console.log(`files scanned:        ${files.length}`);
console.log(`already complete:     ${report.untouched}`);
console.log(`type added:           ${report.typed.length}`);
console.log(`asserted added:       ${report.dated.length}`);
console.log(`updated added:        ${report.updated.length}`);
console.log(`no frontmatter:       ${report.noFrontmatter.length} ${report.noFrontmatter.join(', ')}`);
console.log(`no metadata block:    ${report.noMetaBlock.length} ${report.noMetaBlock.join(', ')}`);
if (report.typed.length) console.log('\ntype inferred from prefix:\n  ' + report.typed.join('\n  '));
