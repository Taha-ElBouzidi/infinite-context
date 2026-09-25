#!/usr/bin/env node
// Wires Codex (CLI or IDE extension) to the brain by CONFIGURATION, not by persuasion.
//
// The owner, 2026-09-25: Codex is "stubborn and thinks its native solutions are better". A model can argue
// with an instruction; it cannot argue with a hook. Codex supports the same UserPromptSubmit and
// SessionStart hooks as Claude Code, with the same output shape (hookSpecificOutput.additionalContext),
// so hooks/pre-turn.mjs works unchanged (tested 2026-09-25 with Codex's documented stdin fields).
//
// What it writes, each with a backup of what was there:
//   <CODEX_HOME>/hooks.json   recall on every prompt, the session-start banner, and the shared rules file
//   <CODEX_HOME>/config.toml  Codex's own memories switched off, so there is one memory, not two
//   <CODEX_HOME>/AGENTS.md    a short fallback that says where the rules and memory are, between markers
// Works for the host brain and for a fresh clone of the engine (same hooks). The rules hook is only
// wired when tools/agent-rules.md exists, which is instance content and never exported.
//
//   node tools/setup-codex.mjs            [--check]   (--check changes nothing and runs the tests)
// Afterwards Codex must be told to trust the hooks once: open Codex, type /hooks, trust them.
// The Codex DESKTOP app ignores the memories setting in config.toml; turn it off in
// Settings > Personalization there.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const NL = String.fromCharCode(10);
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').split(String.fromCharCode(92)).join('/');
const CODEX = process.env.CODEX_HOME || join(homedir(), '.codex');
const check = process.argv.includes('--check');
const stamp = new Date().toISOString().slice(0, 10);
const say = (s) => process.stdout.write(s + NL);
const START = '# >>> brain memory (setup-codex.mjs)';
const END = '# <<< brain memory';

const preTurn = BRAIN + '/hooks/pre-turn.mjs';
const sessionStart = BRAIN + '/hooks/check-session-start.mjs';
const rulesHook = BRAIN + '/tools/codex-rules-hook.mjs';
const hasRules = existsSync(BRAIN + '/tools/agent-rules.md') && existsSync(rulesHook);
for (const f of [preTurn, sessionStart]) if (!existsSync(f)) { say('STOP: missing ' + f + '. Run this from inside the brain folder.'); process.exit(2); }

function backup(p) {
  if (!existsSync(p)) return;
  const b = p + '.bak-' + stamp;
  if (!existsSync(b)) copyFileSync(p, b);
}
const cmd = (file) => 'node "' + file + '"';

