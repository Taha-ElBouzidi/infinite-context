// Stamp `updated: <today>` on every memory file that has uncommitted changes.
//
// The recency signal ("Active now" in the router) reads `updated` from frontmatter
// rather than from git history, because a git-derived index self-invalidates: the act
// of committing changes the dates it displays. That trade means something has to keep
// `updated` honest, and prose cannot: hooks enforce, prose advises. This runs in the
// sync engine before it stages, so editing a memory always refreshes its date.
//
// Idempotent: replaces an existing `updated` value rather than appending a second one.
// Writes into whichever frontmatter schema the file already uses (flat or nested).
//
// Run: node tools/stamp-updated.mjs [--dry]

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const TODAY = new Date().toISOString().slice(0, 10);

let status = '';
try {
  status = execSync('git status --porcelain -- memory/', { cwd: BRAIN, encoding: 'utf8' });
} catch { process.exit(0); }

// Porcelain lines look like " M memory/x.md" or "?? memory/y.md". Deletions are skipped:
// there is nothing left to stamp.
const changed = status.split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((l) => !l.startsWith('D'))
  .map((l) => l.replace(/^\S+\s+/, '').replace(/^"|"$/g, ''))
  .filter((f) => f.startsWith('memory/') && f.endsWith('.md') && !f.endsWith('MEMORY.md'));

// Only a genuine edit refreshes the date. A maintenance sweep that rewrites frontmatter
// across the whole brain (a metadata backfill, a schema migration) must NOT mark every
// memory as freshly updated, or it destroys the recency signal this field exists to carry.
// An early version of this script did exactly that to 88 files in one run.
//
// "Genuine" means at least one changed line outside the frontmatter metadata block:
// body text, name, or description. A file with no diff against HEAD (newly added, or
// only line-ending churn) counts as genuine.
const META_KEYS = /^[+-]\s*(type|asserted|updated|node_type|originSessionId):/;

function isGenuineEdit(rel) {
  let diff;
  try {
    diff = execSync(`git diff --unified=0 -- "${rel}"`, { cwd: BRAIN, encoding: 'utf8' });
  } catch { return true; }
  if (!diff.trim()) return true; // untracked/new file: nothing to compare, treat as real
  const body = diff.split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .filter((l) => l.slice(1).trim() !== '');
  if (!body.length) return false;
  return body.some((l) => !META_KEYS.test(l));
}

const stamped = [];
const skipped = [];
for (const rel of changed) {
  if (!isGenuineEdit(rel)) { skipped.push(rel); continue; }
  const path = join(BRAIN, rel);
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { continue; }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const norm = raw.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---')) continue;
  const end = norm.indexOf('\n---', 3);
  if (end < 0) continue;

  const lines = norm.slice(0, end).split('\n');
  const tail = norm.slice(end);
  const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  const nested = metaIdx >= 0;
  const indent = nested ? '  ' : '';
  const re = nested ? /^\s+updated:/ : /^updated:/;

  const existing = lines.findIndex((l) => re.test(l));
  if (existing >= 0) {
    if (lines[existing].trim() === `updated: ${TODAY}`) continue; // already current
    lines[existing] = `${indent}updated: ${TODAY}`;
  } else {
    let insertAt;
    if (nested) {
      insertAt = metaIdx + 1;
      while (insertAt < lines.length && /^\s+\S/.test(lines[insertAt])) insertAt++;
    } else {
      insertAt = lines.length;
    }
    lines.splice(insertAt, 0, `${indent}updated: ${TODAY}`);
  }

  const out = (lines.join('\n') + tail).replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
  if (!DRY) writeFileSync(path, out, 'utf8');
  stamped.push(rel);
}

console.log(`${DRY ? '[dry] ' : ''}stamped updated=${TODAY} on ${stamped.length} memory file(s), skipped ${skipped.length} metadata-only`);
stamped.forEach((f) => console.log('  ' + f));
