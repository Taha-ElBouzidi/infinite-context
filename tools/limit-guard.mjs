// The 97 percent limit reserve for headless runs (claude -p jobs, lab scripts, bridges). They load no plugin hooks,
// so hooks/check-limit.mjs never sees them; on 2026-10-16 a headless lab run helped push the 5 hour limit to 100.
// Same reading as the hook: this machine's status line writes ~/.claude/havok-limits.json.
//   import { limitReached } from '<brain>/tools/limit-guard.mjs'; const why = limitReached(); if (why) stop(why);
//   node tools/limit-guard.mjs        exit 1 and the reason when the reserve is reached, exit 0 otherwise
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const BAR = 97;

export function limitReached(bar = BAR) {
  let lim = null;
  try { lim = JSON.parse(readFileSync(join(homedir(), '.claude', 'havok-limits.json'), 'utf8')); } catch { return null; }
  const live = (w) => (w && typeof w.used_percentage === 'number' && Number(w.resets_at) * 1000 > Date.now() ? w : null);
  const hit = [['5 hour', live(lim && lim.five)], ['weekly', live(lim && lim.week)]].filter(([, w]) => w && w.used_percentage >= bar);
  if (!hit.length) return null;
  return hit.map(([n, w]) => n + ' limit at ' + Math.round(w.used_percentage) + '%, resets ' + new Date(w.resets_at * 1000).toISOString()).join('; ');
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].replace(/\//g, '\\').toLowerCase()) {
  const why = limitReached();
  if (why) { process.stdout.write(why + '\n'); process.exit(1); }
  process.exit(0);
}
