#!/usr/bin/env node
// THE BACKUP HOOKS, ARMED ONLY WHEN THE MOD IS NOT HEALTHY (HAVOK, 2026-11-03; plan HAVOK-MOD/plans/hooks-off-while-mod-
// healthy.md). The brain plugin's hooks.json keeps only SessionStart: every other entry started a node process on every
// prompt, tool call and stop although the mod had done the work (1.6 s each on the locked-down client machine). Those backups now live in a
// marked block of ~/.claude/settings.json (settings hooks reload live) that exists only while some session is armed.
//
// Arm state, one file per session: ~/.claude/havok-backup-armed/<session>.json (outside havok-mod, which marks a machine with the mod) {armed, why, at}. Armed by the brain's
// SessionStart hook when the mod's mark for that start is missing (and for good on a machine without the mod), and by
// the status line when it shows "havok-mod off". Disarmed by the mod itself, at its start and each turn end, when it
// finds its own session armed. recompute() then writes or removes the block. Only the marked block is ever touched;
// settings.json that does not parse is left alone; the first write keeps a backup.
//
//   node tools/backup-arm.mjs arm <session> <why>    node tools/backup-arm.mjs disarm <session>
//   node tools/backup-arm.mjs recompute              node tools/backup-arm.mjs status
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const MARK = '--havok-backup';
export const EVENTS = { UserPromptSubmit: 35, PreToolUse: 140, Stop: 15, PostCompact: 10 };
export const ARMED_DIR = ['.claude', 'havok-backup-armed'];
export const PERMANENT = 'machine-without-mod';
const safe = (sid) => String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
const slash = (p) => String(p).replace(/\\/g, '/');

export function armedSessions(home) {
  const dir = join(home, ...ARMED_DIR);
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (j && j.armed === true) out.push({ sid: f.slice(0, -5), why: String(j.why || ''), at: j.at || '' }); } catch { /* unreadable: not armed */ }
  }
  return out;
}

function writeState(home, sid, state) {
  const s = safe(sid);
  if (!s) return false;
  const dir = join(home, ...ARMED_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, s + '.json'), JSON.stringify({ ...state, at: new Date().toISOString() }));
  return true;
}
export const arm = (home, sid, why) => writeState(home, sid, { armed: true, why: String(why || '').slice(0, 300) });
export const disarm = (home, sid) => writeState(home, sid, { armed: false });

// The settings.json block: one hook group per event, running the dispatcher with MARK. Returns what happened.
export function recompute(home, dispatchPath) {
  const file = join(home, '.claude', 'settings.json');
  let raw = '{}';
  try { raw = readFileSync(file, 'utf8'); } catch { /* no settings yet */ }
  let s;
  try { s = JSON.parse(raw || '{}'); } catch { return 'settings.json does not parse; left untouched'; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'settings.json is not an object; left untouched';
  const want = armedSessions(home).length > 0;
  const hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  const ours = (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => String(h?.command || '').includes(MARK));
  let changed = false;
  for (const [event, timeout] of Object.entries(EVENTS)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = list.filter((g) => !ours(g));
    const cmd = `node "${slash(dispatchPath)}" ${event} ${MARK}`;
    const next = want ? [...kept, { ...(event === 'PreToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command: cmd, timeout }] }] : kept;
    if (JSON.stringify(next) !== JSON.stringify(list)) { changed = true; if (next.length) hooks[event] = next; else delete hooks[event]; }
  }
  if (!changed) return want ? 'armed, block already in place' : 'not armed, no block';
  if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(file + '.bak-havok-backup')) copyFileSync(file, file + '.bak-havok-backup');
  const tmp = file + '.havok-tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return want ? 'armed: backup block written' : 'disarmed: backup block removed';
}

const DISPATCH = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'hooks', 'dispatch.mjs');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.HAVOK_HOME_DIR || process.env.USERPROFILE || process.env.HOME || homedir();
  const [cmd, sid, ...why] = process.argv.slice(2);
  if (cmd === 'arm') arm(home, sid, why.join(' '));
  else if (cmd === 'disarm') disarm(home, sid);
  else if (cmd === 'status') { console.log(JSON.stringify(armedSessions(home))); process.exit(0); }
  else if (cmd !== 'recompute') { console.error('usage: arm <session> <why> | disarm <session> | recompute | status'); process.exit(2); }
  console.log(recompute(home, DISPATCH));
}
