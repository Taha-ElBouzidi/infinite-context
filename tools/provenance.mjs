// Who wrote a memory: one line per write in provenance/ledger.jsonl (The owner, 2026-10-23: "add the id for the agent that
// saved the memory and modified it, so we know the level of trust, the name, the model, the effort"; it will feed the
// agent hierarchy dashboard and a view of the brain by agent instead of by machine).
//
// whoAmI() reads only what the writing process can see about itself, and never fails:
//   session  CLAUDE_CODE_SESSION_ID (Claude Code gives it to every tool shell); a helper shares its parent's
//   effort   CLAUDE_EFFORT
//   model    the last model named in that session's own transcript (not in the environment)
//   name     the --remote-control or --name value on the command line of CLAUDE_PID
// Missing values stay empty: an unknown is recorded as unknown, never guessed.
import { readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER = join(BRAIN, 'provenance', 'ledger.jsonl');

function tail(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

function modelOf(session) {
  if (!session) return '';
  const root = join(homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return ''; }
  for (const d of dirs) {
    const f = join(root, d, session + '.jsonl');
    if (!existsSync(f)) continue;
    try {
      const m = tail(f, 400000).match(/"model":"([^"]+)"/g);
      if (m) return m[m.length - 1].slice(9, -1);
    } catch { /* unreadable: unknown */ }
  }
  return '';
}

// The session name, in this order (found 2026-10-23 on a machine whose launcher resumes with no name flag, the name
// set by /rename): ~/.claude/sessions/<pid>.json (only the .json, never the
// .key files beside it), then the last custom-title in the transcript, then the command line flags.
function nameOf(pid, session) {
  if (!pid || !/^\d+$/.test(String(pid))) return '';
  try {
    const n = JSON.parse(readFileSync(join(homedir(), '.claude', 'sessions', pid + '.json'), 'utf8')).name;
    if (n) return String(n);
  } catch { /* no session file: next source */ }
  try {
    const root = join(homedir(), '.claude', 'projects');
    for (const d of readdirSync(root)) {
      const f = join(root, d, session + '.jsonl');
      if (!session || !existsSync(f)) continue;
      const m = tail(f, 2000000).match(/"customTitle":"([^"]+)"/g);
      if (m) return m[m.length - 1].slice(15, -1);
    }
  } catch { /* unreadable: next source */ }
  try {
    const cmd = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      : readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ');
    const m = cmd.match(/--(?:remote-control|name|n)\s+("([^"]+)"|'([^']+)'|(\S+))/);
    return m ? (m[2] || m[3] || m[4] || '') : '';
  } catch { return ''; }
}

export function whoAmI() {
  const session = process.env.CLAUDE_CODE_SESSION_ID || '';
  return {
    machine: hostname(),
    session,
    name: nameOf(process.env.CLAUDE_PID, session),
    model: modelOf(session),
    effort: process.env.CLAUDE_EFFORT || '',
    agent: session ? 'claude-code' : (process.env.HAVOK_AGENT || 'unknown'),
  };
}

// entries: [{slug, action}] plus the writer. Never throws: a ledger miss must not lose a memory write.
export function record(entries, by, via) {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    const at = new Date().toISOString();
    const clean = (v) => String(v || '').replace(/[\r\n]/g, ' ').slice(0, 120);
    const who = {};
    for (const k of ['machine', 'session', 'name', 'model', 'effort', 'agent']) who[k] = clean(by && by[k]);
    appendFileSync(LEDGER, entries.map((e) => JSON.stringify({ at, slug: clean(e.slug), action: clean(e.action),
      ...(e.to ? { to: clean(e.to) } : {}), ...(e.why ? { why: String(e.why).replace(/[\r\n]/g, ' ').slice(0, 300) } : {}),
      ...(e.commit ? { commit: clean(e.commit) } : {}), ...who, via: clean(via) })).join('\n') + '\n');
  } catch { /* best effort */ }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(whoAmI(), null, 1) + '\n');
}