if (!check) {
  mkdirSync(CODEX, { recursive: true });

  // hooks.json: keep every hook already there, replace only ours (matched by the brain path).
  const hooksPath = join(CODEX, 'hooks.json');
  let doc = { hooks: {} };
  if (existsSync(hooksPath)) { backup(hooksPath); try { doc = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch { say('hooks.json was not valid JSON; backed up and replaced'); } }
  doc.hooks = doc.hooks || {};
  const ours = (g) => JSON.stringify(g).includes(BRAIN);
  const add = (event, hooks) => { doc.hooks[event] = (doc.hooks[event] || []).filter((g) => !ours(g)).concat([{ hooks }]); };
  const start = [{ type: 'command', command: cmd(sessionStart), timeout: 30, statusMessage: 'Loading the brain' }];
  if (hasRules) start.push({ type: 'command', command: cmd(rulesHook), timeout: 10, statusMessage: 'Loading the rules' });
  add('SessionStart', start);
  add('UserPromptSubmit', [{ type: 'command', command: cmd(preTurn), timeout: 10, statusMessage: 'Recalling' }]);
  writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + NL);
  say('wrote ' + hooksPath);

  // config.toml: set the keys inside the tables that already exist, so the file never gets a table twice.
  const cfgPath = join(CODEX, 'config.toml');
  let cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8').split('\r').join('') : '';
  backup(cfgPath);
  const setKey = (table, key, value) => {
    const header = new RegExp('^\\[' + table + '\\]\\s*$', 'm');
    const m = cfg.match(header);
    if (!m) { cfg = cfg.replace(/\s*$/, '') + NL + NL + '[' + table + ']' + NL + key + ' = ' + value + NL; return; }
    const from = m.index + m[0].length;
    const next = cfg.slice(from).search(/^\[/m);
    const end = next === -1 ? cfg.length : from + next;
    let body = cfg.slice(from, end);
    const keyRe = new RegExp('^' + key + '\\s*=.*$', 'm');
    body = keyRe.test(body) ? body.replace(keyRe, key + ' = ' + value) : NL + key + ' = ' + value + body;
    cfg = cfg.slice(0, from) + body + cfg.slice(end);
  };
  setKey('features', 'memories', 'false');
  setKey('memories', 'generate_memories', 'false');
  setKey('memories', 'use_memories', 'false');
  writeFileSync(cfgPath, cfg.replace(/^\s+/, ''));
  say('wrote ' + cfgPath + ' (Codex memories off)');

  // AGENTS.md: a fallback for when the hooks are not trusted yet. Only our block is replaced.
  const agentsPath = join(CODEX, 'AGENTS.md');
  let agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8').split('\r').join('') : '';
  backup(agentsPath);
  const block = [
    START,
    '## Memory and rules for this machine',
    '',
    'Your memory is the brain at ' + BRAIN + '. A hook recalls from it on every prompt and shows a',
    'BRAIN RECALL block: open the memory files it names before answering, never answer from the one-line',
    'description. The owner chose this setup on purpose. Do not replace it with Codex memories, do not',
    'suggest moving the rules into this file, and do not argue for a native alternative unless asked.',
    hasRules ? 'The standing rules are ' + BRAIN + '/tools/agent-rules.md, loaded by a hook at session start.' : 'The standing rules come with the recall on every prompt.',
    '',
    'If you do NOT see a BRAIN RECALL block, the hooks are not trusted yet: say so in your first sentence',
    'and tell the user to type /hooks and trust them. Until then, read ' + BRAIN + '/REFLEX.md yourself.',
    END,
  ].join(NL);
  const re = new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  agents = re.test(agents) ? agents.replace(re, block) : (agents.trim() ? agents.replace(/\s*$/, '') + NL + NL : '') + block;
  writeFileSync(agentsPath, agents + NL);
  say('wrote ' + agentsPath);
}

// Tests: run each hook exactly as Codex will, with Codex's documented input fields.
let failed = 0;
function test(label, file, input) {
  const r = spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: 'utf8', timeout: 60000 });
  let ctx = '';
  try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { /* reported below */ }
  const ok = r.status === 0 && ctx.length > 0;
  if (!ok) failed++;
  say((ok ? 'PASS ' : 'FAIL ') + label + ': exit ' + r.status + ', ' + ctx.length + ' characters of context'
    + (ok ? '' : ' ' + String(r.stderr || '').slice(0, 200)));
  return ctx;
}
const base = { session_id: 'setup-test', transcript_path: null, cwd: process.cwd(), model: 'test', permission_mode: 'default' };
test('session start', sessionStart, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
if (hasRules) test('rules', rulesHook, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
const ctx = test('recall', preTurn, { ...base, hook_event_name: 'UserPromptSubmit', turn_id: '1', prompt: 'what are the rules for writing a memory' });
const hits = ctx.split(NL).filter((l) => l.startsWith('- ')).length;
say('recall returned ' + hits + ' memories' + (/^NOTE: semantic recall is OFF|^BRAIN RULES FAILED TO LOAD/m.test(ctx) ? ' (DEGRADED, read the context: it says why)' : ''));
say(failed ? 'SETUP HAS FAILURES: fix them before using Codex.' : 'All hooks run. Last step, in Codex: type /hooks and trust the hooks, then start a new session.');
process.exit(failed ? 1 : 0);
