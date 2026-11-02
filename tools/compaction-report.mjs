#!/usr/bin/env node
// Is smart compaction good? Reads the compaction rows every machine sends (.compaction-log.jsonl on the brain server)
// and prints one line per compaction: machine, session, trigger, size before and after, how many automatic attempts
// were locked before it, minutes from approval to compaction, and how many of the next 10 messages had the owner
// repeating or correcting something.  node tools/compaction-report.mjs [--json]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN = join(dirname(fileURLToPath(import.meta.url)), '..');
let rows = [];
try { rows = readFileSync(join(BRAIN, '.compaction-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
const out = [];
for (const c of rows.filter((r) => r.ev === 'compacted')) {
  const same = rows.filter((r) => r.session === c.session && r.host === c.host);
  const before = same.filter((r) => r.at < c.at);
  const lastCompact = before.filter((r) => r.ev === 'compacted').map((r) => r.at).pop() || '';
  const approved = before.filter((r) => r.ev === 'approved' && r.at > lastCompact).pop();
  const after = same.filter((r) => r.ev === 'after' && r.at > c.at).slice(0, 10);
  out.push({
    at: c.at, host: c.host, session: String(c.session).slice(0, 8), trigger: c.trigger,
    before: c.ctxBefore, after: after.length ? after[0].ctx : null, summaryChars: c.summaryChars,
    lockedBefore: before.filter((r) => r.ev === 'precompact' && r.decision === 'locked' && r.at > lastCompact).length,
    approvalToCompactMin: approved ? Math.round((Date.parse(c.at) - Date.parse(approved.at)) / 60000) : null,
    messagesWatched: after.length, repeats: after.filter((r) => r.repeat).length,
  });
}
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(out, null, 1) + '\n'); process.exit(0); }
if (!out.length) { process.stdout.write('No compaction recorded yet. Locked attempts so far: ' + rows.filter((r) => r.decision === 'locked').length + '\n'); process.exit(0); }
for (const o of out) process.stdout.write([o.at.slice(0, 16), o.host, o.session, o.trigger, 'before ' + o.before, 'after ' + o.after, 'locked ' + o.lockedBefore, 'approval to compact ' + o.approvalToCompactMin + ' min', 'repeats ' + o.repeats + '/' + o.messagesWatched].join(' | ') + '\n');
