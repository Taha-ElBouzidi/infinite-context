// The embedding model on its own thread (tools/embed-guard.mjs starts it). onnxruntime-node runs the model
// synchronously, so on the server's main thread one slow embedding held every request, /health included (2026-11-02).
// HAVOK_EMBED_MODULE names a module whose load() returns the embed function, for tests; otherwise the real model.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

async function load() {
  if (workerData && workerData.module) return (await import(pathToFileURL(workerData.module).href)).load();
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowLocalModels = false;
  return pipeline('feature-extraction', workerData.model);
}

try {
  const embed = await load();
  parentPort.on('message', async ({ id, text, opts }) => {
    try {
      const o = await embed(text, opts);
      const data = Float32Array.from(o.data);
      parentPort.postMessage({ id, data }, [data.buffer]);
    } catch (e) {
      parentPort.postMessage({ id, error: String((e && e.message) || e) });
    }
  });
  parentPort.postMessage({ ready: true });
} catch (e) {
  parentPort.postMessage({ loadError: String((e && e.message) || e) });
}
