// The release host (context release task 18, 2026-11-02). HAVOK publishes a release once on the host: the mod's release
// zip (its release folder with the built stage and install.ps1, uninstall.ps1, verify.mjs), its version and its
// sha256. The brain server serves it beside the layers, behind the same token and TLS, and the per-message version
// answers (POST /recall/turn and GET /layers/versions) carry the latest release, so a machine learns of a release on
// its next message and nothing runs on a timer to look (feedback_events_not_watchdogs).
//
// Layout of the folder (D:/dev/Havok/RELEASES beside the brain, or HAVOK_RELEASES_DIR):
//   latest.json                           the manifest of the latest release
//   <version>/release.json                each release's manifest, kept, so a machine can roll back to it
//   <version>/havok-release-<version>.zip
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Plain numbers only: the version names a folder and a URL path, so nothing else may reach the disk through it.
export const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// The part of a /release/ path after the prefix: a version (the manifest) or a version and ".zip" (the zip); null for
// anything else. The dot is literal, so "0.1.2Xzip" is not read as the zip of 0.1.2.
export function releasePath(rest) {
  const m = /^(.+?)(\.zip)?$/.exec(String(rest));
  return m && VERSION_RE.test(m[1]) ? { version: m[1], zip: !!m[2] } : null;
}

export const zipName =(version) => 'havok-release-' + version + '.zip';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function readManifest(file) {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (m && VERSION_RE.test(String(m.version)) && SHA_RE.test(String(m.sha256)) && Number.isInteger(m.size)) return m;
  } catch { /* none, or unreadable: treated as none */ }
  return null;
}

export function releaseManifest(root, version) {
  if (!VERSION_RE.test(String(version))) return null;
  return readManifest(join(root, version, 'release.json'));
}

// The zip's path, only when it is there and still the size its manifest says.
export function releaseZip(root, version) {
  const m = releaseManifest(root, version);
  if (!m) return null;
  const f = join(root, version, zipName(version));
  try { return statSync(f).size === m.size ? f : null; } catch { return null; }
}

// What every per-message answer carries: small, read from disk each time like the layer versions (a few hundred
// bytes in the page cache). No release, or a zip gone or changed in size: null, so no machine is told to fetch it.
export function releaseSummary(root) {
  const m = readManifest(join(root, 'latest.json'));
  if (!m || !releaseZip(root, m.version)) return null;
  return { version: m.version, sha256: m.sha256, size: m.size };
}

// Publishes one release. Refused: a bad version, a version not above the latest (a number names one zip for ever, so
// two machines holding the same number hold the same bytes), a missing file, a file that is not a zip.
export function publishRelease(root, { zip, version, parts = {}, now = Date.now() }) {
  if (!VERSION_RE.test(String(version))) throw new Error('bad version "' + String(version).slice(0, 40) + '": expected three numbers like 0.1.12');
  if (!zip || !existsSync(zip)) throw new Error('no zip at ' + zip);
  const buf = readFileSync(zip);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error(zip + ' is not a zip file');
  const latest = readManifest(join(root, 'latest.json'));
  if (latest && compareVersions(version, latest.version) <= 0) throw new Error('version ' + version + ' is not above the latest published release ' + latest.version);
  if (existsSync(join(root, version))) throw new Error('version ' + version + ' was already published once; publish a higher number');
  const manifest = { version, file: zipName(version), sha256: sha(buf), size: buf.length, publishedAt: new Date(now).toISOString(), parts: { mod: version, ...parts } };
  mkdirSync(join(root, version), { recursive: true });
  copyFileSync(zip, join(root, version, zipName(version)));
  if (sha(readFileSync(join(root, version, zipName(version)))) !== manifest.sha256) throw new Error('the copied zip does not match its source');
  writeFileSync(join(root, version, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Renamed into place, so a request between the two writes reads the old latest or the new one, never half a file.
  writeFileSync(join(root, 'latest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
  renameSync(join(root, 'latest.json.tmp'), join(root, 'latest.json'));
  return manifest;
}
