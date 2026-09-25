// SessionStart hook: pull the brain so the session starts current, report the
// REAL pull result (no false "synced" on failure), and report brain health.
// Injects a short note as additionalContext. Fails open and never blocks a session.
import { execFileSync, execSync, spawn } from 'node:child_process';
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

// A MACHINE WITH NO MEMORIES ON DISK IS THE NORMAL CASE NOW, NOT A BROKEN ONE.
//
// The owner, 2026-09-21 (feedback_no_local_brain_copy_server_only): "local recall, and local brain copy
// is not an option, if claude is on that means it has an internet connection so it can access the
// brain". One brain, on the server. So memory/ is empty there by design, and every git-shaped and
// verify-shaped check below was reporting that design as a fault: four warnings at every session
// start of a healthy machine, which teaches its agents to skip the banner, and then the one banner
// that matters is skipped too (measured on PC-MA1-641, 2026-09-22).
//
// Counted from the DISK rather than read from a marker or a DISABLED- remote, because the rule
// applies to any machine holding no memories however it got that way, and because the remote lies:
// on PC-MA1-641 origin pointed at a migration bundle, so the git block below would have cheerfully
// restored memory/MEMORY.md, index/ and MANIFEST.md, putting the brain back on a company laptop at
// every session start.
const memDir = join(BRAIN, 'memory');
let localMemories = 0;
try { localMemories = readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length; }
catch { localMemories = 0; }
const noLocalBrain = localMemories === 0;

