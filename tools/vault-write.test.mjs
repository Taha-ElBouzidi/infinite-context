// node --test tools/vault-write.test.mjs
// Audit 2026-11-01 (the owner: "audit all of this code ... and harden it the max possible"). vault.mjs rewrote vault.json
// in place with no lock: two stores in the same second lost one secret while both callers were told "stored", and a
// reader (the server's /vault/list, a get) could catch the file half written. Runs on a throwaway copy of vault.mjs
// with throwaway age keys; the real vault and the real keys are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function sandbox(machines) {
  const root = mkdtempSync(join(tmpdir(), 'vault-write-'));
  mkdirSync(join(root, 'tools'));
  copyFileSync(join(HERE, 'vault.mjs'), join(root, 'tools', 'vault.mjs'));
  const home = join(root, 'home');
  mkdirSync(home);
  const reg = { version: 1, machines: {} };
  for (let i = 0; i < machines; i += 1) {
    const key = execFileSync('age-keygen', [], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (i === 0) writeFileSync(join(home, 'havok-age-key.txt'), key);
    const pub = key.split(/\r?\n/).find((l) => l.startsWith('# public key:')).split(':')[1].trim();
    reg.machines['M' + i] = { pubkey: pub, added: '2026-11-01' };
  }
  writeFileSync(join(root, 'vault-recipients.json'), JSON.stringify(reg));
  writeFileSync(join(root, 'vault.json'), JSON.stringify({ version: 2, secrets: {} }));
  return { root, file: join(root, 'vault.json'), env: { ...process.env, HAVOK_HOME: home, HAVOK_MACHINE_NAME: 'M0' } };
}

function vault(sb, args, input) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(sb.root, 'tools', 'vault.mjs'), ...args], { env: sb.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => ok({ code, out, err }));
    p.stdin.end(input || '');
  });
}

test('six stores at the same moment keep all six secrets', async () => {
  const sb = sandbox(5);
  try {
    const names = [1, 2, 3, 4, 5, 6].map((i) => 'probe_' + i);
    const runs = await Promise.all(names.map((n, i) => vault(sb, ['set', n], 'test-value-' + i)));
    for (const r of runs) assert.equal(r.code, 0, r.err);
    const v = JSON.parse(readFileSync(sb.file, 'utf8'));
    assert.deepEqual(Object.keys(v.secrets).sort(), [...names].sort());
    for (const [i, n] of names.entries()) assert.equal((await vault(sb, ['get', n])).out, 'test-value-' + i);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('a reader never sees a half written vault.json', async () => {
  const sb = sandbox(1);
  try {
    // A large file makes the write window wide enough to land a read inside it.
    writeFileSync(sb.file, JSON.stringify({ version: 2, secrets: { pad: { keys: {}, updated: '2026-11-01', note: 'x'.repeat(6e6) } } }));
    let torn = 0;
    let done = false;
    const reader = (async () => {
      while (!done) {
        try { JSON.parse(readFileSync(sb.file, 'utf8')); } catch { torn += 1; }
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 8; i += 1) assert.equal((await vault(sb, ['set', 'probe_t' + i], 'v' + i)).code, 0);
    done = true;
    await reader;
    assert.equal(torn, 0, torn + ' read(s) caught vault.json half written');
    assert.deepEqual(readdirSync(sb.root).filter((f) => /\.tmp$|\.lock$/.test(f)), [], 'no temp or lock file left behind');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('set --new never replaces an existing secret, even one stored a moment ago', async () => {
  const sb = sandbox(1);
  try {
    assert.equal((await vault(sb, ['set', 'probe_x'], 'first')).code, 0);
    const again = await vault(sb, ['set', 'probe_x', '--new'], 'second');
    assert.equal(again.code, 3, 'exit 3 means it already exists');
    assert.equal((await vault(sb, ['get', 'probe_x'])).out, 'first');
    assert.equal((await vault(sb, ['set', 'probe_y', '--new'], 'fresh')).code, 0);
    assert.equal((await vault(sb, ['get', 'probe_y'])).out, 'fresh');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});
