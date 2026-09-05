#!/usr/bin/env node
// UserPromptSubmit: the only hook that runs BEFORE the reply is written.
//
// Two jobs, one process, because this fires on every single turn and a second spawn would
// double the per-turn cost for no reason:
//   1. RECALL   - name the memories matching the prompt, so the brain gets used.
//   2. BUDGET   - state a length ceiling, so the reply is short on the FIRST attempt.
//
// WHY THIS EVENT AND NOT Stop
// check-stop.mjs already proves a Stop hook can read the finished reply and force a rewrite;
// that is how the em-dash rule actually holds. It is the wrong tool for length. Blocking IS
// regeneration: the wall of text was already written and paid for, and now a second full reply
// gets generated. The owner, 2026-08-07: "so it doesn't regenerate a reply it does it in first try".
//
// The Claude Code hook reference was checked rather than recalled (2026-08-07). Of every event
// in the lifecycle, only UserPromptSubmit and UserPromptExpansion fire before generation, the
// latter offers `decision: block` and nothing else, and no hook anywhere can constrain the
// assistant's prose directly. MessageDisplay can swap what appears on screen but explicitly
// leaves the transcript untouched, which would hide the problem rather than fix it. So an
// injected budget on this event is not the best available option, it is the only one.
//
// WHY IT WORKS WHEN THE SAME RULE IN REFLEX DOES NOT
// feedback_reply_length has existed in the brain for a while and the replies stayed long. A
// rule loaded once at session start is competing with a hundred thousand tokens of recency by
// turn fifty and loses. This arrives attached to the prompt, so it is the newest thing in the
// window every time. Nothing about the rule changed, only when it is delivered.
//
// FAILS SILENT ALWAYS. Running on every turn means a crash here would break every turn of
// every session on every machine. The worst acceptable outcome is the old behaviour.

import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { terms as qterms } from '../tools/tokenize.mjs';
import { execFileSync, spawn } from 'node:child_process';

// Synchronous HTTP to the local embed daemon.
//
// This hook is a short-lived process with a hard timeout, and every other read in it is
// synchronous, so an async fetch would mean restructuring the whole file. Blocking curl is
// crude but honest: 2s ceiling, loopback only, and ANY failure returns null, which drops the
// turn to keyword-only recall and says so in the injection rather than silently degrading.
// A file written by the daemon while it is alive, so the hook can skip the network entirely
// when it is not.
//
// Even with --connect-timeout 1, a refused connection on Windows cost about 1100ms on every
// turn with the daemon down, against 64ms for the whole hook before any of this existed. A
// stat() is microseconds. The daemon writes this file on boot and removes it on exit, and a
// stale file (a hard kill) costs exactly one slow turn before curl fails and it is cleared.
const ALIVE = join(homedir(), '.claude', 'havok-embed.alive');

