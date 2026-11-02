// The described search, enforced, and anything learned saved (The owner, 2026-10-15).
//
// The agent writes a better search than the raw message gives, and anything learned is saved without being asked.
// With hooks/agent-search.json on, pre-turn.mjs asks the agent
// to run brain-client.mjs search with its own needs and --learned items. This file holds it to that:
//   prompt  a new turn: nothing searched yet (keep-warm pings and system notifications are exempt).
//   tool    every tool is refused until the search ran; the search marks the turn searched and counts its
//           --learned items as open; a memory write (save, write, replace, delete) or "search --saved" settles them.
//   stop    the turn cannot end before the search, or while learned items are open.
// Fails open: after 3 refusals in a turn it lets go, and it never blocks while the brain is down (brain-gate.mjs
// owns that case), so a broken search command cannot lock a session. Tested on 30 real messages:
// 30 of 30 searched first, 0 refusals, +14% cost.
// The state machine is in recall-rules.mjs, shared with the mod (which runs it first; this hook is its backup
// through dispatch.mjs).
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freshState, onPrompt, onTool, onStop } from './recall-rules.mjs';

const HOME = join(homedir(), '.claude');
const BRAIN = process.env.HAVOK_BRAIN_DIR || join(dirname(fileURLToPath(import.meta.url)), '..');
let on = false; try { on = !!JSON.parse(readFileSync(join(BRAIN, 'hooks', 'agent-search.json'), 'utf8')).on; } catch { /* off */ }
if (!on) process.exit(0);
// A relay session (a claude -p that may only use ToolSearch and SendMessage) can never run the search, so the gate
// would stop every message it forwards; HAVOK_RELAY=1 exempts it. The session that receives the message does the search.
if (process.env.HAVOK_RELAY === '1') process.exit(0);

const raw = (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })();
let data = {}; try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const mode = process.argv[2];
const sid = String(data.session_id || 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'none';
const DIR = process.env.HAVOK_RECALL_GATE_DIR || join(HOME, 'havok-recall-gate');
try { mkdirSync(DIR, { recursive: true }); } catch { /* best effort */ }
const file = join(DIR, sid + '.json');
const get = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return freshState(); } };
const put = (s) => { try { writeFileSync(file, JSON.stringify(s)); } catch { /* best effort */ } };
const log = (o) => { if (!o) return; try { appendFileSync(join(DIR, 'gate-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), sid, ...o }) + '\n'); } catch { /* best effort */ } };
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const brainDown = () => { try { return !!JSON.parse(readFileSync(join(HOME, 'havok-brain-gate.json'), 'utf8')).down; } catch { return false; } };
const cli = join(BRAIN, 'tools', 'brain-client.mjs').replace(/\\/g, '/');
// Settle a step: write the state when it changed, log what happened, and refuse when the rules say so.
const settle = (s, r, refuse) => { if (r.state !== s) put(r.state); log(r.log); if (r.deny || r.block) out(refuse(r)); process.exit(0); };

if (mode === 'prompt') {
  const r = onPrompt(data.prompt, Date.now());
  put(r.state);
  log(r.log);
  process.exit(0);
}

const s = get();
if (brainDown()) process.exit(0);

if (mode === 'tool') {
  settle(s, onTool(s, String(data.tool_name || ''), data.tool_input || {}, cli, BRAIN), (r) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.deny } }));
}

if (mode === 'stop') {
  settle(s, onStop(s, cli), (r) => ({ decision: 'block', reason: r.block }));
}
process.exit(0);
