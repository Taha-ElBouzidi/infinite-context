// The live brain server. Serves memories, recall and the vault to any agent, on any machine.
//
// The owner, 2026-08-19: the vault passphrase and the embedding runtime "need to be shared always
// live across all machines", served from this desktop, with the git copy kept as backup. He
// plans to format this box into a proper server later; this is the version that runs today.
//
// WHY THIS EXISTS ALONGSIDE GIT, NOT INSTEAD OF IT
// git gives every machine a full offline replica, which is the better property and stays. What
// git cannot do is share the two things deliberately kept OUT of the repo: the vault passphrase
// and node_modules. Copying the passphrase by hand works once and then rots the moment it is
// rotated. This serves it live instead, so rotation propagates immediately.
//
// SECURITY, because this can be exposed to the internet through a tunnel:
//   - Bearer token on every route except /health. No token, no answer, no exceptions.
//   - The token is generated here, stored outside the repo, and never logged.
//   - Binds to 127.0.0.1 by default. Going public is an explicit --public flag, so nobody
//     exposes the vault by accident.
//   - Constant-time token comparison, so a wrong token cannot be found by timing.
//   - Every secret read is logged with a timestamp and the caller, never the value.
//   - Rate limited. A vault endpoint is the single most attackable thing here.
//
// Routes:
//   GET  /health                     no auth, liveness only, reveals nothing
//   GET  /vault/list                 names and dates, never values
//   GET  /vault/get/:name            one secret value
//   GET  /vault/passphrase           the passphrase itself, so a new machine can bootstrap
//   POST /embed        {text}        vector for semantic recall
//   GET  /memory/:slug               one memory file
//   GET  /rules                      the always-on rules
//
// Run:  node tools/brain-server.mjs            local only
//       node tools/brain-server.mjs --public   bind 0.0.0.0, for use behind a tunnel

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
// The SAME tokenizer the hook uses, imported rather than reimplemented. Two copies of a tokenizer
// is two sparse rankings that agree until the day someone edits one of them.
import { terms as qterms } from './tokenize.mjs';
import { watchTailnet } from './tailnet-watch.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HAVOK_SERVER_PORT || 8478);
const PUBLIC = process.argv.includes('--public');
// WHERE THIS PROCESS KEEPS ITS PRIVATE FILES.
//
// Normally the user profile. But the brain server is started AT BOOT as SYSTEM so it comes back
// after a reboot without waiting for the owner to log in, and SYSTEM's profile is
// C:/Windows/System32/config/systemprofile, where none of these files exist. Without this the
// server would boot, find no token and no age key, and serve nothing while looking healthy.
//
// HAVOK_HOME is inherited by child processes, so brain-server passing it once reaches vault.mjs
// automatically when it shells out to decrypt a secret.
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');

const TOKEN_FILE = resolve(CONFIG_DIR, 'havok-server-token');
const ACCESS_LOG = join(BRAIN, '.server-access.log');

// TLS-ONLY BY DEFAULT once a certificate exists.
//
// Plain HTTP was the whole exposure: every client sent its bearer token across the WiFi in the
// clear, and that token unlocks the entire vault. Keeping the plaintext port open "just during
// migration" is how a temporary hole becomes a permanent one, because the machine that has not
// migrated is exactly the machine nobody is looking at.
//
// A machine that cannot reach TLS is NOT left brainless: it keeps its local clone and its keyword
// index and degrades to keyword-only recall, which is what it had before any of this existed, and
// it heals completely with one git pull. That is a far smaller cost than an indefinitely burned
// credential, so plaintext now requires an explicit --allow-plaintext.
const TLS_KEY = resolve(CONFIG_DIR, 'havok-server-key.pem');
const TLS_CERT = resolve(CONFIG_DIR, 'havok-server-cert.pem');
const HAVE_TLS = existsSync(TLS_KEY) && existsSync(TLS_CERT);
const ALLOW_PLAINTEXT = process.argv.includes('--allow-plaintext') || !HAVE_TLS;

// Token, generated once and reused. Printed only on creation, never on startup, so it cannot
// be scraped from a log or a screen share later.
let TOKEN;
if (existsSync(TOKEN_FILE)) {
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
} else {
  TOKEN = randomBytes(32).toString('base64url');
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
  // Written to the token FILE, never printed. The first run logged the token into .server.log,
  // where it sat in plaintext next to the vault it protects. Printing a credential to stdout
  // means it lands in whatever captures stdout: a log file, a scrollback buffer, a screen share.
  process.stdout.write("New server token written to " + TOKEN_FILE + ". Read that file to copy it to your other machines." + String.fromCharCode(10));
}

// Constant time, so an attacker cannot recover the token one byte at a time by measuring how
// long the comparison takes.
// SCOPED TOKENS. A token now says what it may DO, not merely that it is valid.
//
// The problem this fixes, found 2026-08-24: /vault/get authenticated on the SHARED bearer token
// and never checked WHICH machine was asking, so any machine holding it could read every secret
// the owner owns. Moving the age keys to the server did not reduce that, it only changed the route: a
// laptop with the token and a live tailnet session still had the whole vault.
//
// It also left no middle setting. 'Can do recall' and 'can read every credential' were the same
// permission, so a company laptop could not be given recall without being given the vault.
//
//   full    everything, including /vault/*. The server's own token.
//   recall  /recall, /embed, /rules, /index/*, /memory/*. Refused on /vault/* with a 403.
//
// Extra tokens live in havok-tokens.json under CONFIG_DIR, server side only, never in git. The
// original havok-server-token still works and counts as full, so nothing breaks on upgrade.
const TOKENS_FILE = resolve(CONFIG_DIR, 'havok-tokens.json');
function loadTokens() {
  try { return JSON.parse(readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
// READ ON EVERY AUTH, not once at boot. This was `let EXTRA_TOKENS = loadTokens()` and it made
// `token.mjs revoke` a lie: the name disappeared from the file and the token kept working until the
// server happened to restart. A revoke that needs a reboot to take effect is not a revoke, and the
// machine this matters for is the locked-down client machine, which the owner does not own and cannot wipe.
// Issuing had the same bug from the other side: a new machine's token got 401 until a restart, which
// reads as "the brain is down".
// The file is a few hundred bytes and sits in the page cache; measured cost is under 0.1ms against a
// ~70ms recall, so there is no reason to cache it and risk a stale-copy bug in the auth path.
const EXTRA_TOKENS_NOW = () => loadTokens();

// Constant time, so a token cannot be recovered one byte at a time by timing. Every candidate is
// compared and the loop does not break early, so the work done does not leak which one matched.
function constEq(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

// null when unknown, otherwise { name, scope }.
function authOf(header) {
  const given = String(header || '').replace(/^Bearer\s+/i, '');
  if (!given) return null;
  let found = null;
  if (constEq(given, TOKEN)) found = { name: 'SERVER', scope: 'full' };
  for (const [tok, meta] of Object.entries(EXTRA_TOKENS_NOW())) {
    if (constEq(given, tok)) found = { name: meta.name || 'unnamed', scope: meta.scope || 'recall' };
  }
  return found;
}

// Slugs the write path accepts and reindexes normally but never commits. See the write handler.
const EPHEMERAL_SLUG = /^reference_stress_/;

// Rate limit. A vault endpoint reachable from the internet is the most attackable surface in
// this whole system, and a slow brute force is exactly what this stops.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = hits.get(ip) || [];
  const recent = win.filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 120;
}

// THE BACKGROUND SAVE QUEUE for POST /memory. One run at a time, and every write that arrives while a
// run is going is folded into the next one: five memories written together cost one reindex and one
// commit, not five. Async execFile, so the server keeps answering recall while git and the indexer
// work. Push failure is still not a write failure (the memory is live on this disk, git is the
// backup), and the reason is still audited, because the pre-commit gate refusing a write is
// information someone needs.
const saveQueue = new Map();
let saveRunning = false;
const runAsync = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd: BRAIN, timeout, windowsHide: true, maxBuffer: 16 << 20 }, (e, stdout, stderr) => (
    e ? reject(Object.assign(e, { stdout, stderr })) : resolve(stdout)));
});
function queueBrainSave(slug, existed, callerName, ip) {
  const prev = saveQueue.get(slug);
  saveQueue.set(slug, { existed: prev ? prev.existed : existed, callerName, ip });
  if (!saveRunning) drainBrainSaves();
}
async function drainBrainSaves() {
  saveRunning = true;
  try {
    while (saveQueue.size) {
      const batch = [...saveQueue.entries()];
      saveQueue.clear();
      try { await runAsync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 120000); }
      catch (e) { audit('INDEX-FAIL ' + String(e.message).slice(0, 120)); }
      // Test probes do not belong in the brain's permanent history (tools/stress-test.mjs writes
      // five at once). Written and reindexed like any other, never committed.
      const keep = batch.filter(([s]) => !EPHEMERAL_SLUG.test(s));
      for (const [s, m] of batch) if (EPHEMERAL_SLUG.test(s)) audit('MEMORY-WRITE ' + m.ip + ' ' + m.callerName + ' ' + s + ' PUSH-FAILED: ephemeral test slug, deliberately not committed');
      if (!keep.length) continue;
      let pushError = null;
      try {
        await runAsync('git', ['-C', BRAIN, 'add', 'memory/', 'index/', 'MANIFEST.md'], 30000);
        const who = [...new Set(keep.map(([, m]) => m.callerName))].join(', ');
        const message = keep.length === 1
          ? (keep[0][1].existed ? 'memory: update ' : 'memory: ') + keep[0][0] + ' (via ' + who + ')'
          : 'memory: ' + keep.map(([s]) => s).join(', ') + ' (via ' + who + ')';
        await runAsync('git', ['-C', BRAIN, 'commit', '-m', message], 180000);
        await runAsync('git', ['-C', BRAIN, 'push', '-q', 'origin', 'HEAD'], 120000);
      } catch (ge) {
        const msg = String((ge && (ge.stderr || ge.stdout || ge.message)) || '');
        pushError = /VERIFY FAILED/i.test(msg) ? 'the pre-commit gate refused it: run node tools/verify.mjs'
          : /nothing to commit/i.test(msg) ? 'nothing to commit (content identical)'
            : msg.replace(/\s+/g, ' ').slice(0, 160) || 'git failed with no output';
      }
      for (const [s, m] of keep) audit('MEMORY-WRITE ' + m.ip + ' ' + m.callerName + ' ' + s + (m.existed ? ' update' : ' new') + (pushError ? ' PUSH-FAILED: ' + pushError : ''));
    }
  } finally { saveRunning = false; }
}