// Translate a non-English prompt with the local claude CLI.
//
// Deliberately the smallest possible invocation: haiku, no MCP, no skills, no tools, and its
// own system prompt file so it cannot inherit the brain hooks. Without --system-prompt-file
// the call picked up this very brain and ANSWERED the question instead of translating it.
function translateSync(text, brainDir) {
  try {
    const sys = join(brainDir, 'index', 'translate-system.txt');
    if (!existsSync(sys)) return null;
    const out = execFileSync('claude', [
      '-p', '--model', 'haiku', '--output-format', 'json',
      '--system-prompt-file', sys,
      '--strict-mcp-config', '--disable-slash-commands',
      '--disallowed-tools', 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task Agent TodoWrite Monitor Skill SlashCommand',
    ], {
      input: Buffer.from(text, 'utf8'),
      encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const r = JSON.parse(out || '{}').result;
    return (typeof r === 'string' && r.trim() && r.length < 500) ? r.trim() : null;
  } catch { return null; }
}

// Ask the SERVER machine for a vector when this machine has no local daemon.
//
// The owner, 2026-08-21: "I want this server here to have the brain, the embedding system, the memory
// and everything. And all other machines, when they want to use it, they access it." Until now
// this hook only ever asked 127.0.0.1, so a laptop with no daemon silently dropped to keyword
// recall and the whole point of hosting the model centrally was never wired up.
//
// The address is DISCOVERED, not configured: server-endpoint.json travels in the repo, so no
// machine is hand-configured with a URL. The token comes from that machine own vault, so no
// credential is ever fetched from the server it authenticates to.
//
// LAN ONLY, on purpose. The owner, 2026-08-21: "when I mean over the internet, I mean over the
// network. If I am not on the same network I have to use a specific proxy or a VPN, so that
// nobody else can access it." An earlier version tunnelled this to a public hostname; that was
// deleted, and with it the objection that Cloudflare terminates TLS and could read secrets.
//
// BRAIN is passed in rather than closed over. It is declared further down this file, inside a
// block, so a module-level function referencing it throws at call time. That exact mistake already
// cost hours here once, in translateSync, which is why translateSync takes it as a parameter too.
let LAST_SERVER_V = null;
let REMOTE = undefined;
// Where the token comes from, cheapest source first.
//
// MEASURED 2026-08-22: reading it from the vault costs 155-165ms, because it spawns a node process
// and does an age decryption. The recall round trip it protects costs 6.7ms. Paying 165ms every
// prompt to re-fetch a credential that has not changed is 23x the cost of the work itself, and it
// was the whole reason server-side recall first measured SLOWER than local matching, 431ms against
// 121ms. The architecture was fine; the credential lookup in front of it was not.
//
// TWO SEPARATE FILES ON PURPOSE, and mixing them up would be serious:
//   SERVER_TOKEN_FILE is the server's OWN token on the machine that runs it. Read it, never write
//     it, and NEVER delete it. Deleting it would take the brain server down for every machine.
//   TOKEN_CACHE is this hook's decrypted copy on a client machine. Safe to delete, and deleting it
//     is exactly how a rotation self-heals: the next turn re-reads the vault.
// Neither is git-tracked.
const SERVER_TOKEN_FILE = join(homedir(), '.claude', 'havok-server-token');
const TOKEN_CACHE = join(homedir(), '.claude', 'havok-token-cache');

function remoteEmbedConfig(brain) {
  if (REMOTE !== undefined) return REMOTE;
  REMOTE = null;
  try {
    const ep = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8'));
    if (!ep.url) return REMOTE;

    // Never resolve a name to reach yourself.
    //
    // server-endpoint.json publishes a HOSTNAME on purpose, because the host takes a DHCP address
    // that changes on reboot. MEASURED 2026-08-22 on this machine: resolving "server" costs 316ms
    // against 88ms for loopback, so name resolution alone was 228ms of every prompt. On the host
    // that cost buys literally nothing, since the destination is this machine.
    //
    // This does NOT help the other machines, which still resolve the name and still pay it. That
    // is a real cost a laptop client has been paying on every prompt all along, hidden until now because
    // this machine used its local daemon and never resolved anything. Tailscale's MagicDNS is the
    // intended fix; if it does not deliver, an IP cache with fallback is the next move.
    let url = ep.url;
    try {
      const host = String(JSON.parse(readFileSync(join(brain, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase();
      const me = String(process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
      if (host && host === me) url = url.replace(/\/\/[^/:]+/, '//127.0.0.1');
    } catch { /* no recipients file: keep the published url */ }

    let token = '';
    for (const f of [SERVER_TOKEN_FILE, TOKEN_CACHE]) {
      try { token = readFileSync(f, 'utf8').trim(); } catch { /* next source */ }
      if (token) break;
    }
    if (!token) {
      token = execFileSync(process.execPath, [join(brain, 'tools', 'vault.mjs'), 'get', 'havok_server_token'],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // mode 0600 so it is not world-readable. Best effort: a failed cache write costs latency,
      // never correctness.
      if (token) { try { writeFileSync(TOKEN_CACHE, token, { encoding: 'utf8', mode: 0o600 }); } catch { /* optimisation only */ } }
    }
    // Certificate PINNING for https. The server uses a self-signed certificate on purpose, so the
    // only thing that makes it trustworthy is that we accept exactly this one and nothing else.
    // Without the cacert line curl would reject it outright; with a blanket --insecure it would
    // accept anything, which is worse than plaintext because it looks encrypted while any machine
    // on the network could impersonate the server. Neither shortcut is acceptable, so the public
    // certificate travels in the repo and is named explicitly.
    let cacert = '';
    if (/^https:/i.test(url)) {
      const c = join(brain, 'server-cert.pem');
      if (existsSync(c)) cacert = c.replace(/\\/g, '/');
    }
    if (token) REMOTE = { url, token, cacert };
  } catch { /* no endpoint, no vault access, or no age key: stay on keyword recall */ }
  return REMOTE;
}

// Called when the server rejects our token, so a rotation heals itself on the next turn instead of
// leaving the machine locked out until someone notices. Only ever removes the CACHE.
function forgetCachedToken() {
  try { unlinkSync(TOKEN_CACHE); } catch { /* was not cached */ }
}

// The behaviour rules, from the server, when this machine has no local copy.
//
// Found 2026-08-22 while testing a machine that holds no index at all: it got recall from the
// server but only ONE rule, the tier line computed locally, plus a "rules unavailable" notice. It
// lost all eight behaviour rules. That is worse than losing recall. An agent with no rules writes
// long, claims things are done it has not verified, and tells the owner the problem is his end, which
// are precisely the behaviours these rules exist to stop, and nothing on screen would say why.
//
// A SECOND round trip, and only for machines with no local rules.json. Folding rules into the
// recall response would save the call but add roughly 3KB to every response on every machine that
// does not need it. This costs one extra curl spawn on the rare machine, and nothing on the rest.
function fetchRulesRemote(brain) {
  if (remoteRecentlyFailed()) return null;
  const cfg = remoteEmbedConfig(brain);
  if (!cfg) return null;
  try {
    const conf = 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
      + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
      + 'url = "' + cfg.url + '/rules"' + '\n'
      + 'silent' + '\n' + 'connect-timeout = 1' + '\n' + 'max-time = 5' + '\n';
    const out = execFileSync('curl', ['-K', '-'], {
      input: conf, encoding: 'utf8', windowsHide: true, timeout: 6000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out || '{}');
    return Array.isArray(parsed.rules) ? parsed.rules : null;
  } catch { return null; }
}

// Remember that the server was unreachable, so a laptop off the network does not pay for the
// discovery on every single turn.
//
// MEASURED 2026-08-22, on this machine, rather than guessed. With the server unreachable:
//   unroutable address, connect-timeout 2 : 2046 ms
//   unroutable address, connect-timeout 1 : 1029 ms
//   name does not resolve, timeout 2      : 1560 ms
//   name does not resolve, timeout 1      : 1024 ms
//   server reachable                      :  254 ms
// So a laptop away from home would have added one to two seconds to EVERY prompt, which reads as
// "Claude got slow" and never as "I left the house". a laptop client raised it before the owner noticed it,
// which is the only reason it is being fixed now rather than after a week of complaints.
//
// A shorter timeout alone does not solve it: one second on every turn forever is still a tax on
// the common case. A stat() is microseconds, so after a failure the remote is skipped entirely
// until the cooldown lapses. Same trick the local daemon check already uses.
const REMOTE_DOWN = join(homedir(), '.claude', 'havok-remote-embed-down');
const DOWN_COOLDOWN_MS = 10 * 60 * 1000;

// The mark carries WHY, not just when. a laptop client, 2026-08-22: a degraded state that nothing can
// explain leaves the user inferring it from answers feeling shallower. With a reason recorded,
// `brain-client status` can say "remote embed skipped, marked down 4 minutes ago, connection
// refused" instead of the user guessing.
function readRemoteDown() {
  try {
    const raw = readFileSync(REMOTE_DOWN, 'utf8').trim();
    // Tolerate the first format, a bare epoch, so an existing mark does not read as corrupt.
    if (/^\d+$/.test(raw)) return { at: Number(raw), reason: 'unknown (written before reasons were recorded)' };
    const j = JSON.parse(raw);
    return { at: Number(j.at), reason: String(j.reason || 'unknown') };
  } catch { return null; }
}

function remoteRecentlyFailed() {
  const m = readRemoteDown();
  if (!m || !Number.isFinite(m.at)) return false;
  const age = Date.now() - m.at;
  return age >= 0 && age < DOWN_COOLDOWN_MS;
}

function fetchVectorRemote(text, brain) {
  // Cheapest possible gate, before config parsing or a vault read.
  if (remoteRecentlyFailed()) return null;
  const cfg = remoteEmbedConfig(brain);
  if (!cfg) return null;
  try {
    // The token goes in a curl CONFIG on stdin, never in argv. On 2026-08-21 passing it with -H
    // put it in the command line, a curl failure echoed the whole command line, and the token
    // landed in a transcript and had to be rotated. argv is readable by other processes anyway.
    const conf = 'header = "content-type: application/json"' + '\n'
      + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
      + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
      + 'url = "' + cfg.url + '/embed"' + '\n'
      + 'request = "POST"' + '\n'
      + 'data-binary = "' + JSON.stringify({ text }).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
      + 'silent' + '\n' + 'connect-timeout = 1' + '\n' + 'max-time = 4' + '\n';
    const out = execFileSync('curl', ['-K', '-'], {
      input: conf, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsedOne = JSON.parse(out || '{}');
    if (parsedOne.v) LAST_SERVER_V = parsedOne.v;
    const v = parsedOne.vector;
    if (Array.isArray(v)) {
      // Back on the network: clear the mark so recall recovers on this turn, not in ten minutes.
      try { unlinkSync(REMOTE_DOWN); } catch { /* was not marked */ }
      return v;
    }
    // Reached the server and got something that was not a vector. Almost always auth: a 401 body
    // parses fine and simply has no `vector`. Worth distinguishing, because "server unreachable"
    // and "token rejected" need completely different fixes.
    if (parsedOne.error === 'unauthorized') forgetCachedToken();
    markRemoteDown('server answered without a vector, likely an expired or wrong token');
    return null;
  } catch (e) {
    const msg = String(e && e.message || '');
    markRemoteDown(/ETIMEDOUT|timed out/i.test(msg) ? 'timed out reaching the server'
      : /ENOENT/i.test(msg) ? 'curl not found on this machine'
      : 'could not reach the server, off the network or it is down');
    return null;
  }
}

// Ask the server for MANY vectors in one round trip.
//
// Chunking a long prompt made this hook issue one call per chunk. Measured from a laptop client on a
// real prompt: 8 calls, 273ms of actual server work, 2083ms of wall clock. About 226ms per call
// was pure round-trip overhead, so a long prompt went from ~130ms to over two seconds before the
// reply started. The model was never the cost; the round trips were.
//
// The local daemon on 8477 has no batch route and does not need one: it is loopback and answers
// in about 4ms, so looping there costs nothing worth engineering around.
function fetchVectorsRemote(texts, brain) {
  if (remoteRecentlyFailed()) return null;
  const cfg = remoteEmbedConfig(brain);
  if (!cfg) return null;
  try {
    const conf = 'header = "content-type: application/json"' + '\n'
      + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
      + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
      + 'url = "' + cfg.url + '/embed"' + '\n'
      + 'request = "POST"' + '\n'
      + 'data-binary = "' + JSON.stringify({ texts }).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
      + 'silent' + '\n' + 'connect-timeout = 1' + '\n' + 'max-time = 8' + '\n';
    const out = execFileSync('curl', ['-K', '-'], {
      input: conf, encoding: 'utf8', windowsHide: true, timeout: 9000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out || '{}');
    if (parsed.v) LAST_SERVER_V = parsed.v;
    const vs = parsed.vectors;
    if (Array.isArray(vs) && vs.length) {
      try { unlinkSync(REMOTE_DOWN); } catch { /* was not marked */ }
      return vs;
    }
    if (parsed.error === 'unauthorized') forgetCachedToken();
    markRemoteDown('server answered without vectors, likely an expired or wrong token');
    return null;
  } catch {
    markRemoteDown('could not reach the server for a batch embed');
    return null;
  }
}

// Ask the server for the ANSWER instead of for vectors.
//
// The owner, 2026-08-22: "the brain is on the server twenty four seven, and every other agent has to
// access the brain, and they go through the server." This is the read path of that. The machine
// sends its prompt and its prepared chunks; the server matches against the index it owns and
// returns ranked memories. Nothing about the index needs to exist on this machine.
//
// Verified 2026-08-22 across all 41 eval prompts: identical to local matching, same order, on
// every one.
//
// NULL MEANS "FALL BACK", NEVER "NOTHING MATCHED". Those two are completely different and
// confusing them would silently blank the brain: an empty ranked list from a healthy server is a
// real answer, while null means this machine could not ask and must score locally instead.
//
// A bad RESPONSE does not mark the server down, only a failure to reach it does. A 400 from a
// healthy server is a bug in this file, and disabling remote embedding for ten minutes because of
// it would turn a small bug into an outage.
function fetchRecallRemote(prompt, queries, brain) {
  if (remoteRecentlyFailed()) return null;
  const cfg = remoteEmbedConfig(brain);
  if (!cfg) return null;
  try {
    const payload = JSON.stringify({ prompt: String(prompt).slice(0, 20000), queries });
    const conf = 'header = "content-type: application/json"' + '\n'
      + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
      + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
      + 'url = "' + cfg.url + '/recall"' + '\n'
      + 'request = "POST"' + '\n'
      + 'data-binary = "' + payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
      + 'silent' + '\n' + 'connect-timeout = 1' + '\n' + 'max-time = 8' + '\n';
    const out = execFileSync('curl', ['-K', '-'], {
      input: conf, encoding: 'utf8', windowsHide: true, timeout: 9000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out || '{}');
    if (parsed.v) LAST_SERVER_V = parsed.v;
    if (!Array.isArray(parsed.ranked)) return null;
    try { unlinkSync(REMOTE_DOWN); } catch { /* was not marked */ }
    return parsed.ranked;
  } catch {
    markRemoteDown('could not reach the server for recall');
    return null;
  }
}

// Notice when the server's index has moved on, and repair in the BACKGROUND.
//
// The owner, 2026-08-22: "when there is a version change, because I don't restart my session a lot."
// He is right that session-start-only is not enough: this very session has been open all day, so
// a machine could sit stale for days.
//
// Three properties this has to have, and the order matters:
//   1. NEVER make him wait. The turn that notices a change still answers from the index it
//      already has, and the repair runs detached. Next turn is fresh. Refetching 500KB inside a
//      per-turn hook would trade a rare staleness problem for a constant latency one.
//   2. Cost nothing when nothing changed, which is almost every turn. The version rides along on
//      the embed response that already happens, so there is no extra request, and the local side
//      is cached on mtime so it is a few stat() calls rather than hashing 500KB.
//   3. Never fight itself. A marker file stops a second repair starting while one is running.
const SYNC_LOCK = join(homedir(), '.claude', 'havok-index-syncing');
let localVersionCache = null;

function localIndexVersion(brain) {
  const names = ['keywords.json', 'embeddings.json', 'rules.json', 'contact.md', 'feedback.md', 'project.md', 'reference.md', 'user.md', 'translate-system.txt'];
  const stat = [];
  for (const n of names) {
    try { const st = statSync(join(brain, 'index', n)); stat.push(n + ':' + st.size + ':' + Math.floor(st.mtimeMs)); } catch { /* absent */ }
  }
  const key = stat.join('|');
  if (localVersionCache && localVersionCache.key === key) return localVersionCache.version;
  const whole = createHash('sha256');
  for (const n of names) {
    try { whole.update(n + ':' + createHash('sha256').update(readFileSync(join(brain, 'index', n))).digest('hex').slice(0, 16) + '|'); } catch { /* absent */ }
  }
  const version = whole.digest('hex').slice(0, 16);
  localVersionCache = { key, version };
  return version;
}

function repairIndexInBackground(serverVersion, brain) {
  if (!serverVersion) return null;
  let mine;
  try { mine = localIndexVersion(brain); } catch { return null; }
  if (mine === serverVersion) return null;

  // A repair already running is not a reason to start another one. Stale lock after 5 minutes,
  // so a killed process cannot wedge this permanently.
  try {
    const age = Date.now() - Number(readFileSync(SYNC_LOCK, 'utf8').trim());
    if (age >= 0 && age < 5 * 60 * 1000) return 'already refreshing';
  } catch { /* no lock */ }
  try { writeFileSync(SYNC_LOCK, String(Date.now()), 'utf8'); } catch { /* best effort */ }

  try {
    const child = spawn(process.execPath, [join(brain, 'tools', 'brain-sync.mjs'), '--quiet'], {
      detached: true, stdio: 'ignore', cwd: brain,
    });
    child.unref();
  } catch { return null; }
  return 'refreshing';
}

function markRemoteDown(reason) {
  try {
    writeFileSync(REMOTE_DOWN, JSON.stringify({ at: Date.now(), reason: reason || 'unknown' }), 'utf8');
  } catch { /* best effort, a mark that cannot be written just costs a retry next turn */ }
}

// Start the local embedder ourselves when it is not running, so semantic recall is on by default
// on every machine that installed the runtime, with no scheduler and no one keeping a daemon
// alive by hand. Added 2026-09-05 when a fresh clone of the published engine turned out to run
// keyword-only forever, because "optional" meant nobody ever started it.
//
// Guarded three ways: only if the runtime is installed here, only one spawn per five minutes (a
// cold model load is about 15s, and every prompt in that window must not fork another), and
// detached with all stdio ignored so a hook that must finish in milliseconds never waits on it.
// THIS turn still falls back to the server or to keyword; the next one gets the daemon.
const EMBED_LOCK = resolve(homedir(), '.claude', 'havok-embed-starting');
function ensureEmbedDaemon(brain) {
  try {
    if (!existsSync(join(brain, 'node_modules', '@xenova', 'transformers'))) return;
    if (!existsSync(join(brain, 'tools', 'embed-server.mjs'))) return;
    try {
      const age = Date.now() - Number(readFileSync(EMBED_LOCK, 'utf8').trim());
      if (age >= 0 && age < 5 * 60 * 1000) return;
    } catch { /* no lock */ }
    writeFileSync(EMBED_LOCK, String(Date.now()), 'utf8');
    const child = spawn(process.execPath, [join(brain, 'tools', 'embed-server.mjs')], { detached: true, stdio: 'ignore', cwd: brain, windowsHide: true });
    child.unref();
  } catch { /* best effort, keyword recall still works */ }
}

function fetchVectorSync(text, brain) {
  // Local daemon first: it is on loopback and answers in milliseconds. Only fall out to the
  // network when this machine is not running one.
  if (!existsSync(ALIVE)) { ensureEmbedDaemon(brain); return fetchVectorRemote(text, brain); }
  try {
    // Body over STDIN, never as an argv value.
    //
    // Passing it with -d put the text through the Windows command line, which mangles
    // non-ASCII. The same Arabic query sent by argv and by stdin produced vectors with
    // cosine 0.27 between them, so the daemon was embedding corrupted bytes and silently
    // defeating the entire reason the multilingual model was chosen. Verified 2026-08-19.
    const out = execFileSync("curl", [
      // 2s was the wrong ceiling: with the daemon down, curl burned the FULL timeout on every
      // single turn, taking the hook from 64ms to 2112ms. That is worse than the problem the
      // dense channel solves. --connect-timeout fails in milliseconds when nothing is
      // listening, while --max-time still bounds a slow response from a daemon that IS up.
      "-s", "--connect-timeout", "1", "--max-time", "3", "-X", "POST",
      "http://127.0.0.1:" + (process.env.HAVOK_EMBED_PORT || 8477) + "/embed",
      "-H", "content-type: application/json",
      "--data-binary", "@-",
    ], {
      input: Buffer.from(JSON.stringify({ text }), "utf8"),
      encoding: "utf8", timeout: 3500, stdio: ["pipe", "pipe", "ignore"],
    });
    const v = JSON.parse(out || "{}").vector;
    // A dead daemon can leave the marker behind: Stop-Process kills it before the exit handler
    // runs, and that is exactly how it died on 2026-08-21. In that state the marker says alive,
    // the local call fails, and without this the remote fallback would never be tried at all.
    if (Array.isArray(v)) return v;
    ensureEmbedDaemon(brain);
    return fetchVectorRemote(text, brain);
  } catch { ensureEmbedDaemon(brain); return fetchVectorRemote(text, brain); }
}

const ok = (ctx) => {
  if (ctx) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
    }));
  }
  process.exit(0);
};

try {
  const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const marker = (() => {
    try { return readFileSync(resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-brain-path'), 'utf8').trim(); }
    catch { return null; }
  })();
  // A directory is only THIS brain if it carries the artifacts this hook needs. Testing for a
  //  folder alone was far too loose: four directories on this machine qualified,
  // including a frozen plugin cache from May and the Claude Code project folder, and two of
  // them have no rules.json at all. Resolving to one of those silently strips every behaviour
  // rule while the gate, which checks the brain it sits in rather than the one the hook picks,
  // keeps reporting healthy. Found by a red-team pass, 2026-08-18.
  const isBrain = (p) => {
    try {
      return !!p && existsSync(join(p, 'memory'))
        && existsSync(join(p, 'REFLEX.md'));
    } catch { return false; }
  };
  // ORDER MATTERS. The explicit env var first. Then the brain this hook physically lives in,
  // because install-hook.mjs registered THIS path on purpose. The global marker last: it used to
  // come second, so a second brain installed on a machine that already had one silently recalled
  // from the first. Found on 2026-09-05 by cloning the export on the author's own machine.
  const BRAIN = [process.env.HAVOK_BRAIN, HERE, marker].find(isBrain) || HERE;

  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let prompt = '';
  try { prompt = String(JSON.parse(raw || '{}').prompt || ''); } catch { prompt = raw; }
  if (!prompt.trim()) ok('');

  const head = prompt.slice(0, 2000).toLowerCase();
  const out = [];

  // ---- 1. BUDGET -----------------------------------------------------------------------
  //
  // The tier is judged from what the owner asked for, because length is not the real rule. His own
  // memory: long is allowed when he asks for analysis, a plan, or a decision with tradeoffs.
  // A flat ceiling would fight exactly the answers he wanted, so depth requests are exempted
  // from the word count and only kept clean of padding.
  const DEPTH = /\b(plan|analys|analyz|compare|comparison|tradeoff|trade-off|pros and cons|options|design|architect|audit|review|brainstorm|exhaust|research|investigate|walk me through|explain why|deep dive|strategy|roadmap)\b/;
  const ACTION = /^(log|add|send|set|update|delete|remove|fix|change|rename|commit|push|run|start|stop|restart|check)\b|\bi (ate|drank|paid|bought|spent|weigh)\b/;

  // No word counts. The owner, 2026-08-07: "I don't want hard limit like number of words, just the
  // meaning of short." He is right that a number is the wrong instrument. It measures the
  // symptom, and it is gameable in both directions: padding up to the limit, or truncating an
  // answer that needed the room. The test below is about whether a sentence earns its place,
  // which is the actual rule, and it applies identically to a one-line confirmation and to a
  // full design discussion.
  // WHOSE brain this is, and the pronoun to use for them.
  //
  // These were hardcoded as one name and one pronoun until 2026-09-05, which was invisible here and
  // obvious the moment a clean export was installed: a brand new brain greeted its owner with
  // "HOW TO REPLY TO <the owner's name>". Found by running the install, not by reading the file.
  //
  // Set HAVOK_OWNER and HAVOK_OWNER_PRONOUN, or brain.json {"owner":"...","pronoun":"..."}.
  // The default is deliberately neutral rather than a name.
  let OWNER = process.env.HAVOK_OWNER || "";
  let PRONOUN = process.env.HAVOK_OWNER_PRONOUN || "";
  try {
    const cfg = JSON.parse(readFileSync(join(BRAIN, "brain.json"), "utf8"));
    OWNER = OWNER || cfg.owner || "";
    PRONOUN = PRONOUN || cfg.pronoun || "";
  } catch { /* no config, use the neutral default */ }
  const WHO = OWNER ? ("TO " + OWNER.toUpperCase()) : "TO THE USER";
  const THEY = PRONOUN || "they";
  const CAP = THEY.charAt(0).toUpperCase() + THEY.slice(1);

  let tier;
  if (DEPTH.test(head)) {
    tier = CAP + ' asked for depth here, so take the room you need for the substance. The cuts below still apply.';
  } else if (ACTION.test(head)) {
    tier = CAP + ' asked you to DO something. Say it is done and give the numbers that changed, plus anything that surprised you while doing it.';
  } else {
    tier = CAP + ' asked a question. Answer it and stop.';
  }

  // The rules are GENERATED, not written here.
  //
  // They used to be hardcoded in this file, and were also restated in REFLEX.md,
  // METHODOLOGIES.md, both CLAUDE.md files and their own feedback memories. Measured
  // 2026-08-18: "verify" appeared in 7 files, "em dash" in 6. Editing a memory changed nothing,
  // because the sentence the agent actually read lived here. That is the split-brain the brain
  // exists to prevent, rebuilt one layer up. the owner: "let's fix this mess, not just patch it."
  //
  // Now: a feedback memory carries a `rule:` line, build-index compiles them into
  // index/rules.json in `rule_order`, and this reads that. One source, one edit, every turn on
  // every machine. Falls back to the tier line alone if the file is missing, which degrades to
  // quiet rather than to an agent with no rules and no warning.
  out.push(
    'HOW TO REPLY ' + WHO + '. Generated from the brain, delivered every turn because a rule loaded',
    'once at session start loses to recency by turn fifty.',
    '',
    '1. ' + tier,
  );
  let rules = null;
  try { rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || []; }
  catch { rules = null; }
  // No local copy: ask the server, which owns them. Silence here would strip every behaviour rule
  // from the turn with nothing on screen to say so.
  if (!rules || !rules.length) rules = fetchRulesRemote(BRAIN);
  if (rules && rules.length) {
    rules.forEach((r, i) => out.push(`${i + 2}. ${r.rule}`));
  } else {
    out.push('(brain rules unavailable: no local index/rules.json and the brain server could not be'
      + ' reached. You are running with almost no behaviour rules. Tell the owner before answering.)');
  }

  // ---- 2. RECALL -----------------------------------------------------------------------
  const idxPath = join(BRAIN, 'index', 'keywords.json');
  // NOT a gate any more. This used to be `if (existsSync(idxPath))`, which meant a machine holding
  // no local index got no recall at all, even with a healthy server one round trip away. That is
  // exactly backwards: those are the machines the server exists for.
  const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : null;
  {

    // DENSE CHANNEL, fused with the keyword one rather than replacing it.
    //
    // Keyword retrieval cannot reach a paraphrase: "stop writing so much" shares no word with
    // the reply-length memory, and Arabic script tokenizes to nothing at all because the
    // tokenizer splits on [^a-z0-9]. Embeddings fix both. Measured on the 40-query eval:
    // sparse 87.5%, dense 92.5%, fused 92.5%. Fusion does not beat dense alone here and is
    // kept anyway, because sparse holds the exact-name lookups ("a specific person and a specific vendor")
    // that dense blurs, and because it still answers when the model is unavailable.
    //
    // The vector comes from a resident daemon, never from loading the model here: in-process
    // load costs 1285ms even warm, against 64ms for this whole hook. Daemon down means
    // keyword-only, which is a real degradation and is stated in the injection.
    let denseRanked = [];
    let denseNote = "";
    // Set when the SERVER did the matching. The owner, 2026-08-22: "the brain is on the server twenty
    // four seven, and every other agent has to access the brain, and they go through the server."
    // When this is set, every local scoring step below is skipped: the answer is already ranked.
    let serverRanked = null;
    try {
      const embPath = join(BRAIN, "index", "embeddings.json");
      // No longer a gate. A machine that holds no embeddings index must still be able to ask the
      // server, and gating the whole block on a local file meant exactly the machines the server
      // exists for could never reach it.
      const emb = existsSync(embPath) ? JSON.parse(readFileSync(embPath, "utf8")) : null;
      {
        // Arabic script: skip the dense channel and say so.
        //
        // The model is English-only by deliberate choice (the owner: "we work 99% in english
        // only"), and it scores near zero on Arabic rather than failing. A near-zero score
        // still RANKS, so the fusion would happily promote whatever noise came top, which is
        // worse than not scoring at all. The tokenizer drops Arabic too, so both channels are
        // blind and the only honest move is to say so and let him retype in English.
        const hasArabic = /[؀-ۿݐ-ݿ]/.test(prompt);
        // Arabic: translate to English first, then embed the translation.
        //
        // Three approaches were measured on 2026-08-19, and only the third works:
        //   1. Multilingual model. Handles Arabic but drops the English eval 100 -> 92.5,
        //      and the right memory still ranked 47th, because every description is English.
        //   2. Character transliteration. Free, and made it WORSE: rank 94 -> 120. Naive
        //      mapping produces "kyfach nsjl alkryatyn", which is not how Darija is written
        //      in Latin script, so it matches nothing.
        //   3. Translate with the local claude CLI. "How do we log creatine?", which
        //      retrieves correctly. Costs 5.5s.
        //
        // 5.5s is 42x the normal 129ms turn, so it is paid ONLY on an Arabic prompt, which
        // the owner says is about 1% of what he writes. English turns are untouched. If the
        // translation fails or times out, the turn degrades to the honest "brain was not
        // consulted" note rather than embedding text the model cannot read.
        let queryText = prompt.slice(0, 2000);
        if (hasArabic) {
          const translated = translateSync(queryText, BRAIN);
          if (translated) {
            queryText = translated;
            denseNote = "NOTE: your prompt was in Arabic. It was translated to English for recall (\"" + translated.slice(0, 80) + "\"). If that translation is wrong, the memories below are the wrong ones.";
          } else {
            denseNote = "NOTE: this prompt is in Arabic and the translation step failed, so the brain was NOT consulted. Ask again in English or French, or tell the owner the brain was not searched for this one.";
          }
        }
        // CHUNK a long prompt instead of averaging it into one vector.
        //
        // Found 2026-08-22 by watching a live prompt from a laptop client log as chars=2000 exactly,
        // which is a cap and not a coincidence. The sparse channel was fixed months ago to read
        // the whole prompt, because the owner pastes logs and emails constantly and his question lands
        // after the paste. The dense channel never got that fix and still saw the first 2000
        // characters only.
        //
        // Sending MORE text does not fix it, and two wrong attempts proved that before this one.
        // Measured on a 2402-char prompt whose question started at char 2341, target memories at:
        //   head 2000 (the shipped behaviour) : rank 74 and 37
        //   head 2000 + tail 2000             : rank 68 and 38   <- first attempt, useless
        //   tail 500 alone                    : rank 10 and  5
        //   the question with no paste at all : rank  1 and  3
        // A 2000-char tail of a 2402-char prompt is still 97% paste. One 384-dim vector cannot
        // represent a long paste AND a short question: the mean washes the question out.
        //
        // So: split into sentence-packed chunks and take each memory's BEST-matching chunk rather
        // than its similarity to the average. A question then competes on its own merits instead
        // of being outvoted by volume. Standard long-document retrieval, measured here at:
        //   paste then question : rank 1 and 5   (was 74 and 37)
        //   question then paste : rank 4 and 9   (was 19 and 13)
        // Better on both shapes, and identical to today on short prompts, which take one call.
        //
        // Cost is bounded: chunking only happens above 2000 chars, at most 10 calls, measured at
        // about 330ms locally. Long prompts are rare and already slow to type.
        const CHUNK_CHARS = 400, MAX_CHUNKS = 8;
        function chunkPrompt(text) {
          const parts = text.split(/(?<=[.!?\n])\s+/);
          const out = [];
          let cur = '';
          for (const p of parts) {
            if ((cur + ' ' + p).length > CHUNK_CHARS && cur) { out.push(cur.trim()); cur = p; }
            else cur = cur ? cur + ' ' + p : p;
          }
          if (cur.trim()) out.push(cur.trim());
          let kept = out;
          if (out.length > MAX_CHUNKS) {
            const end = Math.ceil(MAX_CHUNKS / 2);
            kept = [...out.slice(0, MAX_CHUNKS - end), ...out.slice(-end)];
          }
          // The packer glues short sentences together until a chunk is full, which buries a
          // 62-char question inside 400 chars of paste. Embed the first and last SENTENCE on
          // their own too, because that is where a question actually lives. Without this, the
          // "question then paste" shape scored 0 of 2; with it, 1 of 2.
          const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
          if (sentences.length > 1) {
            for (const edge of [sentences[0], sentences[sentences.length - 1]]) {
              if (edge.length >= 12 && edge.length <= CHUNK_CHARS && !kept.includes(edge)) kept.push(edge);
            }
          }
          return kept;
        }

        const queries = (!hasArabic && prompt.length > 2000) ? chunkPrompt(prompt) : [queryText];
        const translationFailed = hasArabic && queryText === prompt.slice(0, 2000);

        // ASK THE SERVER FIRST. It holds the index and does the matching, so one round trip
        // returns the ranked answer and every scoring step below is skipped.
        //
        // The prompt preparation above still happens HERE and not on the server, deliberately:
        // chunking is pure string work that costs nothing locally, and the Arabic path needs the
        // claude CLI on this machine. The server receives the already-prepared queries.
        if (!translationFailed) serverRanked = fetchRecallRemote(prompt, queries, BRAIN);

        let vecs = [];
        if (serverRanked || translationFailed) {
          // Nothing to do locally. Either the server already answered, or the prompt is Arabic and
          // the translation failed, so there is nothing worth embedding.
        } else if (!emb) {
          denseNote = 'NOTE: semantic recall is OFF (this machine holds no embeddings index and the '
            + 'brain server is unreachable). Keyword only, so a paraphrase may not match.';
        } else if (queries.length > 1 && !existsSync(ALIVE)) {
          // No local daemon, so every chunk would be its own network round trip. One request.
          const batch = fetchVectorsRemote(queries, BRAIN);
          if (batch) vecs = batch.filter((v) => Array.isArray(v) && v.length === emb.dims);
        } else {
          for (const q of queries) {
            const v = fetchVectorSync(q, BRAIN);
            if (v && v.length === emb.dims) vecs.push(v);
            // One dead call means the server went away mid-prompt; stop rather than pay for the rest.
            else if (!v) break;
          }
        }
        const vec = vecs[0] || null;
        if (vecs.length) {
          // MAX over chunks, not mean. Taking the best chunk is the entire point: a mean would
          // reintroduce exactly the dilution this replaced.
          const best = new Float64Array(emb.slugs.length).fill(-Infinity);
          for (const q of vecs) {
            for (let i2 = 0; i2 < emb.slugs.length; i2++) {
              const v = emb.vectors[i2];
              let dot = 0;
              for (let k = 0; k < v.length; k++) dot += q[k] * v[k];
              if (dot > best[i2]) best[i2] = dot;
            }
          }
          denseRanked = emb.slugs
            .map((s, i2) => [s, best[i2]])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
        // !serverRanked matters. When the SERVER did the matching, vecs is empty by design because
        // nothing was embedded locally, and without this guard that emptiness read as failure: every
        // server-answered turn carried "semantic recall is OFF" while simultaneously delivering
        // memories tagged [both], which only the server produces. Caught 2026-08-22 by reading the
        // hook's own output in a live turn. A false degradation warning is worse than none: it tells
        // the agent not to trust recall that is in fact working perfectly.
        } else if (!vec && !hasArabic && !serverRanked) {
          denseNote = "NOTE: semantic recall is OFF (embed server not running). Keyword only, so a paraphrase may not match. Start it: node tools/embed-server.mjs";
        }

        // The embed call already told us the server's index version, for free. If it has moved on,
        // start the repair in the background and carry on answering with what we have. The next
        // turn gets the fresh index. Nothing here blocks and nothing here can fail loudly.
        const refreshing = repairIndexInBackground(LAST_SERVER_V, BRAIN);
        if (refreshing === 'refreshing') {
          denseNote = (denseNote ? denseNote + ' ' : '')
            + 'NOTE: this machine index was behind the server and is refreshing in the background. '
            + 'The memories below came from the older copy; ask again if something looks missing.';
        }
      }
    } catch { denseNote = "NOTE: semantic recall is OFF (embeddings index unreadable). Keyword only."; }
    // Recall reads the FULL prompt, not the 2000-char head used for the tier decision.
        //
        // Reusing  here silently destroyed recall for any prompt where the question came
        // after a paste. Verified: "how do i log creatine" preceded by 4000 characters of filler
        // returned NOTHING, while the same question first returned the right memory at rank 1.
        // the owner pastes logs, emails and bank messages constantly, so this was not a rare shape.
        // Capped well above any real prompt purely so a pathological paste cannot dominate.
        const words = new Set(qterms(prompt.slice(0, 20000).toLowerCase()));
    const score = new Map();
    for (const w of words) {
      const slugs = idx ? idx.terms[w] : null;
      if (!slugs) continue;
      const weight = 1 / slugs.length; // rarer term, stronger signal
      for (const s of slugs) score.set(s, (score.get(s) || 0) + weight);
    }
    // 0.10 measured, not chosen, and RE-measured after the tokenizer changed.
    // tools/eval-recall.mjs sweep on 2026-08-18, current corpus: 0.34 and 0.33 both score
    // 85.0%, 0.10 scores 87.5%, 0.05 stays 87.5%. An earlier version of this comment quoted
    // 75.0% and 77.5% and claimed the curve was flat below 0.33. Those numbers were taken
    // BEFORE the tokenizer fixes (2-char minimum, stemming, no DF cap) and were never
    // re-run when the threshold moved, so the comment was justifying the value with evidence
    // that no longer existed. Re-run the sweep whenever the tokenizer or the corpus changes.
    // Biased toward recall: a false positive costs one line the agent may ignore, a false
    // negative is answering from stale memory while the brain held the answer.
    const sparseRanked = [...score.entries()]
      .filter(([, v]) => v >= Number(process.env.RECALL_MIN || 0.10))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    // Reciprocal rank fusion at equal weight. A sweep of 1:1, 1:2, 1:3, 2:1 and 3:1 over the
    // 40-query eval was flat at 92.5%, except 3:1 which dropped to 90.0%, so weighting buys
    // nothing here and equal is the honest default.
    const RRF_K = 60;
    const fused = new Map();
    sparseRanked.forEach(([slug], r) => fused.set(slug, (fused.get(slug) || 0) + 1 / (RRF_K + r + 1)));
    denseRanked.forEach(([slug], r) => fused.set(slug, (fused.get(slug) || 0) + 1 / (RRF_K + r + 1)));
    const localRanked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    // ONE SHAPE for both paths, so everything below is blind to who did the matching. The server
    // already returns the channel tag and the description, because it did the fusion that knows
    // them; locally they are derived from the two channel sets.
    const bySparse = new Set(sparseRanked.map(([s]) => s));
    const byDense = new Set(denseRanked.map(([s]) => s));
    const hits = serverRanked
      ? serverRanked.filter((m) => m && m.slug).map((m) => ({
        slug: m.slug, how: m.how || 'both', description: m.description || '',
      }))
      : localRanked.map(([slug]) => ({
        slug,
        how: bySparse.has(slug) && byDense.has(slug) ? 'both' : byDense.has(slug) ? 'meaning' : 'keyword',
        description: (idx && idx.descriptions[slug]) || '',
      }));
    // RESULTS ALERTS, from tools/analytics.mjs on its five minute timer.
    //
    // A scheduled task cannot push to a phone, and a session may not be open. The one channel
    // that reaches the owner regardless is this injection, on the next prompt, on ANY machine. Only
    // alerts first seen in the last six hours are shown, so a resolved or ageing condition does
    // not nag every prompt for a day. The analyzer clears an alert when its condition clears.
    try {
      const al = JSON.parse(readFileSync(join(BRAIN, '.brain-alerts.json'), 'utf8')).alerts || {};
      const cutoff = Date.now() - 6 * 3600 * 1000;
      const live = Object.values(al).filter((a) => a && Date.parse(a.firstSeen) > cutoff);
      if (live.length) {
        // The owner, 2026-09-05: 'no need for the alert to reach me as long as we have the data, you
        // can put limits to their number and you can keep an eye on them.' So this is for the
        // AGENT, not for him: look, act if it is yours to act on, and only raise it with him when
        // it changes what he would do. Capped so a bad hour cannot bloat every prompt.
        const shown = live.slice(0, 3);
        out.push('', 'BRAIN RESULTS, ' + live.length + ' condition(s) flagged by the analyzer. For YOU to keep an eye on: check, act if it is yours, and do NOT raise it with the owner unless it changes what he would do.');
        for (const a of shown) out.push('  ' + a.text + '   (since ' + String(a.firstSeen).slice(11, 16) + ' UTC)');
        if (live.length > shown.length) out.push('  and ' + (live.length - shown.length) + ' more in .brain-alerts.json');
      }
    } catch { /* no alerts file, nothing to say */ }

    if (denseNote && !hits.length) out.push("", denseNote);
    if (hits.length) {
      // Full absolute paths, not a `memory/<slug>.md` template.
      //
      // Naming a file is not the same as making it easy to open. With a template the agent has
      // to reconstruct the path before it can read anything, and the cheapest way to resolve
      // that friction is to answer from the one-line description instead. That is precisely the
      // failure this hook exists to prevent: a description says whether a file is worth opening,
      // never what it says. A ready-to-paste path makes reading the lazy option.
      const memPath = (slug) => join(BRAIN, 'memory', slug + '.md').replace(/\\/g, '/');
      out.push(
        '',
        `BRAIN RECALL: ${hits.length} memories match this prompt. You have NOT read them.`,
        'The one-line description only tells you whether a file is worth opening. It never tells',
        'you what the file says, and answering from it is how a half-remembered fact gets stated',
        'as current. Open the relevant ones BEFORE you answer, not after: Read the path shown,',
        'or run the command shown if this machine has no local copy.',
        'Matched by keyword and by meaning, so judge relevance yourself and skip any that do not apply.',
        ...(denseNote ? [denseNote] : []),
        '',
      );
      // Tag each hit with the channel that found it.
      //
      // a laptop client, 2026-08-22, during the first live test of remote embedding: "I see five
      // matched memories per turn and no indication of which mode found them", so it could not
      // tell a semantic hit from a keyword one and neither could anyone else. The information
      // exists right up until fusion and was thrown away.
      //
      // Worth surfacing permanently, not just for the test. A hit marked "meaning" is one the
      // keyword channel MISSED, which is the only direct evidence that the 434MB model earns its
      // place. When that tag stops appearing, the dense channel has quietly stopped contributing.
      // The tag is computed where the fusion happened, which is now either here or on the server.
      for (const h of hits) {
        out.push(`- [${h.how}] ${h.slug}: ${h.description}`);
        // A path that does not resolve is WORSE than no path. The agent tries to open it, gets
        // nothing, and the cheapest remaining move is to answer from the one-line description,
        // which is the single failure this whole hook exists to prevent. the client company already has
        // a stale memory/ and gets recalled slugs whose files are not on that disk. So when the
        // local file is missing, name the command that fetches the body from the server.
        const p = memPath(h.slug);
        out.push(existsSync(p)
          ? `  ${p}`
          : `  node tools/brain-client.mjs read ${h.slug}   (no local copy, fetch it from the server)`);
      }
    }
  }

  ok(out.join('\n'));
} catch (e) {
  // Failing silent here was wrong, and it is the worst failure this file can have.
  //
  // Everywhere else in the watcher, silence is the safe default. Not here. If this throws, the
  // agent loses EVERY behaviour rule for that turn and nothing anywhere says so: it just starts
  // writing long, claiming things are done, and telling the owner the problem is his end, exactly the
  // behaviours these rules exist to stop. Indistinguishable from the rules being wrong.
  //
  // So say so, in the injection itself, where the agent will read it. One line, still cannot
  // block the turn.
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'BRAIN RULES FAILED TO LOAD (' + String(e && e.message).slice(0, 120) + '). You are '
          + 'running with NO behaviour rules and no recall this turn. Tell the owner before answering, '
          + 'and keep replies short and honest from memory. Fix: node tools/build-index.mjs in '
          + 'the brain, then check hooks/pre-turn.mjs.',
      },
    }));
  } catch { /* stdout itself is gone, nothing left to do */ }
  process.exit(0);
}
