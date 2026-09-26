#!/usr/bin/env node
// Replace one memory with another: the database-style UPDATE the markdown brain was missing.
//
// The owner, 2026-09-25, after the cleanup pilot: "we need a system of replacement ... if we have an
// update, we delete and we update, or we replace. This is where a database comes into play." The
// pilot showed why marking a note superseded is not enough: recall ranks only by description and
// ignores the marker, so a superseded note keeps coming back next to its replacement.
//
// What it does, in order:
//   1. checks both memories exist and are different;
//   2. rewrites every [[old]] link in every other memory to [[new]] (in the new memory itself the
//      link becomes plain text, so it never links to itself), because the server refuses to delete
//      a memory that is still linked to;
//   3. deletes the old memory through the brain server with the reason "replaced by <new>: <why>".
//      The server moves it to deleted/ with who, when and why, and the sealed graveyard copy means
//      `node tools/graveyard.mjs restore <old>` brings it back.
// Before running it, the useful history of the old note must already be written into the new one:
// that is a judgement, so it is done by the agent, not by this script.
//
// With a server it deletes through the server; then run `node tools/save-brain.mjs "..."`. On a local
// install it moves the old file to deleted/ itself.
//   node tools/replace-memory.mjs <old-slug> <new-slug> --why "what changed" [--dry]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
const slug = (s) => String(s || '').replace(/\.md$/, '');
const [oldSlug, newSlug] = [slug(argv[0]), slug(argv[1])];
const why = flag('--why');
const dry = argv.includes('--dry');

if (!oldSlug || !newSlug || argv[0].startsWith('--') || argv[1].startsWith('--') || !why) {
  process.stderr.write('usage: node tools/replace-memory.mjs <old-slug> <new-slug> --why "what changed" [--dry]' + NL);
  process.exit(2);
}
if (oldSlug === newSlug) { process.stderr.write('old and new are the same memory' + NL); process.exit(2); }
for (const s of [oldSlug, newSlug]) {
  if (!existsSync(join(MEM, s + '.md'))) { process.stderr.write('no such memory: ' + s + NL); process.exit(2); }
}

const linkRe = new RegExp('\\[\\[' + oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\]', 'g');
const changed = [];
for (const f of readdirSync(MEM).filter((n) => n.endsWith('.md') && n !== oldSlug + '.md')) {
  const p = join(MEM, f);
  const before = readFileSync(p, 'utf8');
  if (!linkRe.test(before)) continue;
  linkRe.lastIndex = 0;
  const target = f === newSlug + '.md' ? '`' + oldSlug + '` (replaced)' : '[[' + newSlug + ']]';
  let after = before.replace(linkRe, target);
  // A note that linked to both would now say [[new]] twice in a row.
  after = after.split('[[' + newSlug + ']], [[' + newSlug + ']]').join('[[' + newSlug + ']]')
    .split('[[' + newSlug + ']] [[' + newSlug + ']]').join('[[' + newSlug + ']]');
  changed.push(f);
  if (!dry) writeFileSync(p, after);
}
process.stdout.write((dry ? 'would repoint' : 'repointed') + ' links in ' + changed.length + ' memories'
  + (changed.length ? ': ' + changed.join(', ') : '') + NL);
if (dry) { process.stdout.write('dry run: nothing deleted' + NL); process.exit(0); }

// A local install has no server to delete through (no server-endpoint.json): the old file moves to
// deleted/ in the brain folder with the reason on its first line, and the index is rebuilt here.
if (!existsSync(join(BRAIN, 'server-endpoint.json'))) {
  const stamp = new Date().toISOString();
  mkdirSync(join(BRAIN, 'deleted'), { recursive: true });
  const old = join(MEM, oldSlug + '.md');
  writeFileSync(join(BRAIN, 'deleted', oldSlug + '.' + stamp.replace(/[:.]/g, '-') + '.md'),
    '<!-- deleted ' + stamp + ': replaced by ' + newSlug + ': ' + why.slice(0, 300) + ' -->' + NL + readFileSync(old, 'utf8'));
  rmSync(old);
  const b = spawnSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], { encoding: 'utf8', windowsHide: true });
  process.stdout.write('replaced ' + oldSlug + ' with ' + newSlug + ' (old copy in deleted/), index '
    + (b.status === 0 ? 'rebuilt' : 'FAILED to rebuild: run node tools/build-index.mjs') + NL);
  process.exit(b.status === 0 ? 0 : 1);
}

const r = spawnSync(process.execPath, [join(BRAIN, 'tools', 'brain-client.mjs'), 'delete', oldSlug,
  '--why', 'replaced by ' + newSlug + ': ' + why], { encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || '');
if (r.status !== 0) {
  process.stderr.write((r.stderr || '') + NL + 'DELETE FAILED, the links above were already repointed; '
    + 'fix the cause and rerun, or revert them with git.' + NL);
  process.exit(1);
}
process.stdout.write('replaced ' + oldSlug + ' with ' + newSlug + '. Now run node tools/save-brain.mjs' + NL);