function audit(line) {
  try { appendFileSync(ACCESS_LOG, new Date().toISOString() + ' ' + line + '\n'); } catch { /* logging must not break serving */ }
}

// One cheap number that changes whenever anything a machine caches changes.
//
// Hashing 500KB on every request would be silly, so it is recomputed only when a file's size or
// mtime moves. That is enough: the index files are written by build-index.mjs, never edited in
// place by hand, so an mtime change is a real change.
//
// Deliberately NOT the git commit hash. A machine can be at the right commit and still have a
// stale generated index, because index/ is derived from memory/ and regenerating it is a separate
// step. The content is what matters, so the content is what is hashed.
const INDEX_FILES = ['keywords.json', 'embeddings.json', 'rules.json', 'contact.md', 'feedback.md', 'project.md', 'reference.md', 'user.md', 'translate-system.txt'];
let versionCache = null;
function indexVersion() {
  // Hash CONTENT, not size and mtime.
  //
  // The first version of this hashed size+mtime, which was wrong in a way that would have broken
  // the whole point: mtime is machine-local, so a client could never compute the same value for
  // identical content and therefore could never tell whether its own copy was current. The
  // comparison has to be possible on both ends or there is no way to detect divergence.
  //
  // mtime still earns its keep as a CACHE KEY: hashing 500KB costs a few milliseconds, so it is
  // done only when a file actually changes on disk. The published number is pure content.
  const stat = [];
  for (const name of INDEX_FILES) {
    const f = join(BRAIN, 'index', name);
    try { const st = statSync(f); stat.push(name + ':' + st.size + ':' + Math.floor(st.mtimeMs)); } catch { /* absent */ }
  }
  const key = stat.join('|');
  if (versionCache && versionCache.key === key) return versionCache.payload;

  const files = {};
  const whole = createHash('sha256');
  for (const name of INDEX_FILES) {
    const f = join(BRAIN, 'index', name);
    let buf = null;
    try { buf = readFileSync(f); } catch { continue; }
    const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    files[name] = { bytes: buf.length, sha };
    whole.update(name + ':' + sha + '|');
  }
  const payload = {
    version: whole.digest('hex').slice(0, 16),
    files,
    memories: (() => {
      try { return readdirSync(join(BRAIN, 'memory')).filter((f) => f.endsWith('.md')).length; } catch { return 0; }
    })(),
  };
  versionCache = { key, payload };
  return payload;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// The embed model is loaded lazily and once. Loading it at startup would make the server take
// 70 seconds to answer /health, and most requests never touch it.
let embedFn = null;
async function getEmbedder() {
  if (embedFn) return embedFn;
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowLocalModels = false;
  embedFn = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedFn;
}

// ---- SERVER-SIDE RECALL -----------------------------------------------------------------
//
// The owner, 2026-08-22: "the brain is on the server twenty four seven, and every other agent has to
// access the brain, and they go through the server."
//
// Matching moved here from the machines. Measured BEFORE moving it, so this is a result and not
// a hope: matching all 129 memories costs 0.164ms, and returning the ANSWER (1.0KB of names and
// descriptions) is EIGHT TIMES SMALLER than returning the raw vector a machine needed in order to
// match for itself (8.0KB). Faster and lighter than what it replaces.
//
// The real reason is not speed. If no machine holds an index, no machine's index can be stale or
// half built. The six-memories-with-no-vector bug found this morning becomes structurally
// impossible rather than something an agent has to remember to prevent.
//
// PRIVACY CHANGE, stated plainly because it reverses a property the brain used to advertise: the
// server now DOES learn which memories matched, because it is the thing doing the matching. It
// previously could not. The audit line below therefore records counts only, never the prompt text
// and never the memory names.
let idxCache = null;
function loadIndexes() {
  const v = indexVersion();
  if (idxCache && idxCache.v === v.version) return idxCache;
  idxCache = {
    v: v.version,
    kw: JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8')),
    emb: JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8')),
  };
  return idxCache;
}

// Every constant here is measured, and the measurements live in hooks/pre-turn.mjs next to the
// original. Changing one without re-running tools/eval-recall.mjs is how a tuned system silently
// detunes itself.
const RRF_K = 60;
const SPARSE_MIN = Number(process.env.RECALL_MIN || 0.10);
const PER_CHANNEL = 20;

async function recall(prompt, queries, limit, bodyChars = 0) {
  const { kw, emb } = loadIndexes();
  let qEmb = null;
  try { qEmb = JSON.parse(readFileSync(join(BRAIN, 'index', 'question-embeddings.json'), 'utf8')); }
  catch { /* no questions written yet, which is the state every brain starts in */ }

  // DENSE, max-pooled across chunks rather than averaged. Taking the best chunk is the entire
  // point; a mean reintroduces exactly the dilution that chunking was added to remove.
  const e = await getEmbedder();
  const best = new Float64Array(emb.slugs.length).fill(-Infinity);
  const queryVectors = [];
  let embedded = 0;
  for (const q of queries) {
    const o = await e(String(q).slice(0, 4000), { pooling: 'mean', normalize: true });
    const qv = o.data;
    queryVectors.push(qv);
    embedded++;
    for (let i = 0; i < emb.slugs.length; i++) {
      const v = emb.vectors[i];
      let dot = 0;
      for (let k = 0; k < v.length; k++) dot += qv[k] * v[k];
      if (dot > best[i]) best[i] = dot;
    }
  }
  /* THE QUESTIONS A MEMORY ANSWERS ARE SCORED BESIDE ITS DESCRIPTION, and a memory keeps the better
     of the two. Measured 2026-09-21: "I need to know who did what action" scores 0.144 against the
     description of the memory that answers it and 0.523 against the question itself; "stop writing
     so much" 0.216 against 0.622. A description says what a memory is about, which is not what
     anyone types. Max, never a mean: averaging the two is the dilution this exists to remove.
     The file is optional, so a brain with no questions written behaves exactly as before. */
  const qBest = new Map();
  if (qEmb && qEmb.vectors && qEmb.vectors.length) {
    // The query vectors are already computed above. Embedding each query a second time here cost a
    // measured 42 ms a prompt for an identical vector, which is the kind of waste that looks like
    // the feature being expensive.
    for (const qv of queryVectors) {
      for (let i = 0; i < qEmb.vectors.length; i++) {
        const v = qEmb.vectors[i];
        let dot = 0;
        for (let k = 0; k < v.length; k++) dot += qv[k] * v[k];
        const slug = qEmb.slugs[i];
        if (dot > (qBest.get(slug) ?? -Infinity)) qBest.set(slug, dot);
      }
    }
  }
  const denseRanked = embedded
    ? emb.slugs.map((s, i) => [s, Math.max(best[i], qBest.get(s) ?? -Infinity)])
      .sort((a, b) => b[1] - a[1]).slice(0, PER_CHANNEL)
    : [];

  // SPARSE reads the FULL prompt, capped, never a head slice. The hook learned this the hard way:
  // reusing a 2000-char head returned NOTHING for "how do i log creatine" when 4000 characters of
  // pasted filler came first, and the owner pastes logs and bank messages constantly.
  const words = new Set(qterms(String(prompt).slice(0, 20000).toLowerCase()));
  const score = new Map();
  for (const w of words) {
    const slugs = kw.terms[w];
    if (!slugs) continue;
    const weight = 1 / slugs.length; // rarer term, stronger signal
    for (const s of slugs) score.set(s, (score.get(s) || 0) + weight);
  }
  const sparseRanked = [...score.entries()]
    .filter(([, v]) => v >= SPARSE_MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, PER_CHANNEL);

  const fused = new Map();
  sparseRanked.forEach(([s], r) => fused.set(s, (fused.get(s) || 0) + 1 / (RRF_K + r + 1)));
  denseRanked.forEach(([s], r) => fused.set(s, (fused.get(s) || 0) + 1 / (RRF_K + r + 1)));

  const bySparse = new Set(sparseRanked.map(([s]) => s));
  const byDense = new Set(denseRanked.map(([s]) => s));
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([slug]) => {
      const hit = {
        slug,
        how: bySparse.has(slug) && byDense.has(slug) ? 'both' : byDense.has(slug) ? 'meaning' : 'keyword',
        description: kw.descriptions[slug] || '',
      };
      /* THE BODY TRAVELS WITH THE HIT WHEN THE CALLER ASKS. The owner, 2026-09-21: "local recall, and
         local brain copy is not an option." With no copy anywhere, a machine that gets slugs and
         descriptions has to ask again for the thing it actually needs, 216 ms per memory measured,
         and an agent under time pressure answers from the description instead. That is the single
         failure the recall system exists to prevent, so the body comes down with the ranking.
         Frontmatter is stripped: name and description are already in the hit, and repeating them
         would spend a fifth of the budget saying what was just said. */
      if (bodyChars > 0) {
        try {
          const raw = readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8').replace(/\r\n/g, '\n');
          const afterFm = raw.startsWith('---') ? raw.slice(Math.max(raw.indexOf('\n---', 3) + 4, 0)) : raw;
          const body = afterFm.trim();
          hit.chars = body.length;
          hit.body = body.slice(0, bodyChars);
          hit.truncated = body.length > bodyChars;
        } catch { /* a hit whose file vanished mid-request is still a useful slug */ }
      }
      return hit;
    });
}

