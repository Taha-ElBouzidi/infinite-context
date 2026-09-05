#!/usr/bin/env node
// Wire this machine's Claude Code to the brain, or check that it still is.
//
// The owner, 2026-09-05, on the GitHub repo being purely a backup: "if you want to add to it this
// pre-turn loads as a backup tool, you can. You can put anything as a backup there if you need
// this, but it's gonna be a backup."
//
// WHY THIS HAD TO EXIST. pre-turn.mjs is the hook that gives an agent memory at all, and it is
// registered in ~/.claude/settings.json, which is per-machine, untracked, and backed up by
// nothing. Every other part of the brain is recoverable from the server or the repo; the one
// line that switches the brain ON was not. Lose that file and the brain stops loading with NO
// error at all: recall simply never runs, and the agent answers from nothing while looking
// completely healthy. That is the worst failure shape there is.
//
// It is also the first thing a new machine needs, and the first thing a client installing this
// would need, so it belongs in the repo rather than in one person's head.
//
//   node tools/install-hook.mjs            wire it up, or repair it
//   node tools/install-hook.mjs --check    report only, change nothing, exit 1 if not wired
//
// Never destructive: the existing settings.json is copied aside before anything is written, and
// every other hook and setting in it is preserved untouched.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const say = (s) => process.stdout.write(s + NL);

const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const SETTINGS = join(CONFIG_DIR, 'settings.json');

// Forward slashes even on Windows. Node accepts them, and JSON with backslashes is a reliable
// source of escaping bugs in a file people also edit by hand.
const HOOK_PATH = join(BRAIN, 'hooks', 'pre-turn.mjs').split(BS).join('/');
const COMMAND = 'node "' + HOOK_PATH + '"';
const TIMEOUT = 10;

let settings = {};
let existed = false;
if (existsSync(SETTINGS)) {
  existed = true;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    say('settings.json exists but is not valid JSON: ' + e.message);
    say('Refusing to touch it. Fix or move it first, because rewriting it would lose every other');
    say('setting in it.');
    process.exit(1);
  }
}

settings.hooks = settings.hooks || {};
const list = Array.isArray(settings.hooks.UserPromptSubmit) ? settings.hooks.UserPromptSubmit : [];

// Is the brain already wired, and to WHICH brain? A machine with two clones can end up pointing
// at the wrong one, which looks identical from the outside and recalls from a stale corpus.
let wiredHere = false;
const otherBrains = [];
for (const entry of list) {
  for (const h of (entry && entry.hooks) || []) {
    const c = String((h && h.command) || '');
    if (!c.includes('pre-turn.mjs')) continue;
    if (c.includes(HOOK_PATH)) wiredHere = true;
    else otherBrains.push(c);
  }
}

say('brain    : ' + BRAIN);
say('settings : ' + SETTINGS + (existed ? '' : '  (does not exist yet)'));
say('wired    : ' + (wiredHere ? 'YES, to this brain' : 'NO'));
for (const c of otherBrains) say('  WARNING: also registered to a DIFFERENT brain: ' + c);

if (wiredHere && !otherBrains.length) {
  say('');
  say('Nothing to do. Recall will load on the next session start.');
  process.exit(0);
}

if (CHECK) {
  say('');
  say('--check: not wired to this brain, nothing changed. Run without --check to fix it.');
  process.exit(1);
}

if (otherBrains.length) {
  say('');
  say('Leaving the other registration alone: removing it is a judgement call, not a repair.');
  say('If this machine should only use this brain, delete that entry by hand.');
}

if (!wiredHere) {
  list.push({ hooks: [{ type: 'command', command: COMMAND, timeout: TIMEOUT }] });
  settings.hooks.UserPromptSubmit = list;

  if (existed) {
    // Copy aside BEFORE writing. This file holds every other Claude Code setting on the machine.
    const bak = SETTINGS + '.before-havok-hook';
    copyFileSync(SETTINGS, bak);
    say('');
    say('backed up: ' + bak);
  } else {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + NL, 'utf8');
  say('registered UserPromptSubmit: ' + COMMAND);
  say('');
  say('A running session loads hooks at start, so restart the session before expecting recall.');
}
