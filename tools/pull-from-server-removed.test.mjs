// A file the server sent before and no longer lists leaves the mirror (to .sync-trash/); a file made on the machine
// stays. Found 2026-11-02: two hooks removed on the host stayed on a laptop's mirror, which is its plugin
// source, so every plugin update copied them back. Runs tools/pull-from-server.mjs from a throwaway brain folder
// against a fake server on 127.0.0.1, with a throwaway token folder (HAVOK_HOME), so nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function fakeServer(files, version) {
  const srv = createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === '/dist/version') return res.end(JSON.stringify({ version, files: Object.keys(files).length }));
    if (u === '/dist') return res.end(JSON.stringify({ files: Object.entries(files).map(([path, body]) => ({ path, sha: sha16(body) })) }));
    const p = u.replace(/^\/dist\//, '');
    if (p in files) return res.end(files[p]);
    res.statusCode = 404; res.end('');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

function run(brain, home, port) {
  return new Promise((ok) => execFile(process.execPath, [join(brain, 'tools', 'pull-from-server.mjs')], {
    env: { ...process.env, HAVOK_HOME: home, HAVOK_SERVER_URL: 'http://127.0.0.1:' + port }, windowsHide: true, timeout: 60000,
  }, (err, stdout, stderr) => ok({ code: err ? err.code : 0, out: String(stdout) + String(stderr) })));
}

test('a file the server dropped is moved to .sync-trash; a local file and the kept files stay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pull-removed-'));
  const brain = join(root, 'brain'); const home = join(root, 'home');
  mkdirSync(join(brain, 'tools'), { recursive: true }); mkdirSync(home, { recursive: true });
  copyFileSync(join(HERE, 'pull-from-server.mjs'), join(brain, 'tools', 'pull-from-server.mjs'));
  writeFileSync(join(home, 'havok-server-token'), 'test-token\n');
  const v1 = { 'hooks/keep.mjs': 'keep 1', 'hooks/dropped-rules.mjs': 'old rule' };
  let srv = await fakeServer(v1, 'v1');
  let r = await run(brain, home, srv.address().port);
  srv.close();
  assert.ok(existsSync(join(brain, 'hooks', 'dropped-rules.mjs')), 'first sync delivers both files: ' + r.out);
  writeFileSync(join(brain, 'hooks', 'local-work.mjs'), 'made on this machine');

  srv = await fakeServer({ 'hooks/keep.mjs': 'keep 2' }, 'v2');
  r = await run(brain, home, srv.address().port);
  srv.close();
  assert.equal(existsSync(join(brain, 'hooks', 'dropped-rules.mjs')), false, 'the dropped file left the mirror: ' + r.out);
  assert.equal(readFileSync(join(brain, 'hooks', 'keep.mjs'), 'utf8'), 'keep 2');
  assert.ok(existsSync(join(brain, 'hooks', 'local-work.mjs')), 'a file made on this machine is never touched');
  const trash = join(brain, '.sync-trash');
  const stamps = readdirSync(trash);
  assert.ok(existsSync(join(trash, stamps[0], 'hooks', 'dropped-rules.mjs')), 'moved to .sync-trash, not deleted');
  rmSync(root, { recursive: true, force: true });
});

test('a much shorter list from the server removes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pull-removed-'));
  const brain = join(root, 'brain'); const home = join(root, 'home');
  mkdirSync(join(brain, 'tools'), { recursive: true }); mkdirSync(home, { recursive: true });
  copyFileSync(join(HERE, 'pull-from-server.mjs'), join(brain, 'tools', 'pull-from-server.mjs'));
  writeFileSync(join(home, 'havok-server-token'), 'test-token\n');
  const v1 = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['hooks/f' + i + '.mjs', 'x' + i]));
  let srv = await fakeServer(v1, 'v1');
  await run(brain, home, srv.address().port);
  srv.close();
  srv = await fakeServer({ 'hooks/f0.mjs': 'x0' }, 'v2');
  const r = await run(brain, home, srv.address().port);
  srv.close();
  for (let i = 1; i < 6; i++) assert.ok(existsSync(join(brain, 'hooks', 'f' + i + '.mjs')), 'kept f' + i + ': ' + r.out);
  assert.match(r.out, /NOT removing files the server dropped/);
  rmSync(root, { recursive: true, force: true });
});
