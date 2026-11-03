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

// The per-turn recall hook (hooks/pre-turn.mjs) registered in ~/.claude/settings.json, where hooks reload live in
// sessions already running. Returns a note when it wrote the file, '' otherwise. Strictly idempotent, touches only
// this one key, silent on failure. Moved out of check-session-start.mjs so it can be tested.
// Since 2026-11-03 the plugin registers the hook (hooks/hooks.json runs pre-turn.mjs --from-plugin) and it stands down
// where a hand-written entry still exists, so this writes nothing; the install step removes old entries once every
// live session runs the new plugin. Kept so older callers still load.
export function ensurePreTurnHook({ brain, home }) {
  if (brain || home) return '';
  try {
    const settingsPath = resolve(home, '.claude', 'settings.json');
    const desired = `node "${join(brain, 'hooks', 'pre-turn.mjs').replace(/\\/g, '/')}"`;
    const raw = readFileSync(settingsPath, 'utf8');
    const s = JSON.parse(raw);
    const current = s.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    if (current === desired) return '';
    // The mod gives recall on this machine once its install step removed the hook (machine.json present and
    // keepPreTurn not true): putting the hook back would double the recall text. Never removes it by itself
    // (HAVOK, 2026-11-03); an unreadable machine.json counts as no mod, so the hook still gives recall.
    let machine = null;
    try { machine = JSON.parse(readFileSync(resolve(home, '.claude', 'havok-mod', 'machine.json'), 'utf8')); } catch { machine = null; }
    if (machine && typeof machine === 'object' && !Array.isArray(machine) && machine.keepPreTurn !== true) return '';
    if (!existsSync(settingsPath + '.bak-preturn')) writeFileSync(settingsPath + '.bak-preturn', raw, 'utf8');
    s.hooks = s.hooks || {};
    s.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: desired, timeout: 10 }] }];
    writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
    return 'Installed the per-turn recall and reply-discipline hook into ~/.claude/settings.json. Settings hooks reload live, so it applies to sessions already running, not just new ones.';
  } catch { return ''; }
}

// The session start's brain verify. A run that ran out of time is reported as not finished, never as a failure (verify
// takes about 25 s on the host; HAVOK, 2026-11-03). A fast failure is checked once more after VERIFY_RETRY_MS: a verify
// run during a push or an index rebuild passes a moment later. A slow failure is not retried, so the whole session
// start still fits the dispatcher's 30 s. run() returns { ok, out, timedOut, ms }; sleep(ms) blocks. Tests in
// tools/verify-retry.test.mjs.
export const VERIFY_RETRY_MS = 5000;
export const VERIFY_RETRY_IF_UNDER_MS = 10000;
export function verifyWithRetry(run, sleep) {
  const first = run() || { ok: false, out: '' };
  if (first.ok || first.timedOut) return first;
  if (!(Number(first.ms) < VERIFY_RETRY_IF_UNDER_MS)) return first;
  sleep(VERIFY_RETRY_MS);
  const second = run() || { ok: false, out: '' };
  return { ...second, retried: true };
}

// MACHINE-WIDE GIT CHECKS (HAVOK, 2026-11-03): the secret scan and the commit message check also run as git hooks, so a
// commit is checked even when no Claude hook is armed. hooks/git-global and the two rule files are copied to a stable
// folder (~/.claude/havok-git-hooks, the same path whatever plugin version runs) and git's global core.hooksPath points
// there. A global hooksPath set to anything else is left alone and reported. Returns a note, or ''. Never throws.
export const GIT_HOOK_FILES = [['git-global/pre-commit', 'pre-commit'], ['git-global/commit-msg', 'commit-msg'], ['git-global/git-secret-scan.mjs', 'git-secret-scan.mjs'], ['git-global/git-commit-msg.mjs', 'git-commit-msg.mjs'], ['secret-rules.mjs', 'secret-rules.mjs'], ['commit-message-rules.mjs', 'commit-message-rules.mjs']];
export function ensureGlobalGitHooks({ hooksDir, home, git }) {
  try {
    const dest = resolve(home, '.claude', 'havok-git-hooks');
    mkdirSync(dest, { recursive: true });
    let copied = 0;
    for (const [from, to] of GIT_HOOK_FILES) {
      const src = join(hooksDir, from);
      if (!existsSync(src)) return '';
      const text = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
      const target = join(dest, to);
      let old = null;
      try { old = readFileSync(target, 'utf8'); } catch { /* new */ }
      if (old !== text) { writeFileSync(target, text, { encoding: 'utf8', mode: 0o755 }); copied++; }
    }
    const want = dest.replace(/\\/g, '/');
    const now = String(git(['config', '--global', '--get', 'core.hooksPath']) || '').trim().replace(/\\/g, '/');
    if (now && now !== want) return 'Git global core.hooksPath is ' + now + ', not the Havok git checks (' + want + '); left as it is.';
    if (!now) { git(['config', '--global', 'core.hooksPath', want]); return 'Armed the machine-wide git checks (secret scan, commit message) at ' + want + '.'; }
    return copied ? 'Updated the machine-wide git checks at ' + want + '.' : '';
  } catch { return ''; }
}
