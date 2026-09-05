// SessionStart hook: pull the brain so the session starts current, report the
// REAL pull result (no false "synced" on failure), and report brain health.
// Injects a short note as additionalContext. Fails open and never blocks a session.
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';

// ONE brain per machine, resolved, never assumed.
//
// This script can run from two places: the plugin clone under ~/.claude/plugins/, or a dev
// checkout like <brain>. Resolving the brain as "wherever I happen to live"
// meant this machine had TWO brains, and on 2026-07-28 the plugin copy was found 204 commits
// behind, frozen on 2026-05-30, because only `claude plugin marketplace update` ever touched
// it and nothing ran that. Hooks were firing May code against May memory.
//
// So: a dev checkout records its own path, and any plugin copy on the same machine defers to
// it. A machine with no checkout (the work laptop) simply uses the plugin clone. Self-healing,
// no per-machine setup. HAVOK_BRAIN overrides everything for the odd case.
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = resolve(homedir(), '.claude', 'havok-brain-path');
const isPluginCopy = (p) => /[\\/]plugins[\\/]/.test(p);
const isBrainRepo = (p) => {
  try { return !!p && existsSync(resolve(p, '.git')) && existsSync(resolve(p, 'memory')); }
  catch { return false; }
};

let marked = null;
try { marked = readFileSync(MARKER, 'utf8').trim(); } catch { /* no checkout on this machine */ }

// First valid checkout wins, and keeps winning. Overwriting on every run would let any
// throwaway clone (a sandbox, a second worktree, a test copy) silently become the machine's
// brain of record, and two checkouts would flap the marker back and forth every session.
// A marker pointing at a moved or deleted directory fails isBrainRepo and is reclaimed here,
// so this still self-heals without ever fighting over a live one.
if (!isPluginCopy(HERE) && isBrainRepo(HERE) && !isBrainRepo(marked)) {
  try { writeFileSync(MARKER, HERE, 'utf8'); marked = HERE; } catch { /* marker is an optimisation, not a requirement */ }
}

const BRAIN = [process.env.HAVOK_BRAIN, marked, HERE].find(isBrainRepo) || HERE;

function runIn(cwd, cmd, ms) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { ok: true, out };
  } catch { return { ok: false, out: '' }; }
}
const tryRun = (cmd, ms) => runIn(BRAIN, cmd, ms);

const notes = [];

// Keep the plugin copy's own CODE current even when it is not the brain of record. The
// enforcement hooks (content, secrets, brain-commit, stop) load from the plugin, so a stale
// clone silently runs old rules forever. A plain pull does what `marketplace update` did,
// every session, with nobody having to remember it.
if (BRAIN !== HERE && isBrainRepo(HERE)) {
  runIn(HERE, 'git checkout -- memory/MEMORY.md index/ MANIFEST.md', 8000);
  const pluginPull = runIn(HERE, 'git pull --no-rebase --quiet', 15000);
  if (!pluginPull.ok) notes.push('NOTE: could not update the plugin copy of the brain at ' + HERE.replace(/\\/g, '/') + '. Its enforcement hooks may be stale. Run: claude plugin marketplace update');
}

// Install the per-turn hook into USER SETTINGS rather than registering it in the plugin's own
// hooks.json, and the distinction is not cosmetic.
//
// Plugin hooks only take effect when the plugin is re-enabled or the session restarts. Hooks in
// a settings file are picked up by a file watcher and go live in sessions that are ALREADY
// RUNNING. the owner keeps around twenty sessions open at once, so plugin-only registration meant
// every brain change to the per-turn hook cost him twenty restarts.
//
// The cost of moving it is that a plugin pull no longer carries the registration, so this
// installs it. Registering in BOTH places would fire the hook twice per turn and double the
// injected tokens: there is a settings.json backup on this machine literally named
// "hookdedupe", so that has already happened once here.
//
// Strictly idempotent, touches nothing but this one key, and silent on any failure. It rewrites
// only when the command actually differs, so a moved brain self-heals without churning the file.
try {
  const settingsPath = resolve(homedir(), '.claude', 'settings.json');
  const desired = `node "${join(BRAIN, 'hooks', 'pre-turn.mjs').replace(/\\/g, '/')}"`;
  const raw = readFileSync(settingsPath, 'utf8');
  const s = JSON.parse(raw);
  const current = s.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
  if (current !== desired) {
    if (!existsSync(settingsPath + '.bak-preturn')) writeFileSync(settingsPath + '.bak-preturn', raw, 'utf8');
    s.hooks = s.hooks || {};
    s.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: desired, timeout: 10 }] }];
    writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
    notes.push('Installed the per-turn recall and reply-discipline hook into ~/.claude/settings.json. Settings hooks reload live, so it applies to sessions already running, not just new ones.');
  }
} catch { /* the brain still works without it, it just loses the per-turn nudge */ }

