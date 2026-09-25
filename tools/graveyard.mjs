#!/usr/bin/env node
// The deleted memories, and how to bring one back.
//
// The owner, 2026-09-21: "it is good that we keep a non accessable back up of the deleted memory in case
// the agent deleted something it shouldn't have."
//
// WHERE THEY ARE AND WHY THERE. Not in the repo: a folder inside the brain would be committed,
// greppable and one Read away from any agent, which is the opposite of a backup you keep in case an
// agent got it wrong. They sit next to this machine's own keys, outside the brain, each one
// encrypted to this machine's age public key.
//
// What that buys, precisely: not in git, not in the index, not in recall, not served by any route,
// and unreadable on any other machine even with the file in hand. What it does NOT buy: protection
// from an agent with a shell ON THIS MACHINE, which holds the private key. Nothing stored here
// could give that, and pretending otherwise would be worse than saying it.
//
// Usage, on the host only, because only SERVER holds the key:
//   node tools/graveyard.mjs list                what was deleted, when, by whom and why
//   node tools/graveyard.mjs show <slug>         print one, without restoring it
//   node tools/graveyard.mjs restore <slug>      write it back into memory/ and reindex

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const GRAVE = join(CONFIG_DIR, 'brain-graveyard');
const AGEKEY = join(CONFIG_DIR, 'havok-age-key.txt');

const die = (m) => { process.stderr.write(m + NL); process.exit(1); };
const [cmd, slug] = process.argv.slice(2);

if (!existsSync(GRAVE)) die('Nothing has ever been deleted: ' + GRAVE + ' does not exist.');
if (!existsSync(AGEKEY)) {
  die('This machine holds no age key, so it cannot open the graveyard. Only the brain host can.' + NL
    + 'Expected at: ' + AGEKEY);
}

// slug.2026-09-21T10-11-12-345Z.age
const rows = readdirSync(GRAVE).filter((f) => f.endsWith('.age')).map((f) => {
  const body = f.slice(0, -4);
  const cut = body.indexOf('.');
  return { file: f, slug: cut > 0 ? body.slice(0, cut) : body, when: cut > 0 ? body.slice(cut + 1) : '' };
}).sort((a, b) => a.when.localeCompare(b.when));

function open(row) {
  try {
    return execFileSync('age', ['-d', '-i', AGEKEY], { input: readFileSync(join(GRAVE, row.file)), encoding: 'utf8' });
  } catch (e) {
    die('could not decrypt ' + row.file + ': ' + String(e.message).split(NL)[0]);
  }
}

// The first line of every buried memory is the note the server wrote: who, when, why.
const noteOf = (text) => (/^<!--\s*(.*?)\s*-->/.exec(text) || [, ''])[1];

if (cmd === 'list' || !cmd) {
  if (!rows.length) { process.stdout.write('the graveyard is empty' + NL); process.exit(0); }
  for (const r of rows) process.stdout.write(r.slug + NL + '  ' + noteOf(open(r)) + NL);
  process.stdout.write(NL + rows.length + ' deleted. Restore one with: node tools/graveyard.mjs restore <slug>' + NL);

} else if (cmd === 'show') {
  if (!slug) die('usage: node tools/graveyard.mjs show <slug>');
  const mine = rows.filter((r) => r.slug === slug);
  if (!mine.length) die('nothing buried under ' + slug);
  process.stdout.write(open(mine[mine.length - 1]));

} else if (cmd === 'restore') {
  if (!slug) die('usage: node tools/graveyard.mjs restore <slug>');
  const mine = rows.filter((r) => r.slug === slug);
  if (!mine.length) die('nothing buried under ' + slug);
  const target = join(BRAIN, 'memory', slug + '.md');
  // NEVER over a live memory. A restore that silently replaced a newer file would destroy the very
  // thing this tool exists to protect.
  if (existsSync(target)) die(slug + ' already exists in memory/. Move it aside first if you really mean to overwrite it.');
  const text = open(mine[mine.length - 1]);
  // Drop the deletion note: it is provenance for the graveyard, not part of the memory.
  const clean = text.replace(/^<!--[\s\S]*?-->\r?\n/, '');
  mkdirSync(join(BRAIN, 'memory'), { recursive: true });
  writeFileSync(target, clean, 'utf8');
  process.stdout.write('restored ' + slug + ' to memory/' + NL + 'Now reindex: node tools/build-index.mjs' + NL
    + 'The buried copy is left where it is; delete it by hand if you want it gone.' + NL);

} else {
  die('usage: node tools/graveyard.mjs list | show <slug> | restore <slug>');
}
