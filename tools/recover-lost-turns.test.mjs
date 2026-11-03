// tools/recover-lost-turns.mjs on a file shaped like DEV 2's (the locked-down client machine, 2026-11-03): a clean-up record, turns after
// it, two re-applies at resume that started new chains with copies of the record and dropped the turns in between.
//   node --test tools/recover-lost-turns.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planRecovery } from './recover-lost-turns.mjs';

const TOOL = join(resolve(dirname(fileURLToPath(import.meta.url))), 'recover-lost-turns.mjs');
let n = 0;
const row = (type, content, ts, parent, extra = {}) => ({ type, uuid: 'u' + (++n), parentUuid: parent, sessionId: 'old', timestamp: ts, message: { role: type, content }, ...extra });
const boundary = (ts) => ({ type: 'system', subtype: 'compact_boundary', uuid: 'b' + (++n), parentUuid: null, sessionId: 'old', timestamp: ts });

function devTwo() {
  const rows = [];
  const add = (r) => { rows.push(r); return r.uuid; };
  // The record: what the last real clean-up (14:33) left.
  let p = add(boundary('2026-11-03T14:33:53Z'));
  p = add(row('user', 'record opening', '2026-11-03T14:33:53Z', p));
  p = add(row('assistant', [{ type: 'text', text: 'record reply' }], '2026-11-03T14:33:54Z', p));
  // Work after it, on the first chain.
  p = add(row('user', 'question 14:53', '2026-11-03T14:53:29Z', p));
  p = add(row('assistant', [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } }], '2026-11-03T14:53:40Z', p));
  p = add(row('user', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'files' }], '2026-11-03T14:53:41Z', p));
  add(row('assistant', [{ type: 'text', text: 'answer 14:53' }], '2026-11-03T14:53:50Z', p));
  // Resume at 15:00: a new chain with copies of the record (copied times), the 14:53 turn dropped; work continues.
  let q = add(boundary('2026-11-03T15:00:43Z'));
  q = add(row('user', 'record opening', '2026-11-03T14:33:53Z', q));
  q = add(row('assistant', [{ type: 'text', text: 'record reply' }], '2026-11-03T14:33:54Z', q));
  q = add(row('user', 'question 15:26', '2026-11-03T15:26:35Z', q));
  add(row('assistant', [{ type: 'text', text: 'answer 15:26' }], '2026-11-03T15:26:50Z', q));
  // Resume at 16:11: again; only the newest turn is on the live chain.
  let r = add(boundary('2026-11-03T16:11:56Z'));
  r = add(row('user', 'record opening', '2026-11-03T14:33:53Z', r));
  r = add(row('assistant', [{ type: 'text', text: 'record reply' }], '2026-11-03T14:33:54Z', r));
  r = add(row('user', 'question 16:14', '2026-11-03T16:14:00Z', r));
  add(row('assistant', [{ type: 'text', text: 'answer 16:14' }], '2026-11-03T16:14:10Z', r));
  return rows;
}

test('the lost turns come back in time order between the record and the newest turn, with no copies of the record', () => {
  const plan = planRecovery(devTwo().map((r) => JSON.stringify(r)), Date.parse('2026-11-03T14:40:00Z'));
  assert.equal(plan.ok, true);
  const texts = plan.result.map((r) => (typeof r.message?.content === 'string' ? r.message.content : r.message?.content?.[0]?.text ?? r.message?.content?.[0]?.type ?? r.subtype));
  assert.deepEqual(texts, ['compact_boundary', 'record opening', 'record reply', 'question 14:53', 'tool_use', 'tool_result', 'answer 14:53', 'question 15:26', 'answer 15:26', 'question 16:14', 'answer 16:14']);
});

test('the tool writes a new session file relinked in order and leaves the original untouched; dry run writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  const file = join(dir, 'old.jsonl');
  const text = devTwo().map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(file, text);
  const dry = spawnSync(process.execPath, [TOOL, '--file', file, '--since', '2026-11-03T14:40:00Z', '--dry-run'], { encoding: 'utf8', windowsHide: true });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /lost rows to put back: 6/);
  assert.equal(readdirSync(dir).length, 1);
  const run = spawnSync(process.execPath, [TOOL, '--file', file, '--since', '2026-11-03T14:40:00Z'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(file, 'utf8'), text);
  const out = readdirSync(dir).find((f) => f !== 'old.jsonl');
  const rows = readFileSync(join(dir, out), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].parentUuid, null);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].parentUuid, rows[i - 1].uuid);
  assert.ok(rows.every((r) => r.sessionId === out.replace('.jsonl', '')));
});