// Warn about any OTHER brain copy on this machine that is badly out of date.
//
// Two clones were known about and are handled. A red-team pass on 2026-08-18 found a THIRD:
// ~/.claude/plugins/cache/<plugin>/<plugin>/<version>, recorded as the installPath in
// installed_plugins.json, holding 32 memories against the live 121 and frozen since 2026-05-30.
// It is not a git repository, so the sync engine cannot reach it, and it carries no hooks.json,
// which is why it is currently inert rather than actively serving stale rules.
//
// Inert today is not inert forever: it is the recorded install path, so a change in how Claude
// Code resolves plugins would make it live, and it would then supply no hooks at all. Cheap to
// notice, expensive to debug cold, so say it out loud at session start rather than discovering
// it in another red-team pass.
try {
  const cacheRoot = resolve(homedir(), '.claude', 'plugins', 'cache', 'havok-brain');
  if (existsSync(cacheRoot)) {
    const liveCount = readdirSync(join(BRAIN, "memory")).filter((f) => f.endsWith(".md")).length;
    const stack = [cacheRoot];
    while (stack.length) {
      const dir = stack.pop();
      let kids = [];
      try { kids = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const hasMem = kids.some((k) => k.isDirectory() && k.name === "memory");
      if (hasMem) {
        const n = readdirSync(join(dir, "memory")).filter((f) => f.endsWith(".md")).length;
        if (n < liveCount - 10) {
          notes.push("STALE BRAIN COPY on this machine: " + dir.split(String.fromCharCode(92)).join("/") + " has " + n
            + " memories against the live " + liveCount + ". It is not a git checkout, so nothing syncs it."
            + " Harmless while it carries no hooks.json, but it is the recorded plugin installPath.");
        }
        continue;
      }
      for (const k of kids) if (k.isDirectory()) stack.push(join(dir, k.name));
    }
  }
} catch { /* a warning that fails is not worth breaking session start over */ }
// Start the embedding daemon if it is not already running.
//
// Semantic recall is what took the eval from 87.5% to 100% on the corpus of the day, and it
// depends on a resident
// process that nothing was starting. A reboot silently dropped every session to keyword-only.
// The hook does say so in its injection, but a degradation nobody reads is a degradation
// nobody fixes.
//
// Detached and unref'd so it outlives this session: one daemon serves every conversation on
// the machine, and it costs about 200MB resident. The liveness marker is the same file the
// per-turn hook stats, so a stale marker from a hard kill self-heals here.
try {
  const alive = resolve(homedir(), '.claude', 'havok-embed.alive');
  const server = join(BRAIN, 'tools', 'embed-server.mjs');
  let running = false;
  if (existsSync(alive)) {
    // Trust but verify: the marker can outlive a hard-killed process.
    const probe = runIn(BRAIN, 'curl -s --connect-timeout 1 --max-time 2 http://127.0.0.1:8477/health', 4000);
    running = probe.ok && probe.out.includes('"ok"');
    if (!running) { try { unlinkSync(alive); } catch {} }
  }
  if (!running && existsSync(server)) {
    if (!existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
      notes.push('Semantic recall is unavailable on this machine: run npm install in ' + BRAIN.split(String.fromCharCode(92)).join('/') + ' to enable it. Recall falls back to keyword only until then.');
    } else {
      const child = spawn(process.execPath, [server], { detached: true, stdio: 'ignore', cwd: BRAIN });
      child.unref();
      notes.push('Started the embedding daemon for semantic recall. It takes a few seconds to load; the first turn or two may be keyword only.');
    }
  }
} catch { /* recall degrades to keyword only, which the per-turn hook reports itself */ }
// Start the brain server if this machine is the one that hosts it.
//
// Only the machine holding the vault passphrase can serve it, so that file is the marker for
// "this is the server". Any other machine skips this and simply talks to it over the network,
// or falls back to its own git clone.
//
// Same reasoning as the embed daemon: a reboot otherwise takes the live sharing down silently
// and every other machine quietly loses secret access with nothing saying why.
try {
  // Which machine is the host is now stated explicitly in vault-recipients.json rather than
  // inferred from "has the v1 passphrase file", which stopped meaning anything when the shared
  // passphrase was removed on 2026-08-21. Every machine has a key now, so presence of a key
  // proves nothing about who should serve.
  let isHost = false;
  try {
    const r = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
    const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
    isHost = (r.host || '').toUpperCase() === me;
  } catch { /* no registry yet, so nobody is the host */ }
  const server = join(BRAIN, 'tools', 'brain-server.mjs');
  if (isHost && existsSync(server)) {
    // TLS on 8443, not plain HTTP on 8478.
    //
    // 8478 was removed on 2026-08-22 when the transport was encrypted. Probing it meant this check
    // concluded the server was DOWN on every session start of a perfectly healthy machine and
    // spawned a duplicate each time. The duplicate exits cleanly on EADDRINUSE so nothing broke
    // loudly, which is exactly why it could have run for weeks unnoticed.
    //
    // --cacert, never --insecure: the certificate is self-signed and pinned, and accepting any
    // certificate here would defeat the point of encrypting the transport at all.
    const certArg = '--cacert "' + join(BRAIN, 'server-cert.pem').split(String.fromCharCode(92)).join('/') + '"';
    const probe = runIn(BRAIN, 'curl -s --connect-timeout 1 --max-time 2 ' + certArg + ' https://127.0.0.1:8443/health', 4000);
    const up = probe.ok && probe.out.includes('"ok"');
    if (!up) {
      const child = spawn(process.execPath, [server], { detached: true, stdio: 'ignore', cwd: BRAIN });
      child.unref();
      notes.push('Started the brain server on port 8443 (TLS). It serves recall, the vault and embeddings to every machine on the tailnet; they reach it with tools/brain-client.mjs.');
    }
  }
} catch { /* the local clone still works, which is the whole point of keeping git */ }
// NEW MACHINE CHECK: name what git could not carry.
//
// git brings the memories, the rules, the hooks and the encrypted vault. It cannot bring the
// vault passphrase (deliberately, it is the one thing that must never be in the repo) or
// node_modules (283MB, gitignored). Both failures are silent: the vault just refuses to
// decrypt, and recall quietly drops to keyword-only. On a fresh machine that reads as "the
// brain is broken" rather than "two files are missing", so say exactly which.
try {
  const agekey = resolve(homedir(), '.claude', 'havok-age-key.txt');
  const vaultPath = join(BRAIN, 'vault.json');
  const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
  let vault = { secrets: {} };
  try { vault = JSON.parse(readFileSync(vaultPath, 'utf8')); } catch { /* no vault yet */ }
  const total = Object.keys(vault.secrets || {}).length;
  const readable = Object.values(vault.secrets || {}).filter((b) => b.keys && b.keys[me]).length;

  if (total > 0 && readable === 0) {
    // Self-onboard. The owner, 2026-08-21: "I don't want to do anything, all is gonna be done by the
    // agents." Generating a key and publishing the PUBLIC half grants nothing and leaks nothing,
    // so it is safe to do automatically. Approval stays a separate, deliberate step on the host,
    // because auto-approving whatever appears in the repo would hand the vault to any machine
    // that cloned it.
    // Detect here, act in the agent. The install step can take minutes and this hook has a 30
    // second budget, so a hook that tried to do it itself would time out half way and leave a key
    // with no published request. Naming the single command is enough: the note lands in the
    // agent's context at session start and the agent runs it.
    notes.push('ACTION REQUIRED, do this before anything else. This machine (' + me + ') is not connected '
      + 'to the vault: ' + total + ' secret(s) are present and 0 are readable. Run this ONE command now, '
      + 'it needs no input and no admin:' + String.fromCharCode(10)
      + '    node tools/connect-machine.mjs' + String.fromCharCode(10)
      + 'It installs age if missing, generates this machine key (the private half never leaves), publishes '
      + 'ONLY the public half as a request, and pushes it. Then an agent on the host approves. Until then '
      + 'memories and rules work normally and secrets do not. Do NOT ask the owner for any credential in the '
      + 'meantime, and do NOT ask him to run anything: this is fully automatic.');
  } else if (total > 0 && readable < total) {
    notes.push('VAULT: ' + readable + ' of ' + total + ' secrets readable on ' + me
      + '. The rest were deliberately not granted to this machine.');
  }

  // On the host, surface anything waiting so it does not sit in the repo unnoticed.
  try {
    const reqDir = join(BRAIN, 'vault-requests');
    const reg = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
    if ((reg.host || '').toUpperCase() === me && existsSync(reqDir)) {
      const pending = readdirSync(reqDir).filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, '')).filter((n) => !reg.machines[n]);
      if (pending.length) {
        notes.push('VAULT REQUESTS PENDING from: ' + pending.join(', ')
          + '. Approve with: node tools/vault.mjs approve <NAME>, then commit and push. '
          + 'Check the name against the owner\'s known machines first; a company-issued machine must never be approved.');
      }
    }
  } catch { /* no registry or no requests, nothing to say */ }
  if (!existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
    notes.push('Semantic recall is OFF on this machine: run npm install in ' + BRAIN.split(String.fromCharCode(92)).join('/')
      + '. Recall works on keywords alone until then, which misses anything phrased differently from the memory.');
  }
} catch { /* a diagnostic that fails is not worth breaking session start over */ }
// Clear GENERATED files before pulling. memory/MEMORY.md and index/ are produced by
// tools/build-index.mjs from the memory files, so a local edit to them carries no
// information: discarding it loses nothing and regenerating restores it exactly. Left
// dirty they abort the pull with "local changes would be overwritten", which is how a
// machine ends up stranded several commits behind, unable to fetch the very tooling that
// would fix it. Scoped strictly to generated paths, never to memory/*.md, which is real data.
const genDirty = tryRun('git status --porcelain -- memory/MEMORY.md index/ MANIFEST.md', 5000);
if (genDirty.ok && genDirty.out.trim()) {
  const restored = tryRun('git checkout -- memory/MEMORY.md index/ MANIFEST.md', 8000);
  if (restored.ok) notes.push('Discarded local edits to generated files (memory/MEMORY.md, index/, MANIFEST.md) so the pull could proceed. They are rebuilt from memory/, nothing was lost.');
}