const handler = async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  // Liveness is deliberately unauthenticated and deliberately empty: a tunnel health check
  // needs it, and it must reveal nothing about what is behind the door.
  if (path === '/health') return json(res, 200, { ok: true });

  // ONE-SHOT TOKEN BOOTSTRAP, bound to a tailnet address.
  //
  // The chicken and egg: a new machine needs a token to talk to the server, and the only safe way
  // to hand it one is over a channel that is already authenticated. Taildrop was meant to be that
  // channel and failed on the the client company link 2026-08-24: six empty 'tailscale file get' calls,
  // 'server is not replying', reachable only via a Paris DERP relay with no direct path, and
  // tailscaled unable to reach the coordination server. Its HTTPS requests arrived here perfectly
  // throughout, which is the whole point: the data path worked while the file path did not.
  //
  // WHY THE SOURCE IP IS A REAL IDENTITY HERE, which it would never be on a normal network:
  // a 100.64.0.0/10 address on a tailnet is cryptographically bound to a WireGuard node key. It
  // cannot be spoofed by anything that is not already in the tailnet, and the server only listens
  // on loopback and its own tailnet address, so nothing off the tailnet can even open the socket.
  //
  // STILL DELIBERATELY NARROW, because this route hands out a credential without a credential:
  //   armed by hand, per machine, with the exact IP   (node tools/token.mjs arm NAME --ip X)
  //   ONE SHOT, the arm is consumed on first success
  //   only ever returns a token that already exists for that name
  //   every attempt is logged, hit or miss
  if (path.startsWith('/bootstrap/')) {
    const want = decodeURIComponent(path.slice('/bootstrap/'.length));
    const from = String(ip).replace(/^::ffff:/, '');
    let armed = {};
    try { armed = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'havok-bootstrap.json'), 'utf8')); } catch { /* nothing armed */ }
    const entry = armed[want];
    if (!entry || entry.ip !== from) {
      audit('BOOTSTRAP-REFUSED ' + from + ' wanted=' + want + (entry ? ' armed-for=' + entry.ip : ' not-armed'));
      return json(res, 403, { error: 'not armed', detail: 'ask the owner to arm this machine: node tools/token.mjs arm <NAME> --ip <your tailnet ip>' });
    }
    // Same reason as authOf: reading the boot-time snapshot here meant issue, then arm, then collect
    // returned "no token issued" for a token plainly present on disk, until a restart.
    const hit = Object.entries(EXTRA_TOKENS_NOW()).find(([, m]) => m.name === want);
    if (!hit) {
      audit('BOOTSTRAP-NOTOKEN ' + from + ' ' + want);
      return json(res, 404, { error: 'no token issued for ' + want });
    }
    // Consume the arm BEFORE replying. If the write fails we would rather refuse a legitimate
    // retry than leave the route open, so this is deliberately not best-effort.
    try {
      delete armed[want];
      writeFileSync(resolve(CONFIG_DIR, 'havok-bootstrap.json'), JSON.stringify(armed, null, 2), 'utf8');
    } catch (e) {
      audit('BOOTSTRAP-ARMFAIL ' + from + ' ' + want);
      return json(res, 500, { error: 'could not consume the arm, refusing to hand out a token' });
    }
    audit('BOOTSTRAP-OK ' + from + ' ' + want + ' scope=' + hit[1].scope);
    return json(res, 200, { name: want, scope: hit[1].scope, token: hit[0] });
  }

  if (rateLimited(ip)) {
    audit('RATE-LIMITED ' + ip);
    return json(res, 429, { error: 'too many requests' });
  }
    const caller = authOf(req.headers.authorization);
    if (!caller) {
      audit('DENIED ' + ip + ' ' + path);
      return json(res, 401, { error: 'unauthorized' });
    }
    // A recall token on a vault route is 403, not 401. The credential is real, it simply is not
    // allowed here, and saying so plainly stops an agent burning ten minutes deciding its token
    // expired. Logged with the token NAME so it is obvious which machine reached for the vault.
    if (path.startsWith('/vault/') && caller.scope !== 'full') {
      audit('REFUSED-SCOPE ' + ip + ' ' + caller.name + ' scope=' + caller.scope + ' ' + path);
      return json(res, 403, { error: 'forbidden',
        detail: 'this token has scope "' + caller.scope + '" and cannot read the vault. Ask The owner, do not retry.' });
    }

  try {
    if (path === '/vault/list') {
      const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
      const out = Object.entries(v.secrets || {}).map(([name, s]) => ({ name, updated: s.updated, note: s.note || '' }));
      audit('list ' + ip);
      return json(res, 200, { secrets: out });
    }

    if (path.startsWith('/vault/get/')) {
      // basename() so a crafted name cannot escape into another file.
      const name = basename(decodeURIComponent(path.slice('/vault/get/'.length)));
      // A secret that does not exist is a 404, not a 500.
      //
      // vault.mjs exits non-zero for an unknown name, execFileSync throws, and the outer
      // handler turned that into a 500. a laptop client read that 500 on 2026-09-05 as "retrieval is
      // broken on this machine" and could not tell it apart from a real fault, because a 500
      // says the server broke while the truth was that the caller asked for a name that is not
      // there. A 404 that names the fix cannot be misread that way.
      let value;
      try {
        value = execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'get', name],
          { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        audit('SECRET-MISS ' + name + ' by ' + ip);
        return json(res, 404, {
          error: 'no such secret',
          detail: 'the vault has no secret named "' + name + '". This is NOT a permission problem'
            + ' and NOT the server being broken. Run: node tools/brain-client.mjs list',
        });
      }
      audit('READ SECRET ' + name + ' by ' + ip);
      return json(res, 200, { name, value });
    }

    // RETIRED 2026-08-21 by the move to per-machine age keys. This used to hand the shared vault
    // passphrase to any caller with the bearer token, which meant one stolen token equalled every
    // credential the owner owns, forever, on every machine.
    //
    // There is no shared secret to serve any more. A new machine generates its own keypair, keeps
    // the private half, and publishes only the public half. Nothing sensitive crosses the network,
    // so this route cannot be re-added without reintroducing the flaw.
    if (path === '/vault/passphrase') {
      audit('REFUSED retired /vault/passphrase from ' + ip);
      return json(res, 410, {
        error: 'retired: the vault no longer has a shared passphrase',
        do: 'on the new machine run: node tools/vault.mjs machine-init, then send the PUBLIC key here and run: node tools/vault.mjs machine-add <NAME> <key> && node tools/vault.mjs grant --all --to <NAME>',
      });
    }

    // ---- /dist : serve the code and the certificate to machines with no GitHub -------------
    //
    // The owner, 2026-08-24: the locked-down client machine cannot reach GitHub, it is blocked on the corporate
    // WiFi. It reaches the brain server fine over Tailscale, so reads and writes work, but two
    // things still only came from the repo: server-cert.pem and the tools/hooks themselves. If the
    // certificate is ever regenerated that machine is locked out permanently, with no delivery
    // path left, because Taildrop is also dead on that link.
    //
    // ALLOWLIST, never an arbitrary path. This route reads files off disk and hands them to a
    // caller, so it is exactly the shape of a directory-traversal hole. Nothing is served unless
    // it is named here, and vault.json is deliberately absent: a recall-scoped machine has no
    // business holding the encrypted vault even though it could not decrypt it.
    if (path === '/dist' || path.startsWith('/dist/')) {
      // CODE ONLY. memory/ and index/ were published here for a few hours on 2026-09-04 and
      // withdrawn the same day. the owner: "can we have one continuous connection to the server, and
      // have one brain on the server, so that every recall goes from the server and every new
      // memory goes in the server, not on a copy that gets commited."
      //
      // He was right and the copy earned nothing. Recall already runs server-side and the
      // server's answer WINS over any local index (pre-turn.mjs, the serverRanked branch); the
      // local index is only a fallback, and repairIndexInBackground already refreshes it from
      // the server whenever the versions differ. Mirroring memory duplicated a mechanism that
      // already existed and brought three bugs with it: a sweep race, permanent git dirt, and a
      // pull that wedges on untracked files. Code is different: hooks and tools must be on disk
      // to execute, which is the whole reason this route exists.
      const allowed = () => {
        // The plugin manifests and .mcp.json travel too, since 2026-09-07: a mirror-only machine
        // installs the plugin from its local checkout, and claude plugin update compares versions,
        // so without these a version bump never reaches the one laptop that cannot use GitHub.
        const list = ['server-cert.pem', 'server-endpoint.json', 'CLAUDE.md', 'REFLEX.md',
          'METHODOLOGIES.md', 'GOVERNANCE.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.mcp.json',
          // The standing rules every agy sub-agent loads through ~/.gemini/GEMINI.md, on every
          // machine (2026-09-25). A .md in tools/ fails the extension filter below; a laptop client found it
          // never arrived. Named one by one so no other markdown in tools/ is published by accident.
          'tools/subagent-rules.md', 'tools/agent-rules.md'];
        for (const d of ['tools', 'hooks']) {
          let names = [];
          try { names = readdirSync(join(BRAIN, d)); } catch { continue; }
          for (const n of names) {
            if (/\.(mjs|json|ps1|cmd)$/.test(n)) list.push(d + '/' + n);
          }
        }
        return list;
      };

      // Serve the CANONICAL LF form, not what is on this disk.
      //
      // core.autocrlf is true on the host, so git checks out CRLF here while the repo stores LF.
      // Serving those bytes raw left every mirroring machine permanently dirty in git: 8 files in
      // tools/ differing from origin by line endings alone. Two consequences, the second serious.
      // A real local change would eventually hide in that permanent list, and a commit made in
      // that state pushes CRLF copies of the tools back and flips the repo's line endings, with
      // the pre-commit hook re-staging so nobody has to choose it. CRLF has broken frontmatter
      // parsing in this repo before. Found by a laptop client on 2026-09-04.
      //
      // Everything in the allowlist is text. Drop CR only where it precedes LF, so a lone CR in
      // content is left alone.
      const canonical = (buf) => {
        let n = 0;
        const o = Buffer.allocUnsafe(buf.length);
        for (let i = 0; i < buf.length; i += 1) {
          if (buf[i] === 13 && buf[i + 1] === 10) continue;
          o[n] = buf[i];
          n += 1;
        }
        return o.subarray(0, n);
      };

      // A cheap "has anything changed" probe. A machine polling every two minutes must not make
      // the server read and hash 1.7MB of memory and embeddings each time, so this stats only:
      // name, size, mtime. Cheap enough to call constantly, exact enough to never miss a write.
      if (path === '/dist/version') {
        const h = createHash('sha256');
        let n = 0;
        for (const rel of allowed().sort()) {
          try {
            const st = statSync(join(BRAIN, rel));
            h.update(rel + ':' + st.size + ':' + Math.floor(st.mtimeMs) + '|');
            n += 1;
          } catch { /* absent on this machine, skip */ }
        }
        return json(res, 200, { version: h.digest('hex').slice(0, 16), files: n });
      }

      if (path === '/dist') {
        const files = [];
        for (const rel of allowed()) {
          try {
            const buf = canonical(readFileSync(join(BRAIN, rel)));
            files.push({ path: rel, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex').slice(0, 16) });
          } catch { /* absent on this machine, skip */ }
        }
        audit('DIST-MANIFEST ' + ip + ' ' + caller.name + ' ' + files.length + ' files');
        return json(res, 200, { files });
      }

      const rel = decodeURIComponent(path.slice('/dist/'.length));
      if (!allowed().includes(rel)) {
        audit('DIST-REFUSED ' + ip + ' ' + caller.name + ' ' + rel);
        return json(res, 403, { error: 'not served', detail: 'only files listed by GET /dist are available' });
      }
      // Belt and braces on top of the allowlist: resolve and confirm it is still inside BRAIN.
      const abs = resolve(BRAIN, rel);
      if (!abs.startsWith(resolve(BRAIN))) {
        audit('DIST-TRAVERSAL ' + ip + ' ' + caller.name + ' ' + rel);
        return json(res, 400, { error: 'bad path' });
      }
      try {
        const buf = canonical(readFileSync(abs));
        audit('DIST ' + ip + ' ' + caller.name + ' ' + rel + ' ' + buf.length + 'b');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(buf);
      } catch {
        return json(res, 404, { error: 'not found on the server' });
      }
    }

    if (path === '/rules') {
      return json(res, 200, JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')));
    }

    // ── SERVER AS SOURCE OF TRUTH ────────────────────────────────────────────────────────────
    //
    // The owner, 2026-08-22: "make the brain on this machine, and github only a copy backup, so later
    // when this solution is perfected we can get a VPS and host it there."
    //
    // The VPS endgame is what makes this coherent: build it server-authoritative now and moving
    // to a VPS is a URL change, not a redesign.
    //
    // THE PROBLEM THIS SOLVES, and it is a real one: a machine's clone can silently fall behind.
    // This brain has had a plugin copy 204 commits behind and a cache copy holding 32 memories
    // against 128. Nothing detected either; they were found by accident.
    //
    // THE PROBLEM IT MUST NOT CREATE: a machine reads about 500KB of index on every single turn.
    // Fetching that per turn over the network would be far worse than a stale clone. So machines
    // keep a CACHE and revalidate it against a version stamp, and the stamp is cheap enough to
    // check constantly.
    if (path === '/index/version') {
      return json(res, 200, indexVersion());
    }

    if (path.startsWith('/index/')) {
      // basename() so a crafted name cannot walk out of index/.
      const name = basename(decodeURIComponent(path.slice('/index/'.length)));
      const f = join(BRAIN, 'index', name);
      if (!existsSync(f)) return json(res, 404, { error: 'no such index file' });
      const body = readFileSync(f);
      res.writeHead(200, {
        'content-type': name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8',
        'content-length': body.length,
        // The version this file belongs to, so a client can tell a mid-update fetch from a clean one.
        'x-brain-version': indexVersion().version,
      });
      return res.end(body);
    }

    // GET, EXPLICITLY. Without the method check this matched a DELETE to the same path, answered
    // it with the memory's own content and a 200, and the delete route further down was never
    // reached. The client read that as "REFUSED: unknown" and nothing was removed.
    if (path.startsWith('/memory/') && req.method === 'GET') {
      const slug = basename(decodeURIComponent(path.slice('/memory/'.length))).replace(/\.md$/, '');
      const f = join(BRAIN, 'memory', slug + '.md');
      if (!existsSync(f)) return json(res, 404, { error: 'no such memory' });
      return json(res, 200, { slug, content: readFileSync(f, 'utf8') });
    }

    // ---- WRITE A MEMORY -------------------------------------------------------------------
    //
    // The owner, 2026-08-24: "why do we go through git, it is a backup of the server only. The reading
    // AND writing of the brain is on the server. The brain 100% on the server."
    //
    // Until now the server was read-only and every machine wrote by committing to its own clone and
    // pushing to GitHub. That worked, and the locked-down client machine proved it by landing 17 memories in
    // an hour. But it meant every machine needed push access to the repo that carries hooks/ and
    // tools/, which every other machine pulls and EXECUTES on every turn. A company laptop could
    // change code running on his personal desktop. Scoped tokens did nothing about that, because
    // the path went around the server entirely.
    //
    // Now a write is a request. The server validates it, writes it, reindexes, commits and pushes.
    // No machine needs git write access, so that can be locked down separately.
    //
    // VALIDATED BEFORE IT LANDS, not after. A bad write here reaches every machine on the next
    // pull, so the checks are deliberately strict and the refusals are specific enough to fix.
    if (path === '/memory' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 200_000) { req.destroy(); return; }
      }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const slug = String(body.slug || '').trim();
      const content = String(body.content || '');

      // Slug shape. No dots, no slashes, no traversal: this becomes a filename.
      if (!/^[a-z][a-z0-9_]{2,80}$/.test(slug)) {
        return json(res, 400, { error: 'bad slug', detail: 'lowercase letters, digits and underscores only, 3 to 81 chars. No dots or slashes.' });
      }
      const prefix = slug.split('_')[0];
      const TYPES = ['user', 'contact', 'project', 'feedback', 'reference'];
      if (!TYPES.includes(prefix)) {
        return json(res, 400, { error: 'bad prefix', detail: 'slug must start with one of: ' + TYPES.join(', ') });
      }
      if (content.length < 40) return json(res, 400, { error: 'too short', detail: 'a memory needs frontmatter and a body' });

      // Frontmatter. description is the ENTIRE retrieval surface: nothing else is indexed, so a
      // memory without one exists and can never be found, which is worse than not writing it.
      const fm = content.replace(/\r\n/g, '\n');
      if (!fm.startsWith('---')) return json(res, 400, { error: 'no frontmatter' });
      const end = fm.indexOf('\n---', 3);
      if (end < 0) return json(res, 400, { error: 'unterminated frontmatter' });
      const head = fm.slice(3, end);
      const field = (k) => (head.match(new RegExp('^\\s*' + k + ':\\s*(.+)$', 'm')) || [])[1];
      const desc = field('description');
      if (!field('name')) return json(res, 400, { error: 'missing name' });
      if (!desc || desc.trim().length < 20) {
        return json(res, 400, { error: 'missing or thin description', detail: 'the description is the only thing indexed for recall. Write it in the words the owner would type, at least 20 chars.' });
      }
      // TYPE MUST BE TOP LEVEL, not nested under metadata, and it must be present.
      //
      // field() searches with the m flag, so it happily matched an INDENTED "  type:" under
      // metadata and let the write through. The mind-map builder only reads top-level keys, so
      // reflect.mjs then failed the contract, and a failing reflection blocks the pre-commit gate
      // on EVERY machine. On 2026-09-09 the WhatsApp instance wrote exactly that shape from a
      // live client conversation and jammed commits brain-wide until someone found it by hand.
      // Same poison-pill shape as a broken wikilink, so it is rejected in the same place: here,
      // while the author is still around to fix it.
      const topType = (head.match(/^type:[ 	]*(.+)$/m) || [])[1];
      if (!topType) {
        return json(res, 400, {
          error: 'type must be top level',
          detail: 'add a line "type: ' + prefix + '" at the top level of the frontmatter. Nested under metadata does not count: the mind map cannot see it and reflection then blocks commits on every machine.',
        });
      }
      if (topType.trim() !== prefix) {
        return json(res, 400, { error: 'type mismatch', detail: 'frontmatter type "' + topType.trim() + '" does not match slug prefix "' + prefix + '"' });
      }

      // WIKILINKS MUST POINT SOMEWHERE. This is not style, it is a poison pill.
      //
      // A memory with a broken edge lands on the server, then the pre-commit gate refuses EVERY
      // subsequent commit from EVERY machine until someone finds it. That happened on 2026-08-24:
      // a laptop client wrote a memory linking to reference_gate_docker_ram_trap, which does not exist, and
      // the whole brain stopped being able to commit. Reject at write time, where the author is
      // still here to fix it, rather than leaving a landmine for whoever commits next.
      const links = [...new Set((fm.match(/\[\[([^\]]+)\]\]/g) || [])
        .map((l) => l.slice(2, -2).trim()))];
      // RESOLVE THE SAME WAY reflect.mjs DOES, or this refuses links the brain's own linter accepts.
      //
      // The first version only checked whether memory/<link>.md existed. But a wikilink may name
      // either the filename stem OR the frontmatter `name`, normalized, which is how
      // [[workout-muscle-recovery]] legitimately points at feedback_workout_muscle_recovery.md.
      // Being stricter than the linter did not make the brain safer, it made every memory using
      // the name form UNWRITABLE through the server, which is now the only write path. Caught
      // 2026-08-24 trying to update reference_dashboards_auth_finance_autoworkout, whose four links
      // reflect reports as "Broken wikilinks (0)".
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const resolvable = new Set([norm(slug)]);
      try {
        for (const f of readdirSync(join(BRAIN, 'memory'))) {
          if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
          resolvable.add(norm(f.slice(0, -3)));
          const head = readFileSync(join(BRAIN, 'memory', f), 'utf8').slice(0, 600);
          const nm = /^name:\s*(.+)$/m.exec(head);
          if (nm) resolvable.add(norm(nm[1].replace(/["']/g, '')));
        }
      } catch { /* unreadable memory dir is a bigger problem, handled by the outer catch */ }
      // The incoming memory's own frontmatter name counts too, for a self-link on a new file.
      const ownName = /^name:\s*(.+)$/m.exec(fm);
      if (ownName) resolvable.add(norm(ownName[1].replace(/["']/g, '')));
      const dead = links.filter((l) => !resolvable.has(norm(l)));
      if (dead.length) {
        return json(res, 400, { error: 'broken wikilink', detail: 'these point at memories that do not exist: '
          + dead.join(', ') + '. Create them first, or drop the link. A broken edge blocks commits for every machine.' });
      }

      const file = join(BRAIN, 'memory', slug + '.md');
      const existed = existsSync(file);
      try {
        writeFileSync(file, fm, 'utf8');
        // THE WRITER GETS ITS ANSWER NOW, THE INDEX AND THE BACKUP FOLLOW. The owner, 2026-09-17: "that call
        // should be in the back end, no need to block us, and this should be the standard for all
        // agent brain functionalities, it shouldn't affect the flow of the conversation".
        //
        // Reindex, commit and push used to run here with execFileSync. That blocked the caller AND
        // froze this whole process, so every memory written from any machine stalled every other
        // machine's recall: the analyzer reported "brain server did not answer /health" at 10:06 and
        // 10:31 that day, each right after the locked-down client machine wrote a memory. Validation and the
        // file write stay above, synchronous, because a bad write must still be refused while the
        // author is there. What is queued can no longer fail in a way the author could fix.
        // The cost, accepted: recall can miss a brand new memory for the few seconds indexing takes.
        queueBrainSave(slug, existed, caller.name, ip);
        return json(res, 200, { ok: true, slug, updated: existed, queued: true, pushed: null, v: indexVersion().version });
      } catch (e) {
        audit('MEMORY-WRITE-FAIL ' + ip + ' ' + caller.name + ' ' + slug + ' ' + String(e.message).slice(0, 80));
        return json(res, 500, { error: 'write failed', detail: String(e.message).slice(0, 200) });
      }
    }

    /* ---- DELETE A MEMORY -----------------------------------------------------------------
       The owner, 2026-09-21: "we need to allow memories to be deleted, because the git memory and the
       local brain memory keep breaking the brain recall."
       Until now nothing anywhere could remove one. A memory could be corrected or superseded and
       never withdrawn, so a fact that turned out to be wrong stayed in recall forever and the only
       remedy was editing it into a note saying it was wrong.

       NOTHING IS UNLINKED. The file moves to deleted/ at the brain root with a line saying who
       removed it, when and why, so any delete can be undone by moving it back. The graveyard is
       committed with everything else: a memory that mattered enough to write is worth keeping the
       body of.

       INBOUND LINKS ARE CHECKED FIRST, because a wikilink pointing at a memory that no longer
       exists is a broken edge, and a broken edge REFUSES every later write from every machine.
       Deleting carelessly would wedge the whole brain, so the refusal names the files to fix. */
    if (path.startsWith('/memory/') && req.method === 'DELETE') {
      const slug = basename(decodeURIComponent(path.slice('/memory/'.length))).replace(/\.md$/, '');
      if (!/^[a-z][a-z0-9_]{2,80}$/.test(slug)) return json(res, 400, { error: 'bad slug' });
      const file = join(BRAIN, 'memory', slug + '.md');
      if (!existsSync(file)) return json(res, 404, { error: 'no such memory', detail: slug + ' is not on the server.' });

      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) { req.destroy(); return; } }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* a reason is optional in shape, not in policy */ }
      const why = String(body.why || '').trim();
      if (why.length < 10) {
        return json(res, 400, { error: 'no reason', detail: 'say why in at least ten characters. A deletion with no reason is indistinguishable from an accident.' });
      }

      // Who points at it. The name form counts as well as the filename form, the same way the
      // write path resolves links, or this would refuse deletions over links that are not real.
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const ownNames = new Set([norm(slug)]);
      try {
        const head = readFileSync(file, 'utf8').slice(0, 600);
        const nm = /^name:\s*(.+)$/m.exec(head);
        if (nm) ownNames.add(norm(nm[1].replace(/["']/g, '')));
      } catch { /* read failure is handled below */ }
      const pointing = [];
      try {
        for (const f of readdirSync(join(BRAIN, 'memory'))) {
          if (!f.endsWith('.md') || f === 'MEMORY.md' || f === slug + '.md') continue;
          const txt = readFileSync(join(BRAIN, 'memory', f), 'utf8');
          const links = [...txt.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => norm(m[1]));
          if (links.some((l) => ownNames.has(l))) pointing.push(f.slice(0, -3));
        }
      } catch { /* handled by the outer catch */ }
      if (pointing.length && !body.force) {
        return json(res, 409, {
          error: 'still linked',
          detail: pointing.length + ' memories link to ' + slug + ': ' + pointing.slice(0, 12).join(', ')
            + '. A link to a memory that does not exist is a broken edge and it blocks writes for every'
            + ' machine. Remove those links first, or repeat with force to have them left as they are.',
          linked: pointing,
        });
      }

      /* THE BACKUP IS OUT OF REACH, ON PURPOSE. The owner, 2026-09-21: "it is good that we keep a non
         accessable back up of the deleted memory in case the agent deleted something it shouldn't
         have." So the body does not go to a folder in the repo, where it would be committed, greppable
         and one Read away from any agent. It goes OUTSIDE the brain, next to the machine's own keys,
         encrypted to this machine's age public key.
         What that does and does not buy, plainly: it is not in git, not in the index, not in recall,
         not served by any route, and unreadable on any other machine even with the file in hand.
         It does NOT stop an agent with a shell ON THIS MACHINE from running age against the key, and
         nothing stored here could. Recovery is deliberate: node tools/graveyard.mjs restore <slug>. */
      try {
        const grave = join(CONFIG_DIR, 'brain-graveyard');
        mkdirSync(grave, { recursive: true });
        const stamp = new Date().toISOString();
        const note = '<!-- deleted ' + stamp + ' by ' + caller.name + ' from ' + ip + ': ' + why.slice(0, 300) + ' -->\n';
        const plain = note + readFileSync(file, 'utf8');
        // The registry names its own host, which is the machine holding the private half. Reading
        // the OS hostname instead would break the day the box is renamed.
        const reg = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')) || {};
        const pub = ((reg.machines || {})[reg.host] || {}).pubkey;
        if (!pub) throw new Error('no age recipient for this machine, refusing to delete without a recoverable backup');
        // STDIN, never argv: the body of a memory is not going on a command line.
        const sealed = execFileSync('age', ['-r', pub, '-a'], { input: plain, encoding: 'utf8' });
        writeFileSync(join(grave, slug + '.' + stamp.replace(/[:.]/g, '-') + '.age'), sealed, 'utf8');
        rmSync(file);
        audit('MEMORY-DELETE ' + ip + ' ' + caller.name + ' ' + slug + ' :: ' + why.slice(0, 120));
        queueBrainSave(slug, true, caller.name, ip);
        return json(res, 200, { ok: true, slug, deleted: true, linked: pointing, queued: true });
      } catch (e) {
        audit('MEMORY-DELETE-FAIL ' + ip + ' ' + caller.name + ' ' + slug + ' ' + String(e.message).slice(0, 80));
        return json(res, 500, { error: 'delete failed', detail: String(e.message).slice(0, 200) });
      }
    }

    if (path === '/recall' && req.method === 'POST') {
      let rbody = '';
      for await (const chunk of req) {
        rbody += chunk;
        if (rbody.length > 200_000) { req.destroy(); return; }
      }
      let rp;
      try { rp = JSON.parse(rbody || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const prompt = typeof rp.prompt === 'string' ? rp.prompt : '';
      if (!prompt.trim()) return json(res, 400, { error: 'prompt required' });
      // The caller may send prepared chunks (a long prompt already split, or an Arabic prompt
      // already translated). If it does not, the whole prompt is the single query.
      const queries = Array.isArray(rp.queries) && rp.queries.length
        ? rp.queries.filter((t) => typeof t === 'string' && t.trim()).slice(0, 16)
        : [prompt.slice(0, 4000)];
      const tr = Date.now();
      // Capped hard at 4000 per memory however much a caller asks for: five hits at the default
      // 1500 is about 7 KB on the wire and in the agent's context, every turn, on every machine.
      const bodyChars = rp.bodies === false ? 0
        : rp.bodies ? Math.min(Math.max(Number(rp.bodyChars) || 1500, 200), 4000) : 0;
      const ranked = await recall(prompt, queries, Math.min(Math.max(Number(rp.limit) || 5, 1), 20), bodyChars);
      // Counts only. Never the prompt, never the matched slugs.
      audit('RECALL ' + ip + ' q=' + queries.length + ' chars=' + prompt.length
        + ' hits=' + ranked.length + (bodyChars ? ' bodies=' + bodyChars : '') + ' ' + (Date.now() - tr) + 'ms');
      return json(res, 200, { ranked, v: indexVersion().version });
    }

    // WHICH MEMORIES A MACHINE ACTUALLY USED, collected centrally.
    //
    // The owner, 2026-09-15: "can you check if its working, because the other machine is on and
    // recalling". It was, and the map showed it as idle, because each machine wrote its recall
    // log to its OWN disk and nothing ever collected them. A machine that cannot reach GitHub
    // can still reach this server, which is how it recalls in the first place, so this is the
    // one channel every machine already has.
    //
    // ON PRIVACY, because this is a deliberate reversal. The audit line for /recall records
    // counts only, never the prompt and never the matched slugs, and that stays true. This route
    // records slugs and nothing else: no prompt, no answer, no content. A slug is the filename of
    // a memory that is already sitting on this same disk, so writing it next to them adds no
    // exposure. The prompt is what must never be written down, and it still is not.
    if (path === '/pulse' && req.method === 'POST') {
      let pbody = '';
      for await (const chunk of req) {
        pbody += chunk;
        if (pbody.length > 20_000) { req.destroy(); return; }
      }
      let pp;
      try { pp = JSON.parse(pbody || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const host = String(pp.host || '').slice(0, 64);
      const slugs = Array.isArray(pp.slugs)
        ? pp.slugs.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 200))
        : [];
      const how = Array.isArray(pp.how)
        ? pp.how.filter((x) => typeof x === 'string').slice(0, 20)
        : [];
      if (!host || !slugs.length) return json(res, 400, { error: 'host and slugs required' });
      // The hook on THIS machine already wrote the line locally before posting. Appending it
      // again here would double every recall the server itself makes.
      if (host.toUpperCase() === hostname().toUpperCase()) return json(res, 200, { ok: true, skipped: 'local' });
      const at = Number(pp.at) || Date.now();
      try {
        const PULSE = join(BRAIN, '.recall-pulse.jsonl');
        appendFileSync(PULSE, JSON.stringify({ at, host, slugs, how }) + '\n', 'utf8');
        const lines = readFileSync(PULSE, 'utf8').split('\n').filter(Boolean);
        if (lines.length > 800) writeFileSync(PULSE, lines.slice(-600).join('\n') + '\n', 'utf8');
      } catch { /* bookkeeping only */ }
      audit('PULSE ' + ip + ' host=' + host + ' hits=' + slugs.length);
      return json(res, 200, { ok: true });
    }

    if (path === '/embed' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 100_000) { req.destroy(); return; }
      }
      const parsed = JSON.parse(body || '{}');

      // BATCH: accept an array of texts and answer in ONE round trip.
      //
      // Added 2026-08-22 after watching the cost on a real remote prompt. Chunking a long prompt
      // made pre-turn.mjs issue 8 sequential calls, and from a laptop client that measured:
      //   server time  273ms total across the 8
      //   wall clock  2083ms
      // So about 226ms per call was pure round-trip overhead, and a long prompt went from ~130ms
      // to over 2 seconds before the reply even started. The model itself was never the problem.
      //
      // One request, one model batch, one response. The per-call overhead is paid once.
      if (Array.isArray(parsed.texts)) {
        const texts = parsed.texts.filter((t) => typeof t === 'string' && t.trim()).slice(0, 16);
        if (!texts.length) return json(res, 400, { error: 'texts must be a non-empty array of strings' });
        const tb = Date.now();
        const embedB = await getEmbedder();
        const vectors = [];
        // A LOOP, deliberately, not embedB(texts).
        //
        // The pipeline does accept an array and returns one [n, 384] tensor, and it is about 1.5x
        // faster. It also returns DIFFERENT VECTORS: measured 2026-08-22, max element difference
        // 2.21e-2 against the loop on identical input, which is far more than enough to reorder
        // recall results. An array input pads every sequence to the longest one, and mean-pooling
        // then averages the padding in.
        //
        // 1.5x is not worth silently corrupting the vectors, and the corruption is invisible: the
        // output is still 384 dims and still normalised, so nothing downstream would complain. The
        // round trips were the real cost and batching the REQUEST already removed those.
        for (const t of texts) {
          const o = await embedB(t.slice(0, 4000), { pooling: 'mean', normalize: true });
          vectors.push(Array.from(o.data));
        }
        audit('EMBED-BATCH ' + ip + ' n=' + texts.length
          + ' chars=' + texts.reduce((a, t) => a + t.length, 0) + ' ' + (Date.now() - tb) + 'ms');
        // v rides along so a caller learns the index version without a second request.
        return json(res, 200, { vectors, v: indexVersion().version });
      }

      const { text } = parsed;
      if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'text or texts required' });
      const t0 = Date.now();
      const embed = await getEmbedder();
      const out = await embed(text.slice(0, 4000), { pooling: 'mean', normalize: true });
      // Log the CALL, never the text.
      //
      // Added 2026-08-22 so a prompt typed on another machine is visible here at all: until now
      // /embed was the one route that left no trace, which made "is the laptop actually using the
      // server" unanswerable from this side.
      //
      // The text is the owner's actual prompt, so it is never written down. Caller, length and latency
      // are enough to prove the path works and to spot a machine hammering it, and none of them
      // reveal what he asked.
      audit('EMBED ' + ip + ' chars=' + text.length + ' ' + (Date.now() - t0) + 'ms');
      return json(res, 200, { vector: Array.from(out.data), v: indexVersion().version });
    }

    return json(res, 404, { error: 'no such route' });
  } catch (e) {
    // Never leak an internal path or a stack trace to a caller that might be hostile.
    // Log WHO, not just what. An unattributable error is a dead end: the first one of these
    // came from the locked-down client machine testing /embed with a malformed body, and the line could
    // not say so, which cost a round trip to establish.
    audit('ERROR ' + ip + ' ' + path + ' ' + String(e.message).slice(0, 120));
    return json(res, 500, { error: 'request failed' });
  }
};
const server = createServer(handler);

const host = PUBLIC ? '0.0.0.0' : '127.0.0.1';

// "Already running" is success, not failure. Two things start this: the session-start hook and
// the Windows scheduled task. Whichever loses the race MUST exit 0, because a nonzero exit makes
// the task's restart policy fire every minute, forever, against a server that is perfectly
// healthy. Without this the fix for a dead server becomes a restart loop.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stdout.write('brain server already listening on ' + host + ':' + PORT + ', nothing to do' + String.fromCharCode(10));
    process.exit(0);
  }
  throw e;
});
// Keep the model's pages resident. Measured 2026-08-22: the process had been up 5.5 hours
// without restarting, embedFn was still set, and yet a request cost 684ms. The working set had
// fallen from a 175MB peak to 59MB, so Windows had trimmed the weights out of RAM and the request
// paid to read them back off disk. Nothing in this file unloads the model; the OS does.
//
// Times against the idle gap before the call: back to back 28-58ms, minutes idle 358-376ms,
// 5.5 hours idle 684ms. Every remote machine pays that on its first prompt after a quiet spell,
// which is exactly when the owner is most likely to be typing.
//
// A tiny embed on a timer touches the weights and keeps them paged in. 45 seconds is a guess at
// the trimmer's patience, not a measured optimum: short enough to beat the several-minute gaps
// that already cost 358ms, long enough that the cost is nil. It burns roughly 30ms of one core
// per interval, about 0.07 percent.
const KEEPALIVE_MS = 45_000;
const KEEPALIVE_TEXT = 'keepalive';

async function touchModel(label) {
  try {
    const e = await getEmbedder();
    const t = Date.now();
    await e(KEEPALIVE_TEXT, { pooling: 'mean', normalize: true });
    return Date.now() - t;
  } catch (err) {
    audit('KEEPALIVE-FAIL ' + label + ' ' + String(err && err.message).slice(0, 80));
    return null;
  }
}

if (ALLOW_PLAINTEXT) server.listen(PORT, host, () => {
  process.stdout.write('brain server on ' + host + ':' + PORT
    + (PUBLIC ? '  PUBLIC, expose only behind a tunnel' : '  local only') + '\n');
  process.stdout.write('token file: ' + TOKEN_FILE + '\n');

  // Warm on boot so the FIRST real request is not the one that pays the load.
  touchModel('boot').then((ms) => {
    if (ms != null) process.stdout.write('embedder warm, ' + ms + 'ms\n');
  });

  // Not unref'd: keeping the model hot is a job of the server, not a background nicety, and the
  // server is what holds the process open anyway.
  setInterval(() => { touchModel('tick'); }, KEEPALIVE_MS);
});

// ---- TLS ---------------------------------------------------------------------------------
//
// The transport was plain HTTP, so every client sent its bearer token across the owner's WiFi in the
// clear, and that token unlocks the entire vault. Tailscale will encrypt machine to machine, but
// it needs an elevated install and a browser login only the owner can perform, and the exposure is live
// right now. This closes it without waiting for anyone, and it is not wasted afterwards: if the
// tailnet is ever compromised, traffic inside it is still encrypted.
//
// PINNED SELF-SIGNED, deliberately not a public CA. Clients accept exactly this certificate and
// nothing else, which is STRONGER than ordinary PKI here: no certificate authority can be coaxed
// into issuing a substitute for a name on a private network. The certificate is public and ships
// in the repo so every machine can pin it. The private key never leaves this machine and is
// restricted by ACL to <user> and SYSTEM.
//
// PLAIN HTTP STAYS UP ON 8478 FOR NOW, on purpose. Switching to TLS-only before a laptop client has pulled
// the client change would strand it with no brain at all, which is a worse outcome than one more
// hour of the exposure that has already been open all day. 8478 closes the moment a laptop client confirms
// it is talking TLS.
// Bind to LOOPBACK and the TAILNET, never 0.0.0.0.
//
// The owner, 2026-08-22: make sure nobody else can reach this. 0.0.0.0 put the vault on every network
// this machine joins, including cafe wifi. Restricting to the Tailscale interface means a
// compromised phone or IoT device on the house LAN cannot even see the port is open, and a machine
// away from home still reaches it over the encrypted mesh.
//
// TWO listeners rather than one, because Node binds a single address per server and dropping
// loopback would break THIS machine: its own hook talks to 127.0.0.1 to avoid a 316ms hostname
// lookup. Binding tailnet-only would have quietly cost every local prompt that time back.
//
// 100.64.0.0/10 is the CGNAT range Tailscale assigns. Detected from the interface list rather than
// by shelling out to tailscale.exe, so a stale PATH cannot break startup.
function tailnetAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces() || {})) {
    for (const a of (list || [])) {
      if (a.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

if (PUBLIC && tailnetAddresses().length === 0) {
  // --public asked for reachability and there is no tailnet to provide it. Say so loudly rather
  // than silently serving loopback only, which would look like the server is simply down.
  process.stdout.write('WARNING: --public but no Tailscale address found yet, serving loopback only until one appears' + String.fromCharCode(10));
}
const TLS_PORT = Number(process.env.HAVOK_SERVER_TLS_PORT || 8443);
// How often to look for a tailnet address that was absent at startup. Reading the interfaces once
// is what left the brain loopback-only for every other machine after the 2026-09-16 reboot.
const TAILNET_POLL_MS = Number(process.env.HAVOK_TAILNET_POLL_MS || 15000);

if (HAVE_TLS) {
  import('node:https').then(({ createServer: createHttps }) => {
    const opts = { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) };
    // ONE SERVER OBJECT PER ADDRESS.
    //
    // A net.Server listens exactly once. Looping tls.listen() over several addresses on a SINGLE
    // server does not bind them all: the second call fails with ERR_SERVER_ALREADY_LISTEN and the
    // machine ends up reachable on only one address. Caught 2026-08-23 by checking the listeners
    // after the change: loopback had silently stopped answering while the tailnet address worked,
    // so this machine fell back to local matching and nothing anywhere said why.
    const listenOn = (addr, onFail) => {
      const tls = createHttps(opts, handler);
      // Two starters race (scheduled task plus session hook) and the loser must exit quietly,
      // otherwise its restart policy fires every minute forever against a healthy server.
      tls.on('error', (e) => {
        const tail = String.fromCharCode(10);
        // Loopback taken means another brain server is already serving. Exit: the tailnet watcher's
        // timer would otherwise keep this copy alive forever. Ten of them had piled up by 2026-09-17,
        // each started by a session-start check whose 2 second probe hit a server frozen by a write.
        if (e && e.code === 'EADDRINUSE' && addr === '127.0.0.1' && !ALLOW_PLAINTEXT) { process.stdout.write('brain server TLS already listening on ' + addr + ', exiting' + tail); process.exit(0); }
        if (e && e.code === 'EADDRINUSE') { process.stdout.write('brain server TLS already listening on ' + addr + tail); return; }
        process.stdout.write('brain server TLS failed on ' + addr + ': ' + String(e && e.message).slice(0, 120) + tail);
        if (onFail) onFail(addr);
      });
      tls.listen(TLS_PORT, addr, () => {
        process.stdout.write('brain server TLS on ' + addr + ':' + TLS_PORT + String.fromCharCode(10));
      });
    };
    listenOn('127.0.0.1');
    const tailnet = watchTailnet({
      list: tailnetAddresses,
      intervalMs: TAILNET_POLL_MS,
      bind: (addr) => listenOn(addr, (a) => tailnet.forget(a)),
    });
  }).catch(() => { /* no https available: the plaintext listener still serves */ });
} else {
  process.stdout.write('NO TLS CERT, serving plaintext only. Generate one to encrypt the transport.\n');
}
