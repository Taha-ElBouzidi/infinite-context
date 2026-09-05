// Stop hook: a session that did real work and wrote NOTHING to the brain gets asked once, before
// it goes quiet, what it learned.
//
// WHY THIS EXISTS
// Measured 2026-08-23 across 14 days: 16 new memories, of which 7 were about the brain itself and
// 6 were behaviour rules about how to reply. ZERO covered the a client website, the
// a client voice mode, or the dashboard, all of which had weeks of active work. Every memory in
// that window came from one session, the personal assistant. The project sessions wrote nothing at
// all, and nobody noticed because a memory that was never written looks exactly like a topic that
// never came up.
//
// Two sessions proved the cost on the same day. Asked about the a client repositioning in the owner's own
// words, recall returned a car-site security memory, a GitHub CLI gotcha and his visa. Asked about
// the voice assistant, it returned five irrelevant memories and the answer had to come from reading
// source. The pipeline was fine. There was simply nothing to find.
//
// WHY A RULE WAS NOT ENOUGH
// feedback_propagate_new_tools_to_brain has said "immediately, not later" for weeks and is injected
// every single turn. It changed nothing. An instruction competing with the task in front of you
// loses. This asks at the one moment the work is finished and the context is still loaded.
//
// WHY IT ASKS INSTEAD OF DEMANDING
// It fires ONCE per session and only after real work. A hook that blocks every stop trains people
// to write a junk memory to get past it, which is worse than silence: it fills recall with noise.
// The question names what the session actually touched so the answer is specific.
//
// FAILS OPEN, ALWAYS. This runs at the end of every turn of every session. A crash here must never
// cost the owner a reply, so every path that is not a confident "nudge now" exits 0 silently.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

// Never loop: if we already blocked once and the model is continuing, stay out of the way.
if (data.stop_hook_active === true) process.exit(0);

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
if (!existsSync(MEM)) process.exit(0);

const sid = String(data.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
if (!sid) process.exit(0);

const STATE_DIR = join(homedir(), '.claude', 'havok-sessions');
const STATE = join(STATE_DIR, sid + '.json');

// How many memories exist right now, and the newest write time. Either moving means this session
// contributed something.
function snapshot() {
  const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  let newest = 0;
  for (const f of files) {
    try { const m = Math.floor(statSync(join(MEM, f)).mtimeMs); if (m > newest) newest = m; } catch { /* skip */ }
  }
  return { count: files.length, newest };
}

let state = null;
try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* first stop of this session */ }

const now = snapshot();

if (!state) {
  // First time we have seen this session. Record the baseline and say nothing: we cannot know yet
  // whether it did any work.
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ base: now, stops: 1, nudged: false }), 'utf8');
  } catch { /* cannot persist, stay silent rather than nag every turn */ }
  process.exit(0);
}

const wrote = now.count > (state.base?.count ?? now.count) || now.newest > (state.base?.newest ?? now.newest);
const stops = (state.stops || 1) + 1;

// SUBSTANTIAL means several completed turns, not a single question. Eight is a judgement call, not
// a measurement: low enough to catch a real working session, high enough that a quick lookup or a
// one-question chat is never interrupted.
const SUBSTANTIAL_STOPS = 8;

const shouldNudge = !wrote && !state.nudged && stops >= SUBSTANTIAL_STOPS;

try {
  writeFileSync(STATE, JSON.stringify({
    base: state.base, stops, nudged: state.nudged || shouldNudge,
  }), 'utf8');
} catch { /* best effort */ }

if (!shouldNudge) process.exit(0);

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: 'BRAIN CHECK, once per session. You have worked ' + stops + ' turns and written nothing '
    + 'to the brain. Measured on 2026-08-23: project sessions had written zero memories in 14 days '
    + 'while the brain filled up with notes about itself, so recall now returns noise for real '
    + 'project questions.\n\n'
    + 'Before you stop, answer honestly: did anything in this session become TRUE and DURABLE that '
    + 'is not already written down? A decision and its reason, a fact about a client or a system, a '
    + 'correction the owner gave you, a thing that broke and why.\n\n'
    + 'If YES, write it now: one fact per file in ' + MEM.split('\\').join('/') + ', then run '
    + 'node tools/build-index.mjs and commit. Write the description in the words the owner would type, '
    + 'not the technical name, or it will exist and still never be found.\n\n'
    + 'If genuinely NO, say so in one line and stop. This will not ask again this session.',
}));