// Honest pull: report success or failure, do not claim synced if it failed.
// Capture HEAD first so we can tell what the pull actually brought in.
const beforeRev = tryRun('git rev-parse HEAD', 5000);
const pull = tryRun('git pull --no-rebase --quiet', 15000);

// A git pull updates memory, tools and docs, but NOT the enforcement hooks: those load
// from the installed Claude Code plugin, not from the working tree. So a machine can be
// fully current on knowledge while still running an old hook set, and would sail past the
// verification gate with no warning. If this pull touched hooks/ or the plugin manifest,
// surface the exact command instead of relying on anyone remembering to check.
if (pull.ok && beforeRev.ok) {
  const afterRev = tryRun('git rev-parse HEAD', 5000);
  if (afterRev.ok && afterRev.out && afterRev.out !== beforeRev.out) {
    const changed = tryRun('git diff --name-only ' + beforeRev.out + ' ' + afterRev.out + ' -- hooks/ .claude-plugin/', 8000);
    if (changed.ok && changed.out.trim()) {
      notes.push('Brain HOOKS changed in this pull, so the plugin copy on this machine is stale:');
      notes.push('  claude plugin marketplace update');
      notes.push('  then restart Claude Code (or run /hooks once) - hooks only load at session start.');
      notes.push('Details: memory/reference_brain_machine_update.md');
    }
  }
}

