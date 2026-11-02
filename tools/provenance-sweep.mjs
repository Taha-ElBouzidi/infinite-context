// Run by hooks/git/post-commit after every brain commit, whatever made it. The owner, 2026-10-23: "even replace, write
// and edits": every change to a memory gets a ledger line. The server, save-brain and replace-memory write their own
// lines; this adds one for any memory the commit changed that has no line from the last 30 minutes, which covers hand
// edits committed with git, scripts on the host, the sync sweep, and renames (a delete plus a new). The writer is
// whoever ran the commit (an agent shell has its session; a scheduled task is recorded as unknown). The line is left
// in provenance/ledger.jsonl and goes in with the next brain commit. Never fails the commit.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whoAmI, record, LEDGER } from './provenance.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW_MS = 30 * 60 * 1000;
try {
  const git = (args) => execFileSync('git', ['-C', BRAIN, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const commit = git(['rev-parse', '--short', 'HEAD']).trim();
  let diff = '';
  try { diff = git(['diff', '--name-status', '-M', 'HEAD~1', 'HEAD', '--', 'memory/']); } catch { process.exit(0); }
  const changes = [];
  for (const line of diff.split('\n').filter(Boolean)) {
    const [code, a, b] = line.split('\t');
    const slugOf = (p) => (p || '').split('/').pop().replace(/\.md$/, '');
    if (!/\.md$/.test(a || '') || /MEMORY\.md$/.test(a)) continue;
    if (code.startsWith('R')) changes.push({ slug: slugOf(a), action: 'rename', to: slugOf(b) });
    else changes.push({ slug: slugOf(a), action: code === 'A' ? 'new' : code === 'D' ? 'delete' : 'update' });
  }
  if (!changes.length) process.exit(0);
  const recent = new Set();
  if (existsSync(LEDGER)) {
    const since = Date.now() - WINDOW_MS;
    for (const l of readFileSync(LEDGER, 'utf8').trim().split('\n').slice(-500)) {
      try { const o = JSON.parse(l); if (Date.parse(o.at) >= since) recent.add(o.slug); } catch { /* skip */ }
    }
  }
  const missing = changes.filter((c) => !recent.has(c.slug)).map((c) => ({ ...c, commit }));
  if (missing.length) record(missing, whoAmI(), 'git-commit');
} catch { /* never fail a commit over the ledger */ }
