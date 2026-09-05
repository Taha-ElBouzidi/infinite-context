// Ensure every memory declares `type` at the TOP LEVEL of its frontmatter.
//
// MINDMAP_NODES.md is explicit: `type` is a top-level field, and "any other value, or a
// missing type, falls back to REFERENCES". Two schemas drifted into the brain, and 65 of
// 95 files nested it under `metadata:`. The mind map therefore filed 65 nodes as
// REFERENCES, which is why the map showed almost nothing but references.
//
// This was invisible to tooling because build-index.mjs and reflect.mjs were written to
// accept BOTH schemas. They validated an assumption instead of the documented contract,
// and happily reported "0 type mismatches" while the map was two thirds wrong. Accepting
// a looser schema than the consumer does is not tolerance, it is a silent break.
//
// Adds the top-level key, leaves the nested one in place (same value, harmless, and other
// readers may still use it). Never changes a value that is already correct.
//
// Run: node tools/fix-mindmap-type.mjs [--dry]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const DRY = process.argv.includes('--dry');
const VALID = new Set(['user', 'contact', 'project', 'feedback', 'reference']);

const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
const fixed = [];
const already = [];
const problems = [];

for (const f of files) {
  const raw = readFileSync(join(MEM, f), 'utf8').replace(/\r\n/g, '\n');
  if (!raw.startsWith('---')) { problems.push(`${f}: no frontmatter`); continue; }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) { problems.push(`${f}: unterminated frontmatter`); continue; }

  const head = raw.slice(0, end);
  const tail = raw.slice(end);
  const lines = head.split('\n');

  if (lines.some((l) => /^type:\s*\S/.test(l))) { already.push(f); continue; }

  // Recover the intended type: nested declaration first, then the filename prefix.
  const nested = lines.find((l) => /^\s+type:\s*\S/.test(l));
  const prefix = f.split('_')[0];
  const type = (nested ? nested.split(':')[1].trim() : '') || (VALID.has(prefix) ? prefix : '');
  if (!VALID.has(type)) { problems.push(`${f}: cannot determine a valid type (got "${type}")`); continue; }

  // Place it directly after `description:` so the file matches the documented shape.
  let at = lines.findIndex((l) => /^description:/.test(l));
  at = at >= 0 ? at + 1 : (lines.findIndex((l) => /^name:/.test(l)) + 1 || 1);
  lines.splice(at, 0, `type: ${type}`);

  if (!DRY) writeFileSync(join(MEM, f), lines.join('\n') + tail, 'utf8');
  fixed.push(`${f} -> ${type}`);
}

console.log(DRY ? '=== DRY RUN ===' : '=== APPLIED ===');
console.log(`scanned:               ${files.length}`);
console.log(`already top-level:     ${already.length}`);
console.log(`top-level type added:  ${fixed.length}`);
console.log(`problems:              ${problems.length}`);
problems.forEach((p) => console.log('  ! ' + p));
if (fixed.length) {
  const byType = {};
  fixed.forEach((x) => { const t = x.split('-> ')[1]; byType[t] = (byType[t] || 0) + 1; });
  console.log('\nrecovered regions:');
  Object.entries(byType).sort().forEach(([t, n]) => console.log(`  ${t}: ${n}`));
}