// Flush anything committed while this machine had no access. The post-commit hook already
// tries to push on every commit, but if that push failed (offline, blocked network), nothing
// retries it until either another commit happens or a session starts with access restored.
// This is that second trigger: only runs when the pull above actually succeeded (no point
// racing a push against the same dead network), and only if there is something to send.
let pushLine = '';
if (pull.ok) {
  const upstream = tryRun('git rev-parse --abbrev-ref --symbolic-full-name @{u}', 5000);
  if (upstream.ok && upstream.out) {
    const ahead = tryRun('git rev-list --count ' + upstream.out + '..HEAD', 5000);
    const aheadCount = ahead.ok ? parseInt(ahead.out, 10) || 0 : 0;
    if (aheadCount > 0) {
      const push = tryRun('git push --quiet', 20000);
      pushLine = push.ok
        ? 'Flushed ' + aheadCount + ' commit(s) that were stuck local, now pushed.'
        : 'WARNING: ' + aheadCount + ' commit(s) are still stuck local, push failed again this session.';
    }
  }
}

const syncLine = pull.ok
  ? 'Brain synced (git pull ok).' + (pushLine ? ' ' + pushLine : '')
  : 'WARNING: brain pull FAILED (network or conflict). You may be running on STALE data. Run a manual sync or check connectivity before trusting memory.';

