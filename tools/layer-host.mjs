// The layer host (context release, 2026-11-02). The context layers HAVOK owns (global.md, machine/<MACHINE>.md,
// group/<name>.md) live in their own folder on the host, D:/dev/Havok/LAYERS, outside the brain repo, so a layer
// change no longer rides the code sync of every machine. The brain server serves each layer with a version, the
// sha256 of its text, so the mod asks for the versions before a message and downloads a layer only when it changed.
// The agent layer is not here: each agent writes its own, locally.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// The mod's own layerMaxChars: a layer it would refuse is not served either, so the mod keeps its last good copy.
export const LAYER_MAX_CHARS = 20000;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// A key is "global", "machine/<name>" or "group/<name>", nothing else. A path is never built from anything that
// fails this, so .., a backslash or an absolute path cannot reach the disk.
export function validKey(key) {
  if (key === 'global') return true;
  const m = /^(machine|group)\/([^/]+)$/.exec(String(key || ''));
  return !!m && NAME.test(m[2]);
}

const fileOf = (root, key) => join(root, key + '.md');
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

// Line endings are served as LF whatever the disk holds, so a checkout with autocrlf cannot change a version.
function load(root, key) {
  try { return readFileSync(fileOf(root, key), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
}

// { status, text, version } for one key: 400 bad key, 404 absent, 413 over the size limit, 200 otherwise.
export function readLayer(root, key) {
  if (!validKey(key)) return { status: 400, error: 'bad layer key' };
  const text = load(root, key);
  if (text === null) return { status: 404, error: 'no such layer' };
  if (text.length > LAYER_MAX_CHARS) return { status: 413, error: 'layer over ' + LAYER_MAX_CHARS + ' characters' };
  return { status: 200, text, version: sha(text) };
}

// The versions of the layers that apply to one machine and its groups. An absent, invalid or oversized layer is
// left out, so the caller keeps what it has.
export function layerVersions(root, machine, groups) {
  const keys = ['global'];
  if (machine) keys.push('machine/' + machine);
  for (const g of Array.isArray(groups) ? groups : []) keys.push('group/' + g);
  const out = {};
  for (const k of keys) {
    if (k in out) continue;
    const r = readLayer(root, k);
    if (r.status === 200) out[k] = r.version;
  }
  return out;
}
