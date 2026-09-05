#!/usr/bin/env node
// Set up a brand new, empty brain on this machine. One command, no server, no network.
//
// The owner, 2026-09-05: "we need it to be easy for people to use and for AI to install it on its own."
//
// The second half is the harder and more interesting one, so this tool is written to be run by an
// agent reading AGENTS.md as much as by a person: it is idempotent, it refuses rather than
// overwrites, it prints what it did, and it verifies itself at the end instead of assuming.
//
// WHY SEED RULES EXIST. A fresh install has `index/rules.json` = `{"rules": []}`, because the
// always-on behaviour rules are GENERATED from memory frontmatter, from any memory carrying a
// `rule:` line. So the rules are content, not engine, and an empty brain produces an agent with no
// operating rules at all. That was found by actually installing a clean export on 2026-09-05, not
// by reading the code. The five below are the universal ones, with nothing personal in them.
//
//   node tools/init.mjs              set up an empty brain here
//   node tools/init.mjs --force      re-seed even if memories already exist
//
// It does NOT touch git, does NOT reach the network, and does NOT install the Claude Code hook.
// That last one is a separate, reversible step: node tools/install-hook.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = process.env.HAVOK_BRAIN || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const NO_SEMANTIC = process.argv.includes('--no-semantic');
const NL = String.fromCharCode(10);
const say = (s) => process.stdout.write(s + NL);

// ---- the seed rules ---------------------------------------------------------------------------
// Deliberately generic. Nothing here is about one person, one company or one machine. They are the
// rules that stop an agent doing the specific damage a memory system makes possible: sounding
// certain about a stale fact, claiming something works without running it, and losing what it
// learned the moment the session ends.
const SEEDS = [
  {
    slug: 'feedback_verify_before_claiming',
    name: 'Never say it works until you have run it and read the output',
    order: 10,
    rule: 'VERIFY BEFORE YOU CLAIM. Never say done, fixed, working or passing until you have run it and read the output. Say what you ran and what it returned. A file written is not a test passed, a test passed is not a thing deployed, and a thing deployed is not a thing the user can see. If you could not verify, say exactly that instead of implying success.',
    desc: 'Do not tell me something is done, fixed or working until you have actually run it and read what it printed. Say what you ran and what came back.',
    body: [
      'The single most expensive failure an agent has, because it is invisible: the work looks',
      'finished, and nobody finds out otherwise until it matters.',
      '',
      'A file written is not a test passed. A test passed is not a thing deployed. A thing deployed is',
      'not a thing the user can see. Each of those gaps has to be crossed on purpose.',
      '',
      'When you genuinely cannot verify something, say so in the same sentence as the claim, never in',
      'a caveat further down where it reads as optional.',
    ],
    links: ['feedback_say_when_the_brain_is_down', 'feedback_write_it_the_moment_you_learn_it'],
  },
  {
    slug: 'feedback_say_when_the_brain_is_down',
    name: 'If the brain is unreachable, say so before answering, never work blind',
    order: 20,
    rule: 'IF THE BRAIN IS UNREACHABLE, SAY SO IN YOUR FIRST SENTENCE. Degraded recall that announces itself is recoverable. Silent degradation means answering from nothing while sounding exactly as confident as usual, which is worse than having no memory at all.',
    desc: 'Tell me straight away when you cannot reach the memory, instead of answering anyway and sounding just as sure as normal.',
    body: [
      'A memory system fails quietly. Recall returns nothing, the agent carries on, and the answer',
      'sounds identical to a well-informed one. Nothing on screen says otherwise.',
      '',
      'So the degradation must be announced, not detected. First sentence, before the answer.',
      '',
      'The same applies to partial degradation: keyword-only recall, a stale index, a memory file that',
      'could not be opened. Name it.',
    ],
    links: ['feedback_verify_before_claiming', 'feedback_open_the_memory_not_the_description'],
  },
  {
    slug: 'feedback_open_the_memory_not_the_description',
    name: 'The one-line description says whether to open a memory, never what it says',
    order: 30,
    rule: 'OPEN THE MEMORIES RECALL NAMES. The one-line description exists to tell you whether a file is worth opening, never what is in it. Answering from a description is how a half-remembered fact gets stated as current. Read the file before you rely on it.',
    desc: 'Actually open the memory files instead of answering from the one-line summary you were shown.',
    body: [
      'Recall returns pointers, not content: a slug, a one-line description, and where to find it.',
      'That is deliberate, because injecting every candidate memory into every prompt costs far more',
      'than reading the one or two that matter.',
      '',
      'The failure it creates is answering from the description, which is a summary written at some',
      'point in the past for a different purpose. It is enough to decide relevance and never enough to',
      'decide truth.',
    ],
    links: ['feedback_say_when_the_brain_is_down', 'feedback_write_it_the_moment_you_learn_it'],
  },
  {
    slug: 'feedback_write_it_the_moment_you_learn_it',
    name: 'Write the memory the moment something becomes true, never later',
    order: 40,
    rule: 'WRITE IT THE MOMENT YOU LEARN IT. When something becomes durably true, a decision and its reason, a fact about a system, a correction you were given, a thing that broke and why, write the memory NOW. Never say you will do it later. The session ends and it is gone.',
    desc: 'Save what you learn as you learn it. Do not wait until the end of the session, because by then it is lost.',
    body: [
      'Knowledge flows one way: into the memory, then back out to every future session. Anything that',
      'does not get written did not happen, as far as tomorrow is concerned.',
      '',
      'The description is the retrieval surface, and on most setups it is the ONLY thing indexed.',
      'Write it in the words the user would actually type when looking for it, not in the technical',
      'vocabulary of the thing being described. A memory with a vague description exists and can never',
      'be found, which is worse than not writing it.',
    ],
    links: ['feedback_open_the_memory_not_the_description', 'feedback_reversible_act_irreversible_ask'],
  },
  {
    slug: 'feedback_reversible_act_irreversible_ask',
    name: 'Judge an action by whether it can be undone, not by how big it feels',
    order: 50,
    rule: 'ACT ON WHAT IS REVERSIBLE, ASK ABOUT WHAT IS NOT. If it is cheap to undo and stays on this machine, do it and report what changed. If it leaves the machine or cannot be taken back, sending, publishing, spending, deleting, installing something permanent, do the reversible part and then ask.',
    desc: 'Just do the things that can be undone. Ask me first only when it cannot be taken back, like sending, deleting, publishing or spending.',
    body: [
      'The useful axis is reversibility, not how important the task sounds. Renaming a variable and',
      'sending an email to a client are not the same kind of act, and neither is "big".',
      '',
      'Not knowing how is not a reason to ask. Go and find out: read the code, test it on a copy, then',
      'act. Guessing and handing the question back are both failures.',
    ],
    links: ['feedback_verify_before_claiming', 'feedback_write_it_the_moment_you_learn_it'],
  },
];