// Self-install the native git gate. core.hooksPath is per-clone config and therefore NOT
// carried by git, so a machine that pulls the brain would get hooks/git/pre-commit as an
// inert file and commit straight past the gate. Setting it here means every machine arms
// itself on its next session with no manual step. Idempotent and silent when already set.
const hp = tryRun('git config --get core.hooksPath', 5000);
if (!hp.ok || hp.out !== 'hooks/git') {
  const set = tryRun('git config core.hooksPath hooks/git', 5000);
  if (set.ok) notes.push('Armed the brain git pre-commit gate on this machine (core.hooksPath).');
}

// Brain health. This replaced the open-PR queue on 2026-07-26, when the PR requirement was
// dropped in favour of verification: the whole brain is directly editable and `verify.mjs`
// is the gate. A stale PR count told an agent nothing actionable; a red brain does.
// Costs about 1.3s. Fails open, a broken or missing verifier must never block a session.
const vr = tryRun('node "' + BRAIN.replace(/\\/g, '/') + '/tools/verify.mjs" --quiet', 25000);
const prLine = vr.ok
  ? 'Brain verify PASSED.'
  : 'WARNING: brain verify FAILED. The shared brain is broken for every machine. Run: node tools/verify.mjs';
if (!vr.ok) {
  notes.push('Brain verification is failing. Fix before making other changes:');
  notes.push('  node tools/verify.mjs');
  notes.push('A red gate usually means a hook or tool does not parse, the generated index');
  notes.push('drifted from memory/, or reflect.mjs found contradictions.');
}

// Open reminders. REMINDERS.md says "any Havok agent surfaces the open ones proactively,
// at session start", but nothing referenced the file, so nothing ever did. It was sitting
// there with an ICO registration already overdue since 2026-07-01. A reminder nobody reads
// is worse than no reminder: it creates the belief that something is being tracked.
try {
  const rem = readFileSync(resolve(BRAIN, 'REMINDERS.md'), 'utf8').replace(/\r\n/g, '\n');
  const today = new Date().toISOString().slice(0, 10);
  const open = rem.split('\n')
    .filter((l) => /^\s*-\s*\[ \]/.test(l))
    .map((l) => l.replace(/^\s*-\s*\[ \]\s*/, '').trim());
  if (open.length) {
    notes.push('OPEN REMINDERS (' + open.length + ') from REMINDERS.md:');
    for (const item of open.slice(0, 10)) {
      // Flag anything whose stated due date has already passed.
      const due = (item.match(/due (\d{4}-\d{2}-\d{2})/) || [])[1];
      notes.push('  ' + (due && due < today ? '[OVERDUE] ' : '') + item);
    }
    notes.push('Surface these when the person or project comes up. Tick them off in REMINDERS.md when done.');
  }
} catch { /* no reminders file, or unreadable: never block a session over it */ }

