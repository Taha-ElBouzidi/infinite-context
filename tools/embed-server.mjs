// Tiny localhost embedding server. Loads the model once, answers queries in milliseconds.
//
// WHY A DAEMON AND NOT AN IN-HOOK CALL
// pre-turn.mjs runs on EVERY turn. Loading the multilingual model in-process costs 1,285ms
// even warm, against 64ms for the whole keyword hook today. That is a 20x regression on every
// prompt, paid forever, to gain 5 points of recall. Held resident, the same query is about
// 20ms, which is affordable.
//
// It is deliberately small: loopback only, no auth, no dependencies beyond the model. /embed returns
// a vector; /recall (2026-09-26) runs the brain server's own recall on this brain. It holds nothing secret. If it is not running, the hook falls back to keyword-only and
// says so, which is the whole reason the sparse channel was kept.
//
// Start:  node tools/embed-server.mjs &
// Health: curl http://127.0.0.1:8477/health

import { createServer } from 'node:http';
import { writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { pipeline, env } from '@xenova/transformers';
import { makeRecall, SHORT_FOLLOW_UP } from './recall-core.mjs';

env.allowLocalModels = false;

const DEFAULT_PORT = 8477;
const PORT = Number(process.env.HAVOK_EMBED_PORT || DEFAULT_PORT);
// The liveness marker describes THE daemon, the one on the default port that everything talks to.
// An instance started on another port via HAVOK_EMBED_PORT is a test rig, and it must not touch the
// marker at all. See the note below: the same-port duplicate was already guarded, the different-port
// duplicate was not, and it binds successfully, so it claimed ownership and overwrote the marker
// with its own pid. Found 2026-09-08 with three of them from a 2026-09-05 test still running.
const IS_THE_DAEMON = PORT === DEFAULT_PORT;
const MODEL = 'Xenova/all-MiniLM-L6-v2';

process.stdout.write(`loading ${MODEL} ...\n`);
const t0 = Date.now();
const embed = await pipeline('feature-extraction', MODEL);
process.stdout.write(`ready in ${Date.now() - t0}ms on 127.0.0.1:${PORT}\n`);

// The same recall the brain server runs (tools/recall-core.mjs), for a local install with no server.
// Until 2026-09-26 a local install ranked with a plain top 5 in the hook instead.
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localIndexVersion = () => {
  const parts = [];
  for (const f of ['keywords.json', 'embeddings.json']) {
    try { const st = statSync(join(BRAIN, 'index', f)); parts.push(f + ':' + st.size + ':' + Math.floor(st.mtimeMs)); } catch { /* absent */ }
  }
  return { version: parts.join('|') };
};
const recall = makeRecall({ brain: BRAIN, getEmbedder: async () => embed, indexVersion: localIndexVersion });
const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();

const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: MODEL, recall: true }));
  }
  if (req.method === 'POST' && req.url === '/recall') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 400_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const rp = JSON.parse(body || '{}');
        // Only for the brain this daemon was started from: a second brain folder on the same machine (a
        // test copy) would otherwise get the first brain's memories.
        if (norm(rp.brain) !== norm(BRAIN)) { res.writeHead(409, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'different brain' })); }
        const prompt = String(rp.prompt || '');
        const queries = (Array.isArray(rp.queries) && rp.queries.length ? rp.queries : [prompt]).map(String).slice(0, 24);
        const parts = Math.max(0, Math.min(Number(rp.parts) || 0, 16));
        const ctx = (Number.isInteger(rp.contextIndex) && prompt.trim().length >= SHORT_FOLLOW_UP) ? rp.contextIndex : -1;
        const ranked = await recall(prompt, queries, 5, 0, false, parts, ctx);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ranked }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
      }
    });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/embed') {
    res.writeHead(404); return res.end();
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const { text } = JSON.parse(body || '{}');
      if (typeof text !== 'string' || !text.trim()) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'text required' }));
      }
      const out = await embed(text.slice(0, 4000), { pooling: 'mean', normalize: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ vector: Array.from(out.data) }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
    }
  });
});

// Loopback only. Nothing here should ever be reachable off this machine.
// Liveness marker. The hook stats this instead of attempting a socket, because a refused
// connection on Windows costs about a second and this hook runs on every single turn.
const ALIVE = join(homedir(), '.claude', 'havok-embed.alive');
// Same as the brain server: the session-start hook and the scheduled task both try to start this,
// and the loser has to exit 0 or the task retries every minute against a healthy daemon.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stdout.write('embed daemon already listening on 127.0.0.1:' + PORT + ', nothing to do' + String.fromCharCode(10));
    process.exit(0);
  }
  throw e;
});
// Only the process that actually owns the port may delete the liveness marker. A duplicate
// start exits through the same process.on('exit') handler, and without this guard it deletes the
// RUNNING server's marker on its way out. That happened on 2026-08-21: the daemon was healthy and
// answering on 8477, the marker was gone, and every turn reported semantic recall as off because
// the per-turn hook stats the marker rather than probing the port.
let ownsPort = false;
server.listen(PORT, '127.0.0.1', () => {
  ownsPort = IS_THE_DAEMON;
  // Guarding the delete alone was not enough: an instance on another port bound successfully and
  // WROTE its own pid over the marker, so the file described a process nothing talks to. Found
  // 2026-09-08, marker said 68888 while the daemon serving 8477 was 6276. Both sides need the guard.
  if (!IS_THE_DAEMON) {
    process.stdout.write('running on ' + PORT + ', not the default, so leaving the liveness marker alone' + String.fromCharCode(10));
    return;
  }
  try { writeFileSync(ALIVE, String(process.pid), 'utf8'); } catch {}
});
const cleanup = () => { if (ownsPort) { try { unlinkSync(ALIVE); } catch {} } process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, cleanup);
process.on('exit', () => { if (ownsPort) { try { unlinkSync(ALIVE); } catch {} } });
