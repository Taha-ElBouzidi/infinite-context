// The described search, enforced, and anything learned saved (recall-gate.mjs and the mod import this file).
// The owner, 2026-10-15: "anything that is learned gets saved automatically. I don't need to tell it." With
// hooks/agent-search.json on, every tool is refused until the turn searched the brain, and the turn cannot end
// before the search or while learned items are open. Off since 2026-10-22 (rolled back: no measured gain, +14
// percent cost). Pure: a state machine over { searched, learned, refusals, turnAt }; the callers keep the state.
// Fails open: after MAX_REFUSALS refusals in a turn it lets go.

export const MAX_REFUSALS = 3;

export const freshState = () => ({ searched: true, learned: 0, refusals: 0 });

export function exemptPrompt(prompt) {
  const p = String(prompt || '');
  return p.trim() === 'keep-warm ping' || p.trimStart().startsWith('<task-notification>') || p.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]');
}

export function onPrompt(prompt, now) {
  const exempt = exemptPrompt(prompt);
  return { state: { searched: exempt, learned: 0, refusals: 0, turnAt: now }, log: { ev: exempt ? 'exempt' : 'turn' } };
}

// A memory written with Write or Edit, in the brain folder this install runs from (brainDir). The folder used to be
// matched by the name havok-brain, so a clone named infinite-context never settled its learned items (privacy review of
// 0.4.80, 2026-11-02). Without brainDir, a memory file (memory/<type>_<name>.md) anywhere counts.
const MEMORY_FILE = /[\\/]memory[\\/](user|contact|project|feedback|reference)_[^\\/]+\.md$/i;
const slashes = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export function memoryFileIn(filePath, brainDir) {
  if (!brainDir) return MEMORY_FILE.test(String(filePath || ''));
  return slashes(filePath).startsWith(slashes(brainDir) + '/memory/');
}

// { state, deny?, log? }: state is the new state (unchanged when nothing changed).
export function onTool(s, tool, input, cli, brainDir) {
  const cmd = String((input && input.command) || '');
  const isShell = tool === 'Bash' || tool === 'PowerShell';
  if (isShell && /brain-client\.mjs"?\s+search\b/.test(cmd)) {
    if (/\s--saved\b/.test(cmd)) return { state: { ...s, learned: 0 }, log: { ev: 'saved-confirmed' } };
    const learned = (cmd.match(/--learned\b/g) || []).length;
    return { state: { ...s, searched: true, learned: (s.learned || 0) + learned }, log: { ev: 'search', learned, refusalsBefore: s.refusals || 0 } };
  }
  const memoryWrite = (isShell && /(save-brain\.mjs|replace-memory\.mjs|brain-client\.mjs"?\s+(write|delete)\b)/.test(cmd))
    || ((tool === 'Write' || tool === 'Edit') && memoryFileIn(input && input.file_path, brainDir));
  if (memoryWrite) return s.learned ? { state: { ...s, learned: 0 }, log: { ev: 'learned-saved' } } : { state: s };
  if (s.searched || (s.refusals || 0) >= MAX_REFUSALS || tool === 'ToolSearch') return { state: s };
  return {
    state: { ...s, refusals: (s.refusals || 0) + 1 },
    log: { ev: 'refused-tool', tool },
    deny: 'Search the brain first: run node "' + cli + '" search "<need>" ... [--learned "<what was learned>"] before any other tool.',
  };
}

// { state, block?, log? }
export function onStop(s, cli) {
  if ((s.refusals || 0) >= MAX_REFUSALS) return { state: s, log: (!s.searched || s.learned) ? { ev: 'gave-up', searched: !!s.searched, learned: s.learned || 0 } : undefined };
  if (!s.searched) {
    return { state: { ...s, refusals: (s.refusals || 0) + 1 }, log: { ev: 'refused-stop' },
      block: 'You have not searched the brain this turn. Run node "' + cli + '" search "<need>" ... [--learned "<what was learned>"], open what you need, then answer.' };
  }
  if (s.learned) {
    return { state: { ...s, refusals: (s.refusals || 0) + 1 }, log: { ev: 'refused-stop-learned', learned: s.learned },
      block: s.learned + ' learned item(s) of this turn are not settled. For each: write it as a new memory, or replace the memory it contradicts (the old one is archived), or, if it is already saved correctly, run node "' + cli + '" search --saved. Then finish.' };
  }
  return { state: s };
}