// INJECT the brain itself, do not just point at it.
//
// This is the whole reason the brain exists and it was missing until 2026-07-28. The hook
// reported "brain synced" and nothing else, so whether a conversation actually used the
// brain depended on it choosing to go read two files because some prose told it to. Most
// did not. Hooks enforce, prose advises, and this was prose.
//
// Tier 0 and Tier 1 are deliberately tiny (about 1,200 tokens combined) precisely so they
// can be pasted into every session on every machine. That makes the brain the actual
// working memory of every conversation rather than a repo sitting next to one.
// Tier 2 and 3 stay on demand, which is what keeps this affordable.
// Per-tier size caps. The manifest gets a far larger one on purpose: it grows linearly with
// the number of memories, and silently truncating it would drop real memories out of the
// agent's awareness with no signal. That is precisely the blind spot this whole tier exists
// to remove, so it is better to spend the tokens than to hide entries.
function readTier(rel, cap) {
  try {
    const body = readFileSync(resolve(BRAIN, rel), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!body) return null;
    if (body.length > cap) {
      return body.slice(0, cap) + `\n\n[TRUNCATED at ${cap} chars. ${rel} has outgrown its injection budget, so entries below this line are INVISIBLE to this session. Fix the brain, do not assume this list is complete.]`;
    }
    return body;
  } catch { return null; }
}

const reflex = readTier('REFLEX.md', 16000);
const router = readTier('memory/MEMORY.md', 16000);
const manifest = readTier('MANIFEST.md', 80000);

const parts = [
  'HAVOK BRAIN: ' + syncLine + ' ' + prLine + ' Enforcement hooks (no em dash, no emoji, secret scan) are active via the havok-brain plugin.',
];
if (notes.length) parts.push(notes.join('\n'));

if (reflex || router || manifest) {
  parts.push(
    '',
    'The brain below IS your memory. It is injected in full, so do not re-read these files.',
    '',
    'RECALL IS NOT OPTIONAL AND IT IS NOT A SEARCH. The manifest lists everything the brain',
    'knows. Before you answer or act, scan it against the task in front of you. If a line is',
    'relevant, open `' + BRAIN.replace(/\\/g, '/') + '/memory/<slug>.md` and read it FIRST.',
    'A description tells you whether to open a file, never what the file says, so never answer',
    'from the manifest line alone.',
    '',
    'The most common failure is skipping this because you believe you already know the answer.',
    'You cannot know what the brain corrected, superseded, or decided since you last looked.',
    'When you learn something durable, write it back as a memory file under memory/.',
  );
  // A half-loaded brain is more dangerous than an unloaded one: the session looks equipped
  // and quietly is not. Name the missing tier rather than just leaving a gap in the payload.
  if (!reflex) parts.push('', 'WARNING: REFLEX.md is missing or unreadable, so the always-on hard rules are NOT loaded. Treat nothing below as complete and fix the brain at ' + BRAIN.replace(/\\/g, '/'));
  if (!router) parts.push('', 'WARNING: memory/MEMORY.md is missing or unreadable, so you have no router. Find memories with grep until it is rebuilt: node tools/build-index.mjs');
  if (!manifest) parts.push('', 'WARNING: MANIFEST.md is missing, so you CANNOT see what the brain knows and will silently fail to recall. Rebuild it: node tools/build-index.mjs');
  if (reflex) parts.push('', '===== BRAIN TIER 0: REFLEX (always applies) =====', reflex);
  if (router) parts.push('', '===== BRAIN TIER 1: MEMORY ROUTER =====', router);
  if (manifest) parts.push('', '===== BRAIN TIER 1.5: MANIFEST, everything the brain knows =====', manifest);
} else {
  parts.push('WARNING: could not read REFLEX.md or memory/MEMORY.md. The brain is NOT loaded into this session. Read them manually from ' + BRAIN.replace(/\\/g, '/'));
}

const out = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: parts.join('\n'),
  }
};
process.stdout.write(JSON.stringify(out));
process.exit(0);
