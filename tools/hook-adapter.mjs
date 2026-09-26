#!/usr/bin/env node
// Automatic recall for assistants whose hook format is not Claude Code's.
//
// The owner, 2026-09-26: "the other models need the hooks too". Each assistant calls its hook with its
// own input and expects its own output; this reads that format, runs the SAME recall (hooks/pre-turn.mjs)
// and answers in the format the assistant expects. Formats from the official docs and, for Antigravity,
// from a captured real call (2026-09-26):
//   gemini   Gemini CLI BeforeAgent: stdin {prompt, session_id, ...}; out hookSpecificOutput.additionalContext
//   agy      Antigravity PreInvocation: stdin {transcriptPath, invocationNum, ...}, NO prompt: the user's
//            message is the last USER_INPUT step of transcript_full.jsonl, inside <USER_REQUEST>. Recall
//            runs only when that step is the latest (the call right after the user wrote), not on every
//            tool loop. Out {injectSteps: [{ephemeralMessage}]}.
//   cursor   Cursor sessionStart only (beforeSubmitPrompt cannot add context): the standing rules and
//            the instruction to call the brain MCP tool; out {additional_context}.
//   cline    Cline UserPromptSubmit (macOS and Linux only): stdin {prompt, ...}; out {cancel, contextModification}.
// Never blocks the user's turn: on any failure it answers with nothing added.
//
//   node tools/hook-adapter.mjs gemini|agy|cursor|cline

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2];
const NL = String.fromCharCode(10);
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }

function recall(prompt, extra = {}) {
  if (!String(prompt || '').trim()) return '';
  const r = spawnSync(process.execPath, [join(BRAIN, 'hooks', 'pre-turn.mjs')], {
    input: JSON.stringify({ prompt, ...extra }), encoding: 'utf8', timeout: 20000, cwd: BRAIN, windowsHide: true,
  });
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
}

function rulesAndInstruction() {
  let rules = [];
  try { rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || []; } catch { /* none */ }
  return [
    'This computer has a long-term memory. Before answering anything that could depend on past facts, decisions,',
    'people, projects or rules, call the MCP tool `recall` (server "brain") with the user\'s message, then open what',
    'matters with `read_memory`. Save lasting facts as memories. If the memory is unreachable, say so first.',
    ...(rules.length ? ['', 'Standing rules:', ...rules.map((r, i) => (i + 1) + '. ' + (r.short || r.rule))] : []),
  ].join(NL);
}

function lastUserRequest(transcriptPath) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const p = String(transcriptPath || '').replace(/^~/, home);
  if (!p || !existsSync(p)) return { text: '', latest: false, context: '' };
  const steps = readFileSync(p, 'utf8').split(NL).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let idx = -1;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].type === 'USER_INPUT') { idx = i; break; }
  if (idx < 0) return { text: '', latest: false, context: '' };
  const content = String(steps[idx].content || '');
  const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const earlier = steps.slice(Math.max(0, idx - 6), idx).map((s) => String(s.content || '').replace(/<[^>]+>/g, ' ')).join(' ');
  return { text: (m ? m[1] : content).trim(), latest: idx === steps.length - 1, context: earlier.replace(/\s+/g, ' ').slice(-700) };
}

let out = {};
try {
  if (MODE === 'gemini') {
    const ctx = recall(input.prompt, { session_id: input.session_id });
    out = ctx ? { hookSpecificOutput: { additionalContext: ctx } } : {};
  } else if (MODE === 'agy') {
    const u = lastUserRequest(input.transcriptPath);
    const ctx = u.latest ? recall(u.text, { session_id: input.conversationId, ...(u.context ? { context: u.context } : {}) }) : '';
    out = ctx ? { injectSteps: [{ ephemeralMessage: ctx }] } : {};
  } else if (MODE === 'cursor') {
    out = { additional_context: rulesAndInstruction() };
  } else if (MODE === 'cline') {
    const ctx = recall(input.prompt || (input.userPromptSubmit && input.userPromptSubmit.prompt), {});
    out = { cancel: false, ...(ctx ? { contextModification: ctx } : {}) };
  }
} catch { out = MODE === 'cline' ? { cancel: false } : {}; }
process.stdout.write(JSON.stringify(out));
