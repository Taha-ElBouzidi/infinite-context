// The brain server's embedder, with a time limit on every call (2026-11-02 freeze, tools/brain-server-embed-stuck.test.mjs).
//
// The model runs on a worker thread, so a slow or wedged embedding no longer holds the thread that answers /health and
// every other route. Each call has a limit; past it the call fails, recall falls back to keyword only and says so.
// A worker that is loaded but gave no answer in time is stuck, and a stuck native call cannot be cancelled, so the
// worker is ended and the next call starts a fresh one. A worker still LOADING is left to finish (ending it would mean
// a slow machine never gets a model at all); only its own load limit ends it.
//
// embed(text, opts) resolves { data: Float32Array }, the shape the transformers pipeline returns, so callers are unchanged.
import { Worker } from 'node:worker_threads';

export function makeGuardedEmbedder({ model, module, timeoutMs, loadTimeoutMs, onEvent = () => {} }) {
  let w = null, ready = false, loadTimer = null, seq = 0;
  const pending = new Map();

  function drop(reason) {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    const old = w;
    w = null; ready = false;
    for (const [, p] of pending) { clearTimeout(p.timer); p.fail(new Error(reason)); }
    pending.clear();
    if (old) old.terminate().catch(() => {});
  }

  function start() {
    const me = new Worker(new URL('./embed-worker.mjs', import.meta.url), { workerData: { model, module } });
    w = me;
    loadTimer = setTimeout(() => { if (w === me && !ready) { onEvent('load-timeout'); drop('the embedding model did not load in ' + loadTimeoutMs + ' ms'); } }, loadTimeoutMs);
    me.on('message', (m) => {
      if (w !== me) return;
      if (m.ready) { ready = true; clearTimeout(loadTimer); loadTimer = null; return; }
      if (m.loadError) { onEvent('load-failed'); drop('the embedding model failed to load: ' + m.loadError.slice(0, 120)); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.fail(new Error(m.error)); else p.ok({ data: m.data });
    });
    me.on('error', (e) => { if (w === me) drop('the embedding worker failed: ' + String(e && e.message).slice(0, 120)); });
    me.on('exit', (code) => { if (w === me) drop('the embedding worker exited with code ' + code); });
  }

  function embed(text, opts) {
    if (!w) start();
    const me = w;
    return new Promise((ok, fail) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (w === me && ready) {
          onEvent('stuck');
          fail(new Error('an embedding gave no answer in ' + timeoutMs + ' ms'));
          drop('the embedding worker was restarted after a call gave no answer in ' + timeoutMs + ' ms');
        } else {
          fail(new Error('the embedding model was still loading after ' + timeoutMs + ' ms'));
        }
      }, timeoutMs);
      pending.set(id, { ok, fail, timer });
      me.postMessage({ id, text, opts });
    });
  }

  return { embed, close: () => drop('the embedder was closed'), state: () => (w ? (ready ? 'ready' : 'loading') : 'idle') };
}
