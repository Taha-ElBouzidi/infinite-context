// node --test tools/release-host.test.mjs
// The release host (context release task 18, 2026-11-02): HAVOK publishes a release once on the host (the mod's release
// zip, its version and its sha256), the brain server serves it beside the layers, and the per-message version answers
// (POST /recall/turn and GET /layers/versions) carry the latest release number, so no machine runs a timer to look.
// Unit tests on temp folders, then the routes on a throwaway server (the live one is never touched).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { publishRelease, releaseSummary, releaseManifest, releaseZip, compareVersions, releasePath } from './release-host.mjs';
import { makeRecallTurn } from './recall-turn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
function zipFile(dir, text) {
  const f = join(dir, 'in-' + Math.random().toString(36).slice(2) + '.zip');
  writeFileSync(f, Buffer.from('PK\u0003\u0004' + text));
  return f;
}

test('versions compare as numbers, not as text', () => {
  assert.equal(compareVersions('0.1.12', '0.1.9') > 0, true);
  assert.equal(compareVersions('0.1.12', '0.1.12'), 0);
  assert.equal(compareVersions('0.2.0', '0.10.0') < 0, true);
});

test('publish copies the zip, records its sha256 and size, and makes it the latest', () => {
  const root = tmp('rel-');
  try {
    const z = zipFile(root, 'one');
    const m = publishRelease(root, { zip: z, version: '0.1.12', parts: { mod: '0.1.12', plugin: '0.4.81' }, now: Date.UTC(2026, 10, 2) });
    assert.equal(m.version, '0.1.12');
    assert.equal(m.sha256, sha(readFileSync(z)));
    assert.equal(m.size, readFileSync(z).length);
    assert.deepEqual(m.parts, { mod: '0.1.12', plugin: '0.4.81' });
    assert.deepEqual(releaseSummary(root), { version: '0.1.12', sha256: m.sha256, size: m.size });
    assert.deepEqual(releaseManifest(root, '0.1.12'), m);
    assert.equal(sha(readFileSync(releaseZip(root, '0.1.12'))), m.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publish refuses a version that is not above the latest, a bad version and a missing zip; the latest stays', () => {
  const root = tmp('rel-');
  try {
    publishRelease(root, { zip: zipFile(root, 'a'), version: '0.1.12' });
    assert.throws(() => publishRelease(root, { zip: zipFile(root, 'b'), version: '0.1.12' }), /not above/);
    assert.throws(() => publishRelease(root, { zip: zipFile(root, 'b'), version: '0.1.11' }), /not above/);
    assert.throws(() => publishRelease(root, { zip: zipFile(root, 'b'), version: '../x' }), /version/);
    assert.throws(() => publishRelease(root, { zip: join(root, 'none.zip'), version: '0.1.13' }), /no zip/);
    assert.throws(() => publishRelease(root, { zip: (() => { const f = join(root, 'x.zip'); writeFileSync(f, 'not a zip'); return f; })(), version: '0.1.13' }), /not a zip/);
    assert.equal(releaseSummary(root).version, '0.1.12');
    publishRelease(root, { zip: zipFile(root, 'c'), version: '0.1.13' });
    assert.equal(releaseSummary(root).version, '0.1.13');
    assert.ok(releaseManifest(root, '0.1.12'), 'the previous release stays served, for a rollback');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no release published, or a zip that no longer matches its manifest: no summary, so no machine is told', () => {
  const root = tmp('rel-');
  try {
    assert.equal(releaseSummary(root), null);
    assert.equal(releaseSummary(join(root, 'missing')), null);
    publishRelease(root, { zip: zipFile(root, 'a'), version: '0.1.12' });
    rmSync(releaseZip(root, '0.1.12'));
    assert.equal(releaseSummary(root), null);
    assert.equal(releaseManifest(root, '../0.1.12'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the turn recall answer carries the latest release next to the layer versions, and none without a machine', async () => {
  const root = tmp('rel-turn-');
  try {
    mkdirSync(join(root, 'LAYERS'));
    writeFileSync(join(root, 'LAYERS', 'global.md'), 'g');
    publishRelease(join(root, 'RELEASES'), { zip: zipFile(root, 'a'), version: '0.1.12' });
    const turn = makeRecallTurn({ brain: root, layersDir: join(root, 'LAYERS'), releasesDir: join(root, 'RELEASES'), stateDir: join(root, 'state'), recall: async () => [] });
    const r = await turn({ prompt: 'hello there friend', session: 'sess-r', machine: 'SERVER' });
    assert.equal(r.release.version, '0.1.12');
    assert.match(r.release.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await turn({ prompt: 'hello there friend', session: 'sess-r' })).release, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// ---- the routes, on a throwaway server ----
const MODULES = ['brain-server.mjs', 'brain-git-lock.mjs', 'vault-access.mjs', 'recall-core.mjs', 'recall-graph-worker.mjs', 'tailnet-watch.mjs', 'provenance.mjs', 'tokenize.mjs', 'layers-dist.mjs', 'layer-host.mjs', 'recall-turn.mjs', 'release-host.mjs', 'embed-guard.mjs', 'embed-worker.mjs'];
let root, port, child, token, published;
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(path, headers = {}) {
  return new Promise((ok, fail) => {
    const rq = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { connection: 'close', ...headers } }, (r) => {
      const parts = []; r.on('data', (d) => parts.push(d)); r.on('end', () => { const buf = Buffer.concat(parts); ok({ status: r.statusCode, headers: r.headers, buf, body: buf.toString('utf8') }); });
    });
    rq.on('error', fail); rq.setTimeout(5000, () => rq.destroy(new Error('timeout'))); rq.end();
  });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'release-route-'));
  for (const d of ['tools', 'memory', 'index', 'home']) mkdirSync(join(root, d));
  for (const m of MODULES) copyFileSync(join(HERE, m), join(root, 'tools', m));
  mkdirSync(join(root, 'LAYERS'));
  writeFileSync(join(root, 'LAYERS', 'global.md'), '# Global\n');
  published = publishRelease(join(root, 'RELEASES'), { zip: zipFile(root, 'served'), version: '0.1.12' });
  port = await freePort();
  child = spawn(process.execPath, [join(root, 'tools', 'brain-server.mjs'), '--allow-plaintext'], {
    env: { ...process.env, HAVOK_HOME: join(root, 'home'), HAVOK_SERVER_PORT: String(port), HAVOK_LAYERS_DIR: join(root, 'LAYERS'), HAVOK_RELEASES_DIR: join(root, 'RELEASES') }, windowsHide: true, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) { try { if ((await get('/health')).status === 200) break; } catch { /* starting */ } await sleep(100); }
  token = readFileSync(join(root, 'home', 'havok-server-token'), 'utf8').trim();
});
after(() => { try { child.kill(); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });

test('GET /layers/versions carries the latest release beside the layers, behind the token', async () => {
  assert.equal((await get('/layers/versions?machine=SERVER')).status, 401);
  const v = JSON.parse((await get('/layers/versions?machine=SERVER', { authorization: 'Bearer ' + token })).body);
  assert.equal(typeof v.global, 'string');
  assert.deepEqual(v.release, { version: '0.1.12', sha256: published.sha256, size: published.size });
});

test('GET /release/latest, /release/<v> and /release/<v>.zip serve the manifest and the exact bytes; bad versions are refused', async () => {
  const auth = { authorization: 'Bearer ' + token };
  assert.equal((await get('/release/latest')).status, 401);
  assert.equal((await get('/release/0.1.12.zip')).status, 401);
  assert.deepEqual(JSON.parse((await get('/release/latest', auth)).body), published);
  assert.deepEqual(JSON.parse((await get('/release/0.1.12', auth)).body), published);
  const z = await get('/release/0.1.12.zip', auth);
  assert.equal(z.status, 200);
  assert.equal(sha(z.buf), published.sha256);
  assert.equal(z.headers['content-type'], 'application/zip');
  assert.equal((await get('/release/0.1.99.zip', auth)).status, 404);
  assert.equal((await get('/release/%2E%2E%2Flatest', auth)).status, 400);
  assert.equal((await get('/release/0.1.12/../../vault.json', auth)).status, 400);
});

// /release/<version> answers the manifest and /release/<version>.zip the zip; any other ending is no version at all.
test('a release path is a version, or a version and .zip, nothing else', () => {
  const at = (p) => { const m = releasePath(p); return m && [m.version, m.zip]; };
  assert.deepEqual(at('0.1.2'), ['0.1.2', false]);
  assert.deepEqual(at('0.1.2.zip'), ['0.1.2', true]);
  assert.equal(at('0.1.2Xzip'), null);
  assert.equal(at('0.1.2.zipx'), null);
  assert.equal(at('../0.1.2.zip'), null);
});
