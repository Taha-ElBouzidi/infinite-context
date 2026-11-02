// Stop hook: learning check after each turn, and a session that did real work and wrote NOTHING gets a note once;
// both are shown at the start of the next message by hooks/style-note.mjs, never as a forced rewrite.
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

//
// 2026-10-23, the owner: "that is a very important note to save what you learned. I think it should be even in the hook
// to check if you have learned anything ... it shouldn't consume anything." Two changes:
//   1. Nothing here blocks a reply any more: a forced rewrite costs a whole extra reply. Both checks leave a note
//      that hooks/style-note.mjs shows at the start of the NEXT message.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { snapshotOf, afterStop } from './memory-rules.mjs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }
if (data.stop_hook_active === true) process.exit(0);

const sid = String(data.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
if (!sid) process.exit(0);

const NOTES = join(homedir(), '.claude', 'havok-style-notes');
const note = (kind, text) => {
  try { mkdirSync(NOTES, { recursive: true }); writeFileSync(join(NOTES, sid + '.' + kind + '.json'), JSON.stringify({ at: new Date().toISOString(), text })); } catch { /* best effort */ }
};

// A per-turn keyword check (correction words in the owner's message, then a look for a save) was built and removed the
// same day, 2026-10-23. the owner: "I don't think this way you will be catching a lot of things ... let the agent decide
// if he learned anything new." The agent decides; the note below only asks it, once per session.

// ---- 2. Once per session: real work and nothing written (where the memories live) ----
// The memories live in the brain checkout the machine records in ~/.claude/havok-brain-path. The plugin's own folder
// was used before, and the plugin has carried no memory/ since it was split from the brain (2026-09-26), so this
// check had been silently off everywhere ("0 notes delivered in 7 days", hook review 2026-10-30). The rule itself
// is in memory-rules.mjs, shared with the mod (which runs it first; this hook is its backup).
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let marked = '';
try { marked = readFileSync(join(homedir(), '.claude', 'havok-brain-path'), 'utf8').split(String.fromCharCode(10))[0].trim(); } catch { /* none */ }
const MEM = [marked && join(marked, 'memory'), join(PLUGIN, 'memory')].find((d) => d && existsSync(d));
if (!MEM) process.exit(0);
const STATE_DIR = join(homedir(), '.claude', 'havok-sessions');
const STATE = join(STATE_DIR, sid + '.json');
let state = null;
try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* first stop of this session */ }
let now;
try { now = snapshotOf(readdirSync(MEM, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => { let m = 0; try { m = statSync(join(MEM, e.name)).mtimeMs; } catch { /* skip */ } return { name: e.name, mtimeMs: m }; })); } catch { process.exit(0); }
const r = afterStop(state, now, MEM);
try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(r.state), 'utf8'); } catch { /* stay silent */ }
if (r.note) note('work', r.note);
process.exit(0);
