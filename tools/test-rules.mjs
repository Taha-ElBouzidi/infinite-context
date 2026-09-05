// node tools/test-rules.mjs
//
// Robustness suite for the always-on rules pipeline: memory frontmatter -> build-index ->
// index/rules.json -> hooks/pre-turn.mjs -> the text an agent actually reads.
//
// This pipeline decides how every agent on every machine behaves on every turn, and most of its
// failure modes are SILENT. A missing file, a deleted rule line, a stray newline: none of them
// throw, they just quietly remove a rule and the agent goes back to being long, over-claiming
// and contradicting the owner. Silence is the enemy here, so each case below asserts that something
// visible happens.
//
// Fixtures use HAVOK_BRAIN to point the hook at a throwaway directory, so the real brain is
// never mutated by a test.

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(BRAIN, 'hooks', 'pre-turn.mjs');
const FIX = join(tmpdir(), 'brain-rule-tests');

let pass = 0; const fails = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  pass  ' + name); }
  else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
};

// Run the hook against a fixture brain and return the injected text.
function inject(brainDir, prompt = 'hello') {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ prompt }), encoding: 'utf8',
    env: { ...process.env, HAVOK_BRAIN: brainDir },
  });
  try { return JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || ''; }
  catch { return ''; }
}

function fixture(name, rulesJson) {
  const d = join(FIX, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, 'memory'), { recursive: true });
  mkdirSync(join(d, 'index'), { recursive: true });
  // isBrain now demands REFLEX.md and index/rules.json, not just a memory/ directory, so a
  // fixture must carry them or the hook rejects it and silently falls back to the REAL brain.
  // That fallback is the safe behaviour in production and a false pass in a test: the fixture
  // looks healthy because it quietly loaded the live rules instead of its own broken ones.
  writeFileSync(join(d, 'REFLEX.md'), '# fixture brain', 'utf8');
  if (rulesJson !== null) writeFileSync(join(d, 'index', 'rules.json'), rulesJson, 'utf8');
  return d;
}

console.log('\n--- the live brain ---');
const live = inject(BRAIN);
const liveRules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules;

// The rules an agent must never lose. verify.mjs checks the file is populated; it cannot know
// that a specific rule was deleted, and losing exactly one is the likeliest real accident.
const REQUIRED = [
  'feedback_reply_length',
  'feedback_never_guess_always_check',
  'feedback_verify_before_claiming',
  'feedback_he_is_right_until_proven',
  'feedback_push_on_urgent',
  'reference_brain_vault_keychain',
  'feedback_no_em_dashes',
];
for (const slug of REQUIRED) {
  check(`required rule present: ${slug}`, liveRules.some((r) => r.slug === slug));
}
check('every required rule reaches the injection',
  REQUIRED.every((s) => live.includes(liveRules.find((r) => r.slug === s)?.rule?.slice(0, 40) ?? '\u0000')));
check('rules are numbered in the injection', /\n2\. /.test(live) && /\n6\. /.test(live));
check('rule_order values are unique',
  new Set(liveRules.map((r) => r.order)).size === liveRules.length,
  'orders: ' + liveRules.map((r) => r.order).join(','));
check('no rule contains a newline (would break the numbered list)',
  !liveRules.some((r) => /[\r\n]/.test(r.rule)));
check('no rule carries leftover YAML escaping',
  !liveRules.some((r) => r.rule.includes('\\"') || r.rule.includes("\'")));
check('injection stays under 1200 tokens (it is paid every turn)',
  Math.round(live.length / 4) < 1200, '~' + Math.round(live.length / 4) + ' tokens');

console.log('\n--- failure modes, each must be VISIBLE not silent ---');
const noFile = fixture('no-rules-file', null);
const outA = inject(noFile);
check('missing rules.json says so in the injection', /rules unavailable|FAILED TO LOAD/i.test(outA), JSON.stringify(outA.slice(0, 80)));

const emptyArr = fixture('empty-rules', JSON.stringify({ rules: [] }));
const outB = inject(emptyArr);
check('empty rules array still emits the reply header', outB.includes('HOW TO REPLY TO'));

const badJson = fixture('bad-json', '{ this is not json');
const outC = inject(badJson);
check('corrupt rules.json says so rather than going silent', /rules unavailable|FAILED TO LOAD/i.test(outC), JSON.stringify(outC.slice(0, 80)));

const wrongShape = fixture('wrong-shape', JSON.stringify({ rules: 'not-an-array' }));
const outD = inject(wrongShape);
check('rules not an array does not crash the turn', outD.length > 0);

console.log('\n--- the gate ---');
const v = spawnSync('node', [join(BRAIN, 'tools', 'verify.mjs')], { encoding: 'utf8' });
check('verify passes on the live brain', v.status === 0);

// Hide rules.json and confirm the gate actually fails, rather than passing by omission.
const rulesPath = join(BRAIN, 'index', 'rules.json');
const backup = readFileSync(rulesPath, 'utf8');
try {
  writeFileSync(rulesPath, JSON.stringify({ rules: [] }), 'utf8');
  const v2 = spawnSync('node', [join(BRAIN, 'tools', 'verify.mjs')], { encoding: 'utf8' });
  check('verify FAILS when rules.json is emptied', v2.status !== 0);
} finally {
  writeFileSync(rulesPath, backup, 'utf8');
}

const v3 = spawnSync('node', [join(BRAIN, 'tools', 'verify.mjs')], { encoding: 'utf8' });
check('live brain restored and passing again', v3.status === 0);

rmSync(FIX, { recursive: true, force: true });
console.log(`\n${fails.length ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