// ---- go ----------------------------------------------------------------------------------------
const memDir = join(BRAIN, 'memory');
mkdirSync(memDir, { recursive: true });
mkdirSync(join(BRAIN, 'index'), { recursive: true });

const existing = readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
if (existing.length && !FORCE) {
  say('This brain already holds ' + existing.length + ' memories, so it is not new.');
  say('init is for an EMPTY brain and will not overwrite anything. Use --force to seed anyway.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
let written = 0;
for (const s of SEEDS) {
  const file = join(memDir, s.slug + '.md');
  if (existsSync(file) && !FORCE) { say('  kept (already there): ' + s.slug); continue; }
  const doc = [
    '---',
    'name: ' + s.name,
    'description: ' + s.desc,
    'rule: "' + s.rule.split('"').join('\\"') + '"',
    'rule_order: ' + s.order,
    'type: feedback',
    'metadata:',
    '  type: feedback',
    '  asserted: ' + today,
    '  updated: ' + today,
    '---',
    '',
    ...s.body,
    '',
    '## Related',
    s.links.map((l) => '[[' + l + ']]').join(' '),
    '',
  ].join(NL);
  writeFileSync(file, doc, 'utf8');
  written += 1;
}
say('seeded ' + written + ' behaviour rule(s) as memories');

// ---- semantic recall, ON by default ------------------------------------------------------------
// Measured on a fresh clone, 2026-09-05: npm install 31s and 284MB, first build 16s including the
// model download, and then a paraphrase with no word in common finds the right memory. Without
// this the product is keyword-only, which is half of it. --no-semantic skips it, and the hook says
// so on every turn rather than pretending.
if (!NO_SEMANTIC) {
  const pkg = join(BRAIN, 'node_modules', '@xenova', 'transformers');
  if (!existsSync(pkg)) {
    say('installing the embedding model runtime (about 280MB, around half a minute)...');
    try {
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: BRAIN, stdio: 'inherit', timeout: 600000, windowsHide: true, shell: process.platform === 'win32' });
    } catch (e) {
      say('npm install failed: ' + String(e.message).split(NL)[0]);
      say('Continuing keyword-only. Run npm install later and then node tools/build-index.mjs.');
    }
  }
}

// ---- build the index, which is what makes any of it findable -------------------------------
try {
  const out = execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], {
    cwd: BRAIN, encoding: 'utf8', timeout: 300000, windowsHide: true,
  });
  for (const line of out.trim().split(NL).slice(-4)) say('  ' + line);
} catch (e) {
  say('build-index FAILED: ' + String(e.message).split(NL)[0]);
  say('Nothing is findable until it succeeds. Fix this before going further.');
  process.exit(1);
}

// ---- prove it, rather than assume it ----------------------------------------------------------
let rules = 0;
try { rules = (JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || []).length; } catch { /* none */ }
say('');
say('rules now active : ' + rules + (rules ? '' : '   <-- still zero, something is wrong'));
say('brain            : ' + BRAIN);
say('');
say('Next, and it is the step that actually switches memory on:');
say('  node tools/install-hook.mjs');
say('');
const vectors = existsSync(join(BRAIN, 'index', 'embeddings.json'));
say('semantic recall  : ' + (vectors ? 'ON, the hook starts the embedder itself when it is not running' : 'OFF, keyword only. Run: npm install && node tools/build-index.mjs'));
