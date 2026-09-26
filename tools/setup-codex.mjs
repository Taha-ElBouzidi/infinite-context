#!/usr/bin/env node
// Wires Codex (CLI, IDE extension and desktop app) to the brain by CONFIGURATION, not by persuasion.
//
// The owner, 2026-09-25: Codex is "stubborn and thinks its native solutions are better". A model can argue
// with an instruction; it cannot argue with a hook. Codex supports the same UserPromptSubmit and
// SessionStart hooks as Claude Code, with the same output shape (hookSpecificOutput.additionalContext),
// so hooks/pre-turn.mjs works unchanged (tested 2026-09-25 with Codex's documented stdin fields).
//
// What it writes, each with a backup of what was there:
//   <CODEX_HOME>/hooks.json   recall on every prompt, the session-start banner, and the shared rules file
//   <CODEX_HOME>/config.toml  Codex's own memories switched off, so there is one memory, not two, and the
//                             brain as an MCP server (tools/recall-mcp.mjs) for surfaces that do not run hooks
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
  // The memory as an MCP tool too (tools/recall-mcp.mjs), for Codex surfaces that may not run hooks:
  // every surface reads mcp_servers from this file. The owner's client runs the desktop app
  // (2026-09-25). The absolute node path, because a desktop app may not inherit the shell's PATH.
  const q = (s) => JSON.stringify(s.split(String.fromCharCode(92)).join('/'));
  setKey('mcp_servers.brain', 'command', q(process.execPath));
  setKey('mcp_servers.brain', 'args', '[' + q(BRAIN + '/tools/recall-mcp.mjs') + ']');
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
    'If you do NOT see a BRAIN RECALL block (the Codex app may not run hooks, or they are not trusted yet),',
    'call the brain MCP tool `recall` with the message of the user BEFORE answering, then open what matters with',
    '`read_memory`. If that tool is missing too, say so in your first sentence and read ' + BRAIN + '/REFLEX.md.',
    END,
  ].join(NL);
  const re = new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  agents = re.test(agents) ? agents.replace(re, block) : (agents.trim() ? agents.replace(/\s*$/, '') + NL + NL : '') + block;
  writeFileSync(agentsPath, agents.replace(/\s*$/, '') + NL);
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
// No session_id: a test run must not leave a turn counter in the user's .claude folder.
const base = { transcript_path: null, cwd: process.cwd(), model: 'test', permission_mode: 'default' };
test('session start', sessionStart, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
if (hasRules) test('rules', rulesHook, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
// The MCP path the desktop app uses: handshake, then one recall, exactly as Codex would send them.
{
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'setup-codex', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { message: 'what are the rules for writing a memory' } } },
  ].map((m) => JSON.stringify(m)).join(NL) + NL;
  const r = spawnSync(process.execPath, [BRAIN + '/tools/recall-mcp.mjs'], { input: lines, encoding: 'utf8', timeout: 60000 });
  let got = '';
  try { got = JSON.parse(r.stdout.trim().split(NL).pop()).result.content[0].text; } catch { /* reported below */ }
  const ok = got.split(NL).some((l) => l.startsWith('- ['));
  if (!ok) failed++;
  say((ok ? 'PASS ' : 'FAIL ') + 'MCP recall (the Codex app path): ' + got.split(NL).filter((l) => l.startsWith('- [')).length + ' memories');
}
const ctx = test('recall', preTurn, { ...base, hook_event_name: 'UserPromptSubmit', turn_id: '1', prompt: 'what are the rules for writing a memory' });
const hits = ctx.split(NL).filter((l) => l.startsWith('- ')).length;
say('recall returned ' + hits + ' memories' + (/^NOTE: semantic recall is OFF|^BRAIN RULES FAILED TO LOAD/m.test(ctx) ? ' (DEGRADED, read the context: it says why)' : ''));
say(failed ? 'SETUP HAS FAILURES: fix them before using Codex.' : 'All hooks run. Last step, in Codex: type /hooks and trust the hooks, then start a new session. In the Codex app, check that the MCP server "brain" is listed and enabled (Settings, MCP servers); the app may not run hooks, so that tool is its recall.');
process.exit(failed ? 1 : 0);
