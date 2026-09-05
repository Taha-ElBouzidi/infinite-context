// Tiny localhost embedding server. Loads the model once, answers queries in milliseconds.
//
// WHY A DAEMON AND NOT AN IN-HOOK CALL
// pre-turn.mjs runs on EVERY turn. Loading the multilingual model in-process costs 1,285ms
// even warm, against 64ms for the whole keyword hook today. That is a 20x regression on every
// prompt, paid forever, to gain 5 points of recall. Held resident, the same query is about
// 20ms, which is affordable.
//
// It is deliberately trivial: loopback only, one route, no auth, no dependencies beyond the
// model. It holds nothing secret. If it is not running, the hook falls back to keyword-only and
// says so, which is the whole reason the sparse channel was kept.
//
// Start:  node tools/embed-server.mjs &
// Health: curl http://127.0.0.1:8477/health

import { createServer } from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;

const PORT = Number(process.env.HAVOK_EMBED_PORT || 8477);
const MODEL = 'Xenova/all-MiniLM-L6-v2';

process.stdout.write(`loading ${MODEL} ...\n`);
const t0 = Date.now();
const embed = await pipeline('feature-extraction', MODEL);
process.stdout.write(`ready in ${Date.now() - t0}ms on 127.0.0.1:${PORT}\n`);

const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: MODEL }));
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
  ownsPort = true;
  try { writeFileSync(ALIVE, String(process.pid), 'utf8'); } catch {}
});
const cleanup = () => { if (ownsPort) { try { unlinkSync(ALIVE); } catch {} } process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, cleanup);
process.on('exit', () => { if (ownsPort) { try { unlinkSync(ALIVE); } catch {} } });
