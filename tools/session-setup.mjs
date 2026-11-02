// What session start changes outside the brain, kept apart so it can be tested (tools/session-setup.test.mjs).
//
// Privacy review of 0.4.80 (2026-11-02): the shared Claude Code settings carry the owner's own choices (bypass
// permissions, no attribution), and session start merged them into ~/.claude/settings.json on every machine that ran
// the hooks. In an install of the public repository (package.json names infinite-context) nothing here touches the
// user's settings or another tool's config; the owner's own brain keeps both.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function isInstall(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'infinite-context'; } catch { return false; }
}

// One set of Claude Code settings on every machine, like the brain (the owner, 2026-10-07). The cause that day: the
// permission mode on two machines had drifted from the one he set, so the auto-mode checker blocked work he had
// approved in chat. A rule written down kept losing to a file. hooks/claude-settings.json, where an instance has one,
// is the canonical block: every key in it is merged into ~/.claude/settings.json, objects key by key, so nothing it
// does not name is touched (per-machine paths, hooks, env and the old allow lists stay). Model and effort are left
// out, each machine keeps its own. Rewrites only when a value differs. Returns the keys it changed.
export function mergeSharedSettings({ here, home }) {
  if (isInstall(here)) return [];
  const shared = JSON.parse(readFileSync(resolve(here, 'hooks', 'claude-settings.json'), 'utf8'));
  // Compaction from 300,000 is only safe where an approval lock (a PreCompact hook) is registered by this same copy.
  if (!readFileSync(resolve(here, 'hooks', 'hooks.json'), 'utf8').includes('PreCompact')) delete shared.autoCompactWindow;
  const settingsPath = resolve(home, '.claude', 'settings.json');
  const raw = readFileSync(settingsPath, 'utf8');
  const s = JSON.parse(raw);
  const changed = [];
  const merge = (dst, src, path) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
        merge(dst[k], v, path + k + '.');
      } else if (JSON.stringify(dst[k]) !== JSON.stringify(v)) {
        dst[k] = v;
        changed.push(path + k);
      }
    }
  };
  merge(s, shared, '');
  // Smart compaction was rolled back on 2026-10-22, so the 300,000 window it set is taken out again; any other value
  // someone chose by hand is left alone.
  if (s.autoCompactWindow === 300000 && !('autoCompactWindow' in shared)) { delete s.autoCompactWindow; changed.push('autoCompactWindow removed'); }
  if (changed.length) {
    if (!existsSync(settingsPath + '.bak-shared')) writeFileSync(settingsPath + '.bak-shared', raw, 'utf8');
    writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  }
  return changed;
}

// Antigravity (agy) gets the brain the way Claude Code does (the owner, 2026-10-22): the brain as an MCP tool in
// ~/.gemini/config/mcp_config.json and the automatic recall hook (PreInvocation through tools/hook-adapter.mjs) in
// ~/.gemini/config/hooks.json. Paths point at this copy, so they move with each update. Only where agy is installed
// (~/.gemini exists), never in an install of the public repository; other keys in both files are kept. Returns whether
// it wired anything.
export function wireAntigravity({ here, home }) {
  if (isInstall(here) || !existsSync(resolve(home, '.gemini'))) return false;
  const gem = resolve(home, '.gemini', 'config');
  mkdirSync(gem, { recursive: true });
  const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
  const rd = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
  const mcpPath = resolve(gem, 'mcp_config.json');
  const mcp = rd(mcpPath);
  mcp.mcpServers = mcp.mcpServers || {};
  const want = { command: 'node', args: [fwd(resolve(here, 'tools', 'recall-mcp.mjs'))], disabled: false };
  if (JSON.stringify(mcp.mcpServers['havok-brain']) !== JSON.stringify(want)) { mcp.mcpServers['havok-brain'] = want; writeFileSync(mcpPath, JSON.stringify(mcp, null, 2)); }
  const hookPath = resolve(gem, 'hooks.json');
  const hk = rd(hookPath);
  const cmd = 'node ' + fwd(resolve(here, 'tools', 'hook-adapter.mjs')) + ' agy';
  const wantHook = { PreInvocation: [{ type: 'command', command: cmd, timeout: 30 }] };
  if (JSON.stringify(hk.brain) !== JSON.stringify(wantHook)) { hk.brain = wantHook; writeFileSync(hookPath, JSON.stringify(hk, null, 2)); }
  return true;
}

// core.hooksPath pointing at a folder that does not exist switches off every git hook of that clone, the user's own
// included; the engine export ships no hooks/git, so the gate is armed only where it exists.
export const wantsGitHooks = (brain) => existsSync(join(brain, 'hooks', 'git', 'pre-commit'));
