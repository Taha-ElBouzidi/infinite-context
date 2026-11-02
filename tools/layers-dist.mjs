// The context layers of the mod: layers/ in this repo holds the shared system-prompt sections, global.md for every
// agent, machine/<MACHINE>.md and group/<name>.md. The brain host reads them here; other machines get them through the
// /dist mirror (brain-server.mjs serves them, pull-from-server.mjs fetches them). the owner 2026-11-02: "our solution needs
// to be complete, not a half baked solution": the layers were a local folder on the host only, so no other machine had them.
// The agent layer is not here: an agent writes it itself (context_keep), into a local folder of its machine.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SUBFOLDERS = ['', 'machine', 'group'];

// Every layer file this brain serves: README.md and *.md directly in layers/, layers/machine/ and layers/group/.
export function servedLayerFiles(brain) {
  const out = [];
  for (const sub of SUBFOLDERS) {
    const dir = sub ? join(brain, 'layers', sub) : join(brain, 'layers');
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      try { if (!statSync(join(dir, n)).isFile()) continue; } catch { continue; }
      out.push(['layers', sub, n].filter(Boolean).join('/'));
    }
  }
  return out;
}

// On a mirror: the layer files the server no longer lists, so a layer removed on the host leaves this machine too (a
// retracted rule would otherwise stay in every prompt here). Only when the list proves the server serves layers (it
// names layers/README.md): an older server, or a broken list, removes nothing.
export function layerOrphans(brain, published) {
  if (!published.has('layers/README.md')) return [];
  return servedLayerFiles(brain).filter((rel) => !published.has(rel));
}
