// Whole-brain verification. This is what replaced the PR requirement.
//
// The PR rule was ceremony: the owner is the only reviewer, he merged without diffing, and
// it caught none of the three real bugs shipped into brain tooling on 2026-07-26 (a
// CRLF parse failure, a self-invalidating index, a stamper that flattened 88 dates).
// Negative tests and reflect.mjs caught all three. So the gate is now deterministic
// and always runs, instead of a human ritual nobody performs. Hooks enforce, prose advises.
//
// The check that matters most is PARSE. A syntax error in hooks/ exits non-zero, and a
// non-zero PreToolUse hook BLOCKS every Write, Edit, and Bash. A hook's own try/catch
// cannot save it because node fails before executing. Push that to master and the sync
// engine bricks every machine within five minutes. Nothing else here is as dangerous.
//
// Exit 0 = safe to commit. Exit 1 = would leave the brain broken.
// Run: node tools/verify.mjs [--quiet]

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync , spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');
const failures = [];
const passes = [];

const ok = (m) => { passes.push(m); if (!QUIET) console.log('  ok    ' + m); };
const bad = (m) => { failures.push(m); console.error('  FAIL  ' + m); };

// A failing check must say what the CHILD said, not only what this file guessed. Every remote
// call here captures stdout and stderr, so without this the real message is collected and thrown
// away. Indented under the FAIL line, capped so a runaway child cannot bury the summary.
const detail = (e) => {
  const text = [e && e.stderr, e && e.stdout]
    .map((b) => (b == null ? '' : b.toString()))
    .join('\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (!text.length) { console.error('          (child produced no output; ' + ((e && e.message) || 'no message') + ')'); return; }
  text.slice(0, 12).forEach((l) => console.error('          ' + l));
  if (text.length > 12) console.error(`          ... ${text.length - 12} more line(s)`);
};

// 1. Every hook and tool must PARSE. This is the brick-prevention check.
for (const dir of ['hooks', 'tools']) {
  const d = join(BRAIN, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.mjs'))) {
    try {
      execFileSync(process.execPath, ['--check', join(d, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
      ok(`parse ${dir}/${f}`);
    } catch (e) {
      bad(`parse ${dir}/${f} -> ${String(e.stderr || e.message).split('\n')[0]}`);
    }
  }
}

// 2. Tier 0 and Tier 1 must exist. An agent that cannot load these has no rules and no
//    router, which fails silently rather than loudly.
for (const f of ['REFLEX.md', 'memory/MEMORY.md', 'CLAUDE.md', 'METHODOLOGIES.md']) {
  existsSync(join(BRAIN, f)) ? ok(`present ${f}`) : bad(`MISSING ${f}`);
}

// 3. Generated index must match memory/. Delegated so there is one definition of correct.
try {
  execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs'), '--check'],
    { cwd: BRAIN, stdio: ['ignore', 'pipe', 'pipe'] });
  ok('index in sync with memory/');
} catch (e) {
  // Print what the child ACTUALLY said. Reporting only "index drift" cost a day on the locked-down client
  // 2026-08-31: --check names the drifting files on stderr and this swallowed every word of it,
  // which is the same failure shape as a hook recording an inferred reason instead of curl's.
  bad('index drift, run: node tools/build-index.mjs');
  detail(e);
}

// 4. Reflection must be clean. Contradictions and dead links are how a memory system rots.
try {
  const out = execSync(`"${process.execPath}" "${join(BRAIN, 'tools', 'reflect.mjs')}"`,
    { cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m = out.match(/Total findings:\s*(\d+)/);
  const n = m ? Number(m[1]) : -1;
  if (n === 0) ok('reflection clean (0 findings)');
  else if (n > 0) {
    bad(`reflection has ${n} finding(s), run: node tools/reflect.mjs`);
    // Name the non-empty sections. Which nine matters; the number alone does not.
    out.split('\n')
      .filter((l) => /^##\s/.test(l) && !/\(0\)\s*$/.test(l))
      .forEach((l) => console.log('          ' + l.replace(/^##\s*/, '')));
  } else bad('reflection did not report a total');
} catch (e) {
  bad('reflect.mjs failed to run');
  detail(e);
}

// 4b. Every memory needs a usable description, because the description is the ENTIRE
// retrieval surface in MANIFEST.md. Since 2026-08-06 agents recall by scanning that manifest
// rather than by grepping, so a memory with a missing or throwaway description is invisible
// no matter how good its contents. This is the one check that protects recall itself.
const MIN_DESC = 40;
try {
  const memDir = join(BRAIN, 'memory');
  const weak = [];
  for (const f of readdirSync(memDir).filter((x) => x.endsWith('.md') && x !== 'MEMORY.md')) {
    const raw = readFileSync(join(memDir, f), 'utf8').replace(/\r\n/g, '\n');
    const end = raw.indexOf('\n---', 3);
    const fm = raw.startsWith('---') && end > 0 ? raw.slice(3, end) : '';
    const m = fm.match(/^description:\s*(.+)$/m);
    const desc = m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : '';
    if (!desc) weak.push(`${f} (no description)`);
    else if (desc.length < MIN_DESC) weak.push(`${f} (${desc.length} chars, too vague to recall)`);
  }
  if (weak.length) bad(`${weak.length} memory description(s) too weak to be recalled: ${weak.slice(0, 5).join(', ')}${weak.length > 5 ? ' ...' : ''}`);
  else ok(`all memory descriptions are usable for recall (min ${MIN_DESC} chars)`);
} catch (e) {
  bad('description audit failed: ' + e.message);
}

// 5. The plugin must actually REGISTER its hooks, and every registered hook must exist.
//
// Added 2026-07-28 after the brain was found not working on connected chats. Nothing was
// broken in any hook file: the SessionStart hook simply was not listed in hooks.json, so on
// every machine that installs the brain as a plugin it never ran. No error, no warning, and
// verify passed all 21 checks because it only ever asked "does this file parse", never "is
// it wired up". An unregistered hook is indistinguishable from a deleted one at runtime.
const REQUIRED_EVENTS = ['SessionStart', 'PreToolUse', 'Stop'];
try {
  const hj = JSON.parse(readFileSync(join(BRAIN, 'hooks', 'hooks.json'), 'utf8'));
  const events = hj.hooks || {};
  const missing = REQUIRED_EVENTS.filter((e) => !Array.isArray(events[e]) || !events[e].length);
  if (missing.length) bad(`hooks.json does not register: ${missing.join(', ')} (the plugin will silently not run them)`);
  else ok(`hooks.json registers ${REQUIRED_EVENTS.join(', ')}`);

  const dead = [];
  for (const groups of Object.values(events)) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        const m = String(h.command || '').match(/hooks\/([\w.-]+\.mjs)/);
        if (m && !existsSync(join(BRAIN, 'hooks', m[1]))) dead.push(m[1]);
      }
    }
  }
  if (dead.length) bad(`hooks.json points at missing file(s): ${[...new Set(dead)].join(', ')}`);
  else ok('every hook referenced by hooks.json exists');
} catch (e) {
  bad('hooks/hooks.json is missing or not valid JSON: ' + e.message);
}

// The always-on behaviour rules are generated from memory frontmatter into index/rules.json and
// injected by hooks/pre-turn.mjs on every turn. If that file goes missing or empties out, every
// agent silently loses every behaviour rule and nothing anywhere errors.
try {
  const rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
  const hasNewline = (t) => [10, 13].some((c) => t.includes(String.fromCharCode(c)));
  const malformed = rules.filter((r) =>
    !r.rule || r.rule.length < 20 || r.rule.includes('\\"') || hasNewline(r.rule)
    // A rule cut off by YAML line wrapping ends mid-sentence. Every real one ends in terminal
    // punctuation, so this catches the truncation cheaply at the data layer as well.
    || !/[.!?]$/.test(r.rule.trim()));
  // Pinned by slug. The count check cannot notice that ONE rule was deleted, and losing exactly
  // one is the likeliest real accident: someone edits a memory, drops the `rule:` line, verify
  // still sees four healthy rules and passes, and every agent quietly loses that behaviour.
  // WHICH rules must exist is instance config, read from brain.json.requiredRules. The engine
  // ships five generic seeds (tools/init.mjs) and a fresh brain holds only those; this brain pins
  // its own seven in brain.json. Hardcoding one person's list here made verify FAIL on every
  // clean install, found on 2026-09-05 by installing the export rather than reading the code.
  let REQUIRED_RULES = [
    'feedback_verify_before_claiming',
    'feedback_say_when_the_brain_is_down',
    'feedback_open_the_memory_not_the_description',
    'feedback_write_it_the_moment_you_learn_it',
    'feedback_reversible_act_irreversible_ask',
  ];
  try {
    const cfg = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8'));
    if (Array.isArray(cfg.requiredRules) && cfg.requiredRules.length) REQUIRED_RULES = cfg.requiredRules;
  } catch { /* no brain.json: the seed set is the requirement */ }
  const have = new Set(rules.map((r) => r.slug));
  const missing = REQUIRED_RULES.filter((r) => !have.has(r));
  const orders = rules.map((r) => r.order);
  const dupOrder = orders.length !== new Set(orders).size;

  if (!rules.length) bad('index/rules.json has no rules: every agent runs with no behaviour rules');
  else if (malformed.length) bad('index/rules.json malformed (newline or escaping): ' + malformed.map((m) => m.slug).join(', '));
  else if (missing.length) bad('required always-on rule(s) lost their `rule:` line: ' + missing.join(', '));
  else if (dupOrder) bad('duplicate rule_order, injection order is nondeterministic: ' + orders.join(','));
  else ok('index/rules.json carries ' + rules.length + ' always-on rules, all required ones present');
} catch (e) {
  bad('index/rules.json missing or unreadable, so the per-turn injection has no rules: ' + e.message);
}

function probePrompt() {
  try {
    const rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
    const idx = JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8'));
    const first = rules.slice().sort((x, y) => x.order - y.order)[0];
    const desc = first && idx && idx.descriptions && idx.descriptions[first.slug];
    if (desc) return String(desc).split(/s+/).slice(0, 9).join(' ');
  } catch { /* fall through */ }
  return 'how do i log creatine';
}

// END-TO-END: run pre-turn.mjs exactly as Claude Code does and assert the rules come out.
//
// Every other check here inspects a FILE. This one inspects the OUTPUT, which is the only
// thing that actually reaches an agent. A red-team pass on 2026-08-18 deleted pre-turn.mjs
// entirely and this gate still reported 28/28 healthy, because nothing verified the hook that
// delivers every behaviour rule. It also caught: a rule truncated by YAML line wrapping, a
// rules.json with zero entries, and a brain resolving to the wrong directory. All five were
// invisible to file-level checks and all five are visible here.
try {
  const hook = join(BRAIN, 'hooks', 'pre-turn.mjs');
  if (!existsSync(hook)) {
    bad('hooks/pre-turn.mjs is MISSING: every agent runs with no behaviour rules and no recall');
  } else {
    const r = spawnSync(process.execPath, [hook], {
      // The probe prompt is DERIVED from a memory this brain holds, so recall is guaranteed a
      // keyword hit on any brain. It was the literal 'how do i log creatine', which matches
      // nothing in a fresh install, so the end-to-end check failed on every clean export while
      // proving nothing about the hook. Found 2026-09-05 by installing rather than reading.
      input: JSON.stringify({ prompt: probePrompt() }),
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HAVOK_BRAIN: BRAIN },
    });
    let ctx = '';
    try { ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || ''; } catch { /* stays empty */ }
    // Content, not just presence. Pinning slugs alone let a red-team rewrite a rule to say the
    // opposite while keeping its slug, and the gate passed. Each phrase below is the part of
    // the rule that carries its meaning; if it is gone, the rule is gone whatever the slug says.
    // Each phrase is deliberately taken from the END of its rule, not the start.
    //
    // Pinning an opening phrase passed while the rule was silently cut in half: a YAML line
    // wrap truncated the reply-length rule at 80 characters, mid-word, and the surviving
    // fragment still contained the phrase being checked. What was lost was the entire
    // disclosure half, leaving a pure brevity instruction with no floor, which is exactly the
    // regression the rule exists to prevent. A tail phrase proves the whole rule arrived.
    // Derived from index/rules.json, not a hardcoded list of one person's phrases. The injection
    // prints every rule verbatim, so the TAIL of each rule must appear: a tail proves the whole
    // rule arrived, which is the regression this check exists to catch. BRAIN RECALL proves recall
    // ran. Generic, so a fresh brain with five seeds passes and this one with seven does too.
    const MUST_CONTAIN = { recall: 'BRAIN RECALL' };
    try {
      const rr = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
      for (const r of rr) {
        const t = String(r.rule || '').trim();
        if (t.length > 30) MUST_CONTAIN[r.slug] = t.slice(-30);
      }
    } catch { /* rules.json is checked on its own above */ }
    const absent = Object.entries(MUST_CONTAIN).filter(([, phrase]) => !ctx.includes(phrase)).map(([k]) => k);
    if (!ctx.trim()) bad('pre-turn.mjs produced NO output: agents get no rules and no recall, silently');
    else if (absent.length) bad('pre-turn.mjs output is missing rule content: ' + absent.join(', '));
    else ok('pre-turn.mjs end to end: all rule content and recall present in the injection');
  }
} catch (e) {
  bad('could not run hooks/pre-turn.mjs end to end: ' + e.message);
}
// The vault must never hold a plaintext value, and its passphrase must never be in the repo.
//
// vault.json is committed and pushed to three machines, so a bug that writes plaintext, or a
// passphrase file that slips past .gitignore, would publish every credential the owner owns. Cheap
// to check, catastrophic to miss.
try {
  const vaultPath = join(BRAIN, 'vault.json');
  if (existsSync(vaultPath)) {
    const vj = JSON.parse(readFileSync(vaultPath, 'utf8'));
    const entries = Object.entries(vj.secrets || {});
    // Two valid shapes. v2 wraps a random data key to each machine's age public key and has no
    // salt, because there is no passphrase to derive from. v1 derives from a shared passphrase
    // and must have one. An entry matching neither is corrupt.
    const broken = entries.filter(([, e]) => {
      if (!e.ct || !e.iv || !e.tag) return true;
      const v2 = e.keys && typeof e.keys === 'object' && Object.keys(e.keys).length > 0;
      const v1 = !!e.salt;
      return !v2 && !v1;
    });
    if (broken.length) bad('vault.json has entries missing crypto fields: ' + broken.map((b) => b[0]).join(', '));
    else {
      const v2n = entries.filter(([, e]) => e.keys).length;
      ok('vault.json: ' + entries.length + ' secrets, every one encrypted (' + v2n + ' per-machine, ' + (entries.length - v2n) + ' legacy passphrase)');
    }
    // A wrapped key must be age armour, never a raw private key pasted in by mistake.
    const leaked = entries.filter(([, e]) => JSON.stringify(e.keys || {}).includes('AGE-SECRET-KEY'));
    if (leaked.length) bad('PRIVATE AGE KEY INSIDE vault.json: ' + leaked.map((b) => b[0]).join(', '));
  }
} catch (e) {
  bad('vault.json is unreadable or not valid JSON: ' + e.message);
}

// server-endpoint.json is committed and holds only an ADDRESS. A token pasted in there would be
// published to every machine in plaintext, which is the exact failure the vault exists to avoid.
try {
  const sp = join(BRAIN, 'server-endpoint.json');
  if (existsSync(sp)) {
    const raw = readFileSync(sp, 'utf8');
    // Match credential-shaped VALUES, not the words. The first version of this check matched
    // /token/ and failed on the file's own comment explaining where the token is kept, which is
    // useful prose. A check that punishes documentation gets deleted, so it has to be precise:
    // a real leak here looks like an actual key, not like the word "token".
    const shapes = [
      /Bearer\s+[A-Za-z0-9_\-.]{16,}/,        // a pasted Authorization header
      /AGE-SECRET-KEY-[A-Z0-9]+/,             // an age private key
      /\bsk_(live|test)_[A-Za-z0-9]{16,}/,    // Stripe or Clerk style
      /\beyJ[A-Za-z0-9_-]{20,}\./,            // a JWT
      /"[A-Za-z0-9_\-]{40,}"/,                // any long opaque string sitting in a value
    ];
    const hit = shapes.find((re) => re.test(raw));
    if (hit) bad('server-endpoint.json contains something credential-shaped (' + hit + '). It is committed: it must hold an address and nothing else.');
    else ok('server-endpoint.json: address only, no credential');
  }
} catch (e) { bad('server-endpoint.json is unreadable or not valid JSON: ' + e.message); }

// The recipients file is committed on purpose, so it must hold public keys and nothing else.
// One pasted private key here would hand every secret to anyone who clones the repo.
try {
  const rp = join(BRAIN, 'vault-recipients.json');
  if (existsSync(rp)) {
    const raw = readFileSync(rp, 'utf8');
    if (raw.includes('AGE-SECRET-KEY')) bad('PRIVATE AGE KEY IN vault-recipients.json. Remove it and rotate every credential.');
    const machines = Object.entries(JSON.parse(raw).machines || {});
    const wrong = machines.filter(([, m]) => !/^age1[0-9a-z]{50,}$/.test(m.pubkey || ''));
    if (wrong.length) bad('vault-recipients.json has entries that are not age public keys: ' + wrong.map((m) => m[0]).join(', '));
    else ok('vault-recipients.json: ' + machines.length + ' machine(s), all public keys');
  }
} catch (e) {
  bad('vault-recipients.json is unreadable or not valid JSON: ' + e.message);
}

// A passphrase file inside the repo would sit next to the ciphertext it unlocks.
for (const f of ['havok-vault-key', '.vault-key', 'vault.key', 'havok-age-key.txt', 'key.txt']) {
  if (existsSync(join(BRAIN, f))) {
    bad('PRIVATE KEY FILE IN THE REPO: ' + f + '. Delete it and rotate every credential it could unlock.');
  }
}
ok('no vault private key file inside the repo');
if (!QUIET || failures.length) {
  console.log(`\n${failures.length ? 'BRAIN VERIFY FAILED' : 'BRAIN VERIFY PASSED'}: ${passes.length} passed, ${failures.length} failed`);
}
process.exit(failures.length ? 1 : 0);
