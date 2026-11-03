#!/usr/bin/env node
// The plan setting: how much the assistant may spend, sized to the person's plan (hooks/plan-rules.mjs says why).
//
//   node tools/plan.mjs                     show the plan in force and what it allows
//   node tools/plan.mjs small               set it: small (about 20 dollars a month, the default), standard or large
//
// Stored as "plan" in brain.json, which stays on this machine (.gitignore). The recall hook reads it on every turn,
// so a change applies from the next message. Setting it also rewords the seed rule about helpers when this brain
// still holds the wording installs had before 0.4.89, which told the assistant to start helpers on its own; a rule
// the person edited is left as it is.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { PLANS, DEFAULT_PLAN, planOf, planLine, migrateSubAgentRule } from '../hooks/plan-rules.mjs';

export { PLANS, DEFAULT_PLAN };
const NL = String.fromCharCode(10);

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
export const isPublicInstall = (brain) => (readJson(join(brain, 'package.json')) || {}).name === 'infinite-context';

// The plan in force for this brain, or null when none applies (see planOf).
export function readPlan(brain) {
  return planOf(readJson(join(brain, 'brain.json')) || {}, isPublicInstall(brain));
}

// Writes the plan into brain.json, keeping every other setting. With onlyIfUnset, a plan already set is kept. Returns
// the plan now set and whether the seed rule was reworded (the caller then rebuilds the index).
export function setPlan(brain, plan, { onlyIfUnset = false } = {}) {
  if (!PLANS.includes(plan)) throw new Error('plan must be one of: ' + PLANS.join(', '));
  const file = join(brain, 'brain.json');
  if (existsSync(file) && !readJson(file)) throw new Error('brain.json does not parse; fix it first, nothing was changed');
  const cfg = readJson(file) || {};
  if (!(onlyIfUnset && PLANS.includes(cfg.plan))) {
    cfg.plan = plan;
    writeFileSync(file, JSON.stringify(cfg, null, 2) + NL, 'utf8');
  }
  let migrated = false;
  const seed = join(brain, 'memory', 'feedback_sub_agents_get_a_ready_brief.md');
  if (existsSync(seed)) {
    const next = migrateSubAgentRule(readFileSync(seed, 'utf8'));
    if (next) { writeFileSync(seed, next, 'utf8'); migrated = true; }
  }
  return { plan: cfg.plan, migrated };
}

function main(argv) {
  const brain = process.env.HAVOK_BRAIN || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const want = String(argv[0] || '').toLowerCase();
  if (want) {
    if (!PLANS.includes(want)) { console.log('usage: node tools/plan.mjs [' + PLANS.join(' | ') + ']'); process.exit(2); }
    let r;
    try { r = setPlan(brain, want); } catch (e) { console.log(e.message); process.exit(1); }
    console.log('plan : ' + r.plan + ' (brain.json)');
    if (r.migrated) {
      console.log('the seed rule about helpers now follows the plan; rebuilding the index');
      try { execFileSync(process.execPath, [join(brain, 'tools', 'build-index.mjs')], { cwd: brain, stdio: 'ignore', timeout: 300000, windowsHide: true }); }
      catch { console.log('build-index failed: run node tools/build-index.mjs'); process.exit(1); }
    }
  }
  const plan = readPlan(brain);
  if (!want) console.log('plan : ' + (plan || 'none set') + (plan && !PLANS.includes((readJson(join(brain, 'brain.json')) || {}).plan) ? ' (not set, the default for an install)' : ''));
  if (plan) console.log(planLine(plan));
  console.log('Applies from the next message. Change it with: node tools/plan.mjs ' + PLANS.join(' | '));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
