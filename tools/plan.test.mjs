// node --test tools/plan.test.mjs
// The plan setting (hooks/plan-rules.mjs, tools/plan.mjs): a small plan starts no helper or background work on its
// own, an install with no setting counts as small, a brain that is not an install and has no setting is unchanged,
// and the old seed rule that told every install to start helpers in the background is reworded in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planOf, planLine, PLANS, migrateSubAgentRule, SUB_AGENT_RULE, OLD_SUB_AGENT_RULE, OLD_SUB_AGENT_SHORT, SUB_AGENT_SHORT } from '../hooks/plan-rules.mjs';
import { setPlan, readPlan } from './plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN = resolve(HERE, '..');

function brain({ pkgName, cfg } = {}) {
  const b = mkdtempSync(join(tmpdir(), 'plan-'));
  mkdirSync(join(b, 'memory'));
  mkdirSync(join(b, 'index'));
  writeFileSync(join(b, 'REFLEX.md'), '# Reflex\n');
  writeFileSync(join(b, 'index', 'rules.json'), JSON.stringify({ rules: [{ rule: 'A TEST RULE.', short: 'A TEST RULE.' }] }));
  if (pkgName) writeFileSync(join(b, 'package.json'), JSON.stringify({ name: pkgName }));
  if (cfg) writeFileSync(join(b, 'brain.json'), JSON.stringify(cfg));
  return b;
}
const q = (s) => '"' + s.split('"').join('\\"') + '"';

test('the plan in force: the setting when valid, small in an install without one, none elsewhere', () => {
  assert.deepEqual(PLANS, ['small', 'standard', 'large']);
  assert.equal(planOf({ plan: 'large' }, true), 'large');
  assert.equal(planOf({ plan: 'Standard ' }, false), 'standard');
  assert.equal(planOf({}, true), 'small');
  assert.equal(planOf({ plan: 'huge' }, true), 'small');
  assert.equal(planOf({}, false), null);
  assert.equal(planLine(null), '');
});

test('a small plan starts no helper and no background work unless asked; a large plan may', () => {
  const small = planLine('small');
  assert.match(small, /Start no helper agent/);
  assert.match(small, /no background task/);
  assert.match(small, /unless the person asks/);
  assert.match(small, /small or balanced model/);
  assert.match(small, /low or medium effort/);
  assert.match(planLine('standard'), /at most two at a time/);
  assert.match(planLine('large'), /in the background and in parallel/);
});

test('setPlan writes brain.json, keeps the other settings, and keeps a set plan when asked to', () => {
  const b = brain({ pkgName: 'infinite-context', cfg: { backupRemote: 'mine', rulesMode: 'short' } });
  try {
    assert.equal(readPlan(b), 'small');
    assert.equal(setPlan(b, 'large').plan, 'large');
    assert.deepEqual(JSON.parse(readFileSync(join(b, 'brain.json'), 'utf8')), { backupRemote: 'mine', rulesMode: 'short', plan: 'large' });
    assert.equal(setPlan(b, 'small', { onlyIfUnset: true }).plan, 'large');
    assert.equal(readPlan(b), 'large');
    assert.throws(() => setPlan(b, 'huge'));
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('the old seed rule is reworded in place; one the person edited is left alone', () => {
  const old = '---\nname: x\nrule: ' + q(OLD_SUB_AGENT_RULE) + '\nrule_short: ' + q(OLD_SUB_AGENT_SHORT) + '\n---\nbody\n';
  const next = migrateSubAgentRule(old);
  assert.ok(next.includes('rule: ' + q(SUB_AGENT_RULE)));
  assert.ok(next.includes('rule_short: ' + q(SUB_AGENT_SHORT)));
  assert.equal(migrateSubAgentRule(old.replace('in parallel', 'side by side')), null);
  const b = brain({ pkgName: 'infinite-context' });
  try {
    writeFileSync(join(b, 'memory', 'feedback_sub_agents_get_a_ready_brief.md'), old);
    assert.equal(setPlan(b, 'small').migrated, true);
    assert.doesNotMatch(readFileSync(join(b, 'memory', 'feedback_sub_agents_get_a_ready_brief.md'), 'utf8'), /in the background and in parallel/);
    assert.equal(setPlan(b, 'small').migrated, false);
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('a fresh install seeds the reworded rule, never the old one', () => {
  const init = readFileSync(join(HERE, 'init.mjs'), 'utf8');
  assert.ok(!init.includes('run them as sub-agents in the background and in parallel'));
  assert.match(init, /rule: SUB_AGENT_RULE/);
});

const hook = (b) => spawnSync(process.execPath, [join(BRAIN, 'hooks', 'pre-turn.mjs')], {
  input: JSON.stringify({ prompt: 'what did we decide about the invoice' }), encoding: 'utf8', timeout: 30000,
  env: { ...process.env, HAVOK_BRAIN: b, HAVOK_HOME: join(b, 'home'), INFINITE_CONTEXT_UPDATING: '1' },
});
const context = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return ''; } };

test('the recall hook adds the plan line to every turn: small by default in an install, the set plan otherwise', () => {
  const pub = brain({ pkgName: 'infinite-context' });
  const big = brain({ pkgName: 'infinite-context', cfg: { plan: 'large' } });
  const other = brain({ pkgName: 'someone-elses-brain' });
  try {
    const c1 = context(hook(pub));
    assert.match(c1, /A TEST RULE/, 'the hook did not answer: ' + c1.slice(0, 200));
    assert.match(c1, /PLAN: SMALL/);
    assert.match(context(hook(big)), /PLAN: LARGE/);
    const c3 = context(hook(other));
    assert.match(c3, /A TEST RULE/);
    assert.doesNotMatch(c3, /PLAN:/);
  } finally { for (const b of [pub, big, other]) rmSync(b, { recursive: true, force: true }); }
});