const LF = String.fromCharCode(10);
function runIn(cwd, cmd, ms) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, out, err: '', stderr: '' };
  } catch (e) {
    // The first stderr line is what tells a wedged pull apart from a dead network in the banner.
    const stderr = String((e && e.stderr) || '').trim();
    const err = stderr.split(LF).map((l) => l.trim()).filter(Boolean)[0] || '';
    return { ok: false, out: '', err, stderr };
  }
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
  // The authoritative answer to which copy Claude Code loads is installed_plugins.json, not the
  // oldest directory on disk. Reading the tree and naming whatever it finds first 'the recorded
  // installPath' was wrong the moment a second version existed: it called the frozen 0.1.0 the
  // loaded copy while the record pointed at 0.2.1 (a laptop client, 2026-09-07). Read the record.
  let loadedPath = '';
  let loadedVer = '';
  try {
    const reg = JSON.parse(readFileSync(resolve(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const rec = ((reg.plugins || reg)['havok-brain@havok-brain'] || [])[0];
    if (rec && rec.installPath) { loadedPath = resolve(rec.installPath); loadedVer = rec.version || ''; }
  } catch { /* no record readable, name copies without claiming which loads */ }
  if (existsSync(cacheRoot)) {
    const liveCount = readdirSync(join(BRAIN, 'memory')).filter((f) => f.endsWith('.md')).length;
    const copies = [];
    const stack = [cacheRoot];
    while (stack.length) {
      const dir = stack.pop();
      let kids = [];
      try { kids = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (kids.some((k) => k.isDirectory() && k.name === 'memory')) {
        const n = readdirSync(join(dir, 'memory')).filter((f) => f.endsWith('.md')).length;
        copies.push({ dir: resolve(dir), n, hooks: existsSync(join(dir, 'hooks', 'hooks.json')) });
        continue;
      }
      for (const k of kids) if (k.isDirectory()) stack.push(join(dir, k.name));
    }
    const norm = (p) => p.split(String.fromCharCode(92)).join('/');
    const loaded = copies.find((c) => c.dir === loadedPath);
    if (loaded && (loaded.n < liveCount - 10 || !loaded.hooks)) {
      notes.push('STALE PLUGIN COPY LOADS HERE: the recorded install path ' + norm(loaded.dir) + ' (version '
        + (loadedVer || '?') + ') has ' + loaded.n + ' memories against the live ' + liveCount
        + (loaded.hooks ? '' : ' and no hooks.json') + '. Hook code runs from here. Fix: claude plugin marketplace update havok-brain, then claude plugin update havok-brain@havok-brain -y, then restart.');
    }
    const leftover = copies.filter((c) => c.dir !== loadedPath && (c.n < liveCount - 10 || !c.hooks));
    if (leftover.length && loaded) {
      notes.push('Old plugin copies left on disk, not loaded (' + leftover.map((c) => norm(c.dir).split('/').pop()).join(', ')
        + '); the loaded one is ' + (loadedVer || '?') + '. Harmless, removable when convenient.');
    } else if (leftover.length && !loadedPath) {
      notes.push('Plugin copies found but installed_plugins.json was unreadable, so which one loads is unconfirmed: '
        + leftover.map((c) => norm(c.dir) + ' (' + c.n + ' memories' + (c.hooks ? '' : ', no hooks') + ')').join('; ') + '.');
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
    if (!noLocalBrain && !existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
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
// Ask the server what this machine may read, with this machine's own token. Secrets are decrypted
// on the host and served over TLS; the recipient list inside vault.json says nothing about a client
// (a laptop client, 2026-09-06: the old count said 0 readable while brain-client fetched a secret three
// times in a row, and every a laptop client session was told to run an onboarding that no longer applies).
// The token goes in a curl config on stdin, never in argv. /vault/list carries names, never values.
// One GET against the brain server, for the machines that hold nothing locally. Same shape as
// vaultProbe: the token goes in a curl config on stdin, never argv, and the pinned certificate
// rather than --insecure. It carries the MagicDNS name for SNI while the socket goes to the tailnet
// IP, because the 2023 curl in System32 refuses a certificate matched on an IP SAN and fails with
// exit 60 (reference_curl_schannel_ip_cert_mismatch). Returns '' on any failure: the caller decides
// what a silent server means, and session start is never broken over it.
function serverGet(brain, path) {
  let url = (process.env.HAVOK_SERVER_URL || '').replace(/[/]$/, '');
  let magic = '';
  try {
    const ep = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8'));
    if (!url) url = String(ep.url || '').replace(/[/]$/, '');
    magic = ((ep.tailnet || {}).magicdns) || '';
  } catch { /* no endpoint file, fall through to the local default */ }
  if (!url) url = 'https://127.0.0.1:8443';
  let token = (process.env.HAVOK_SERVER_TOKEN || '').trim();
  if (!token) { try { token = readFileSync(resolve(homedir(), '.claude', 'havok-server-token'), 'utf8').trim(); } catch { token = ''; } }
  if (!token) return '';
  const host = (url.match(/^https?:\/\/([^:/]+)(?::(\d+))?/) || []);
  const byName = Boolean(magic && host[1] && /^[0-9.]+$/.test(host[1]));
  const cert = join(brain, 'server-cert.pem');
  const conf = ['header = "Authorization: Bearer ' + token + '"',
    'url = "' + (byName ? 'https://' + magic + (host[2] ? ':' + host[2] : '') : url) + path + '"']
    .concat(byName ? ['connect-to = "' + magic + ':' + host[2] + ':' + host[1] + ':' + host[2] + '"'] : [])
    .concat(existsSync(cert) ? ['cacert = "' + cert.split(String.fromCharCode(92)).join('/') + '"'] : [])
    .concat(['silent', 'fail', 'connect-timeout = 3', 'max-time = 15']);
  try {
    return execFileSync('curl', ['-K', '-'], {
      input: conf.join(LF) + LF, encoding: 'utf8', timeout: 18000, windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch { return ''; }
}

function vaultProbe(brain) {
  let url = (process.env.HAVOK_SERVER_URL || '').replace(/[/]$/, '');
  if (!url) { try { url = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8')).url || ''; } catch { url = ''; } }
  if (!url) url = 'https://127.0.0.1:8443';
  let token = (process.env.HAVOK_SERVER_TOKEN || '').trim();
  if (!token) { try { token = readFileSync(resolve(homedir(), '.claude', 'havok-server-token'), 'utf8').trim(); } catch { token = ''; } }
  if (!token) return { code: 'no-token', count: 0 };
  const cert = join(brain, 'server-cert.pem');
  const conf = 'header = "Authorization: Bearer ' + token + '"' + LF
    + (existsSync(cert) ? 'cacert = "' + cert.split(String.fromCharCode(92)).join('/') + '"' + LF : '')
    + 'url = "' + url + '/vault/list"' + LF + 'silent' + LF + 'connect-timeout = 2' + LF + 'max-time = 5' + LF
    + 'write-out = "__CODE__%{http_code}"' + LF;
  let out = '';
  try { out = execFileSync('curl', ['-K', '-'], { input: conf, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (e) { out = String((e && e.stdout) || ''); }
  const i = out.lastIndexOf('__CODE__');
  if (i === -1) return { code: '000', count: 0 };
  const code = out.slice(i + 8).trim() || '000';
  let count = 0;
  if (code === '200') { try { count = (JSON.parse(out.slice(0, i)).secrets || []).length; } catch { count = -1; } }
  return { code, count };
}
// NEW MACHINE CHECK: name what git could not carry.
//
// git brings the memories, the rules, the hooks and the encrypted vault. It cannot bring the
// vault passphrase (deliberately, it is the one thing that must never be in the repo) or
// node_modules (283MB, gitignored). Both failures are silent: the vault just refuses to
// decrypt, and recall quietly drops to keyword-only. On a fresh machine that reads as "the
// brain is broken" rather than "two files are missing", so say exactly which.
let serverAnswered = null;
try {
  const agekey = resolve(homedir(), '.claude', 'havok-age-key.txt');
  const vaultPath = join(BRAIN, 'vault.json');
  const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
  let vault = { secrets: {} };
  try { vault = JSON.parse(readFileSync(vaultPath, 'utf8')); } catch { /* no vault yet */ }
  const total = Object.keys(vault.secrets || {}).length;
  const readable = Object.values(vault.secrets || {}).filter((b) => b.keys && b.keys[me]).length;
  let vaultHost = '';
  try { vaultHost = String(JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase(); } catch { vaultHost = ''; }
  const isHost = vaultHost !== '' && vaultHost === me;

  if (!isHost) {
    // A client never decrypts locally, so the only true answer comes from the server. The same
    // probe tells the sync banner whether the brain server is alive, which on a server-only
    // machine is what matters, not GitHub.
    const v = vaultProbe(BRAIN);
    serverAnswered = v.code === '200' || v.code === '403';
    if (total === 0) {
      /* no vault here, nothing to say about secrets */
    } else if (v.code === '200') {
      notes.push('VAULT: ' + (v.count < 0 ? 'readable' : v.count + ' secret(s) readable') + ' through the server from ' + me + '. Fetch one with: node tools/brain-client.mjs secret <name>.');
    } else if (v.code === '403') {
      notes.push('VAULT: secrets are deliberately withheld from ' + me + ' (recall-scoped token). Memories and rules work normally. Do not ask the owner for a credential and do not run connect-machine.');
    } else if (v.code === '401') {
      notes.push('VAULT: the server rejected this machine token (401), so secrets are unavailable until the host issues a new one. Memories work from the local copy. Do not run connect-machine.');
    } else if (v.code === 'no-token') {
      notes.push('VAULT: no server token on ' + me + ', so secrets and live recall are unavailable until the host issues one (see reference_brain_live_server). Memories work from the local copy. Do not run connect-machine.');
    } else {
      notes.push('VAULT: the server did not answer /vault/list from ' + me + ' (curl ' + v.code + '). Secrets are unavailable until it is back; memories work from the local copy. Nothing to install.');
    }
  } else if (total > 0 && readable === 0) {
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
  if (!noLocalBrain && !existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
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
// A push-disabled machine is server-only: memories and rules come from the brain server and code
// from the mirror. Its git remote may be unreachable by design (the locked-down client machine sits behind a
// corporate proxy that answers 403 forever). Ask git once. If the remote cannot be reached, do not
// restore generated files and do not pull: the restore was undoing the index the per-turn hook had
// just repaired from the server, at every session start, for a pull that could never happen
// (found by the the client company agent, 2026-09-07).
// On a machine that holds no memories, git is not consulted AT ALL: not for the remote, not to
// restore generated files, not to pull. There is nothing here for git to keep current, and the one
// thing it would do is put a copy of the brain back on the disk.
const pushUrl = noLocalBrain ? { ok: false, out: '' } : tryRun('git remote get-url --push origin', 5000);
const serverOnly = noLocalBrain || (pushUrl.ok && pushUrl.out.trim().startsWith('DISABLED-'));
const remoteReachable = noLocalBrain ? false
  : (serverOnly ? tryRun('git ls-remote --exit-code -q origin HEAD', 10000).ok : true);
let beforeRev = noLocalBrain ? { ok: false, out: '' } : tryRun('git rev-parse HEAD', 5000);
let unwedge = { ok: true, out: '' };
let pull = { ok: false, out: '', err: 'GitHub is not reachable from this machine', stderr: '' };
if (remoteReachable) {
  const genDirty = tryRun('git status --porcelain -- memory/MEMORY.md index/ MANIFEST.md', 5000);
  if (genDirty.ok && genDirty.out.trim()) {
    const restored = tryRun('git checkout -- memory/MEMORY.md index/ MANIFEST.md', 8000);
    if (restored.ok) notes.push('Discarded local edits to generated files (memory/MEMORY.md, index/, MANIFEST.md) so the pull could proceed. They are rebuilt from memory/, nothing was lost.');
  }

  // Honest pull: report success or failure, do not claim synced if it failed.
  // Capture HEAD first so we can tell what the pull actually brought in.
  beforeRev = tryRun('git rev-parse HEAD', 5000);
  // Before pulling, clear what the mirror left in the way. A mirror-delivered file at a path the
  // incoming commit adds makes git refuse the pull, quietly, and with the git timer gone this is
  // the only pull a client machine has. tools/unwedge-pull.mjs moves such untracked files aside
  // and restores tracked ones only when their bytes match the remote. See its header.
  unwedge = tryRun('node tools/unwedge-pull.mjs', 30000);
  pull = tryRun('git pull --no-rebase --quiet', 15000);
}

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

// Each outcome is named. Unwedge exits 0 always, so this line is the only place a wedge that
// came back would show, and 'FAILED (network or conflict)' told nobody which of the two it was:
// a laptop that is offline and a laptop that is silently stale looked the same (a laptop client, 2026-09-06).
const unwedgeSummary = (unwedge.out.split(LF).find((l) => l.startsWith('unwedge:')) || '').replace('unwedge: ', '').trim();
const keptFiles = unwedge.out.split(LF).filter((l) => l.includes('kept, differs')).map((l) => l.split(': ').pop().trim());
// Git names the files it refuses to overwrite on indented stderr lines. Those are the files unwedge
// left alone (or never saw, on a machine whose tools are older than unwedge itself).
const gitBlocked = /would be overwritten/.test(pull.stderr || '');
const indented = new RegExp('^[ ' + String.fromCharCode(9) + ']+[^ ]');
const gitFiles = gitBlocked ? (pull.stderr || '').split(LF).filter((l) => indented.test(l)).map((l) => l.trim()).filter((l) => !/^Please|^Aborting|^error|^hint/.test(l)) : [];
const blockedFiles = keptFiles.length ? keptFiles : gitFiles;
const offline = !remoteReachable || /fetch failed/.test(unwedgeSummary) || /unable to access|Could not read from remote|Could not resolve|Connection refused|timed out|Network is unreachable/.test(pull.stderr || '');
const unwedgeNote = unwedge.ok ? '' : ' Unwedge did not run on this machine (tools older than the fix, or node failed); pull it once by hand.';
let syncLine;
if (noLocalBrain) {
  // The only thing that can be missing here is the the host, so that is the only thing this line
  // talks about. It stays loud when the server is silent, because then the session really is
  // working blind and has to say so rather than answer from nothing.
  syncLine = serverAnswered
    ? 'Server-only machine: no memories on disk, which is the designed state. The brain server answered, so the tiers below came from it and recall reads it every turn. Git is not used here and nothing is stale.'
    : 'WARNING: THE BRAIN SERVER DID NOT ANSWER and this machine keeps no memories of its own, so you have NO recall this session. Say so in your first reply and do not answer from anything local. Check Tailscale, then: node tools/brain-client.mjs status';
} else if (pull.ok) {
  const touched = /moved [1-9]|restored [1-9]/.test(unwedgeSummary);
  syncLine = 'Brain synced (git pull ok).' + (touched ? ' Unwedge first: ' + unwedgeSummary + '.' : '') + (pushLine ? ' ' + pushLine : '');
} else if (blockedFiles.length) {
  syncLine = 'WARNING: brain pull BLOCKED by ' + blockedFiles.length + ' local file(s) that differ from the remote, left untouched to protect work: ' + blockedFiles.join(', ') + '. Memory is STALE until they are reconciled by hand: diff each against origin, then git checkout -- <file> or commit it.' + unwedgeNote;
} else if (offline && serverOnly && serverAnswered) {
  syncLine = 'Server-only machine: GitHub is not reachable from here, which is expected on this network. Memories and rules come from the brain server, which answered; code arrives through the mirror. Nothing is stale.';
} else if (offline && serverOnly) {
  syncLine = 'WARNING: server-only machine, and the brain server did not answer at session start. Recall runs on the local fallback copy until it is back; say so in your first reply if memory matters for the task.';
} else if (offline) {
  syncLine = 'WARNING: brain pull FAILED, the remote could not be reached' + (pull.err ? ' (' + pull.err + ')' : '') + '. Memory is STALE; nothing local was changed.' + unwedgeNote;
} else {
  syncLine = 'WARNING: brain pull FAILED' + (pull.err ? ': ' + pull.err : ' for an unnamed reason') + '. Memory is STALE. Run git pull by hand to see the full error.' + (unwedge.ok ? ' Unwedge ran first (' + (unwedgeSummary || 'no output') + ').' : unwedgeNote);
}

// Self-install the native git gate. core.hooksPath is per-clone config and therefore NOT
// carried by git, so a machine that pulls the brain would get hooks/git/pre-commit as an
// inert file and commit straight past the gate. Setting it here means every machine arms
// itself on its next session with no manual step. Idempotent and silent when already set.
const hp = noLocalBrain ? { ok: true, out: 'hooks/git' } : tryRun('git config --get core.hooksPath', 5000);
if (!hp.ok || hp.out !== 'hooks/git') {
  const set = tryRun('git config core.hooksPath hooks/git', 5000);
  if (set.ok) notes.push('Armed the brain git pre-commit gate on this machine (core.hooksPath).');
}

// Brain health. This replaced the open-PR queue on 2026-07-26, when the PR requirement was
// dropped in favour of verification: the whole brain is directly editable and `verify.mjs`
// is the gate. A stale PR count told an agent nothing actionable; a red brain does.
// Costs about 1.3s. Fails open, a broken or missing verifier must never block a session.
// The gate guards commits. A push-disabled machine never commits to the shared brain (its writes go
// through POST /memory and are gated on the server), so running verify here only cries wolf:
// no local model, an index repaired from the server, no brain.json. Skip it, say why.
const vr = serverOnly ? { ok: true, out: '' } : tryRun('node "' + BRAIN.split(String.fromCharCode(92)).join('/') + '/tools/verify.mjs" --quiet', 25000);
const prLine = serverOnly
  ? 'Gate: not run here, this machine never commits to the shared brain; verify runs on the host and on every server write.'
  : vr.ok ? 'Brain verify PASSED.' : 'WARNING: brain verify FAILED. The shared brain is broken for every machine. Run: node tools/verify.mjs';
if (!vr.ok) {
  notes.push('Brain verification is failing. Fix before making other changes:');
  notes.push('  node tools/verify.mjs');
  notes.push('A red gate usually means a hook or tool does not parse, the generated index');
  notes.push('drifted from memory/, or reflect.mjs found contradictions.');
}

// Open reminders. REMINDERS.md says "any agent surfaces the open ones proactively,
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
// Per-tier size caps. Tier 1.5 used to be MANIFEST.md at an 80,000 character cap, on the argument
// that truncating it would hide memories with no signal. Measured on 2026-09-21, that argument had
// already lost: the manifest was 187 KB, so 57 percent of it was cut and roughly 250 memories were
// invisible while the injected text told the session it was looking at everything. The owner, 2026-09-22,
// "do this", on dropping it for recall plus a hot list.
// index/HOT.md is small by construction and its own first line says it is not the whole brain, so
// no cap it can hit recreates that blind spot.
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
let router = readTier('memory/MEMORY.md', 16000);
let hot = readTier('index/HOT.md', 16000);

// Where there are no local files, the tiers are not missing, they are somewhere else. Fetch the
// router and HOT from the same server recall already reads, and never write them to disk: holding
// no copy is the whole point. REFLEX.md needs no fetch, it arrives with the code mirror.
if (noLocalBrain) {
  if (!router) {
    try { router = (JSON.parse(serverGet(BRAIN, '/memory/MEMORY')).content || '').trim().slice(0, 16000) || null; }
    catch { router = null; }
  }
  if (!hot) hot = (serverGet(BRAIN, '/index/HOT.md') || '').trim().slice(0, 16000) || null;
}

const parts = [
  'HAVOK BRAIN: ' + syncLine + ' ' + prLine + ' Enforcement hooks (no em dash, no emoji, secret scan) are active via the havok-brain plugin.',
];
if (notes.length) parts.push(notes.join('\n'));

if (reflex || router || hot) {
  parts.push(
    '',
    'The brain below IS your memory. It is injected in full, so do not re-read these files.',
    '',
    'RECALL IS NOT OPTIONAL AND IT IS NOT A SEARCH. Every turn, the brain searches ALL of its',
    'memories against what was just said and names the ones that match. OPEN them, ' + (noLocalBrain
      ? 'with `node tools/brain-client.mjs read <slug>`, before you answer or act.'
      : 'at'),
    noLocalBrain ? '' : '`' + BRAIN.replace(/\\/g, '/') + '/memory/<slug>.md`, before you answer or act.',
    'A description tells you whether to open a file, never what the file says, so never answer',
    'from the one line alone.',
    '',
    'The list below is NOT the whole brain and does not need to be. It is what this fleet has been',
    'using and what changed this week, so you know what you are walking into. To look by hand: ' + (noLocalBrain
      ? 'ask the server, nothing is on this disk.'
      : 'MANIFEST.md holds every slug on disk, index/<type>.md holds one type, grep -ril finds a term.'),
    '',
    'The most common failure is skipping this because you believe you already know the answer.',
    'You cannot know what the brain corrected, superseded, or decided since you last looked.',
    'When you learn something durable, write it back ' + (noLocalBrain
      ? 'with `node tools/brain-client.mjs write <slug> --file <path>`. Never create a file under'
        + ' memory/ on this machine: the mirror treats anything the server does not list as deleted.'
      : 'as a memory file under memory/.'),
  );
  // A half-loaded brain is more dangerous than an unloaded one: the session looks equipped
  // and quietly is not. Name the missing tier rather than just leaving a gap in the payload.
  //
  // But NEVER tell a machine to rebuild an index it must not hold. Most machines now keep no local
  // copy of the brain at all (The owner, 2026-09-22: local recall and a local brain copy are not an
  // option, the server is more secure and more synced), so memory/ and index/ are absent there by
  // design and these two lines fire on every session. Telling that machine to run build-index tells
  // it to recreate 529 memory files on a company-issued laptop, which is precisely what was deleted.
  // A noisy banner is survivable. A noisy banner carrying a harmful remedy is not. Caught by the
  // the client company session within the hour, on its own machine, which is the only place it shows.
  // Same question, one answer: noLocalBrain counts the memory FILES, while existsSync only saw the
  // directory, so an empty leftover memory/ made this line promise a rebuild on a machine that must
  // not hold one. When the tiers were fetched from the server these two notes do not fire at all.
  const LOCAL_MEMORIES = !noLocalBrain;
  const REMEDY = LOCAL_MEMORIES
    ? ' Rebuild it here: node tools/build-index.mjs'
    : ' This machine deliberately keeps no local copy of the brain, so this is EXPECTED and you must NOT create one. Recall comes from the server on every turn regardless.';
  if (!reflex) parts.push('', 'WARNING: REFLEX.md is missing or unreadable, so the always-on hard rules are NOT loaded. Treat nothing below as complete and fix the brain at ' + BRAIN.replace(/\\/g, '/'));
  if (!router) parts.push('', 'NOTE: memory/MEMORY.md is not readable here, so you have no router.' + REMEDY);
  if (!hot) parts.push('', 'NOTE: index/HOT.md is not readable here, so you start with no sense of what is in play. Per-prompt recall still reaches every memory, so this is not a broken brain.' + REMEDY);
  if (reflex) parts.push('', '===== BRAIN TIER 0: REFLEX (always applies) =====', reflex);
  if (router) parts.push('', '===== BRAIN TIER 1: MEMORY ROUTER =====', router);
  if (hot) parts.push('', '===== BRAIN TIER 1.5: HOT, what is in play right now (NOT everything) =====', hot);
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
