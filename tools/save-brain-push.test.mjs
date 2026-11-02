// node --test tools/save-brain-push.test.mjs
// A clone of the public repository has the public repository as its origin, so "git push origin HEAD" after every save
// sent the person's memories to the upstream engine repository, and a public fork as origin would publish them
// (2026-11-02). In an install the save pushes only to the backup remote the person names in brain.json
// ("backupRemote", a remote name or address), never to origin by default, and otherwise says in one line that it
// committed without pushing. The owner's own brain is not an install and pushes to origin as before. Runs a copy of
// save-brain.mjs in a throwaway repo with local bare remotes standing in for the public repository and the person's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function runSave({ name, origin, repository, backup, ignore = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'save-push-'));
  try {
    const repo = join(root, 'repo');
    const remotes = { upstream: join(root, 'upstream.git'), mine: join(root, 'mine.git') };
    const git = (...a) => execFileSync('git', a, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const r of Object.values(remotes)) execFileSync('git', ['init', '-q', '--bare', r], { windowsHide: true });
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'save@test.invalid');
    git('config', 'user.name', 'save test');
    for (const d of ['tools', 'memory', 'index', 'provenance']) mkdirSync(join(repo, d));
    for (const m of ['save-brain.mjs', 'brain-git-lock.mjs']) copyFileSync(join(HERE, m), join(repo, 'tools', m));
    writeFileSync(join(repo, 'tools', 'build-index.mjs'), 'process.exit(0);\n');
    writeFileSync(join(repo, 'tools', 'reflect.mjs'), 'console.log("Total findings: 0");\n');
    writeFileSync(join(repo, 'index', 'k.json'), '{}\n');
    writeFileSync(join(repo, 'provenance', 'ledger.jsonl'), '\n');
    writeFileSync(join(repo, 'MANIFEST.md'), 'm\n');
    writeFileSync(join(repo, '.gitignore'), '.save-brain.log\nbrain.json\n' + ignore);
    if (backup) writeFileSync(join(repo, 'brain.json'), JSON.stringify({ backupRemote: backup(remotes) }) + '\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, repository: { type: 'git', url: repository(remotes) } }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    if (origin) {
      git('remote', 'add', 'origin', remotes[origin]);
      git('push', '-q', 'origin', 'HEAD');
    }
    writeFileSync(join(repo, 'memory', 'reference_x.md'), '---\nname: x\n---\nbody\n');
    const p = spawnSync(process.execPath, [join(repo, 'tools', 'save-brain.mjs'), '--worker', 'probe save'], { cwd: repo, windowsHide: true, stdio: 'ignore', timeout: 120000 });
    const received = (r) => execFileSync('git', ['--git-dir', remotes[r], 'log', '--all', '--format=%s'], { windowsHide: true, encoding: 'utf8' });
    return {
      code: p.status,
      log: readFileSync(join(repo, '.save-brain.log'), 'utf8'),
      head: git('log', '-1', '--format=%s').trim(),
      upstream: received('upstream'),
      mine: received('mine'),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('an install whose origin is the public repository commits and does not push there', () => {
  const r = runSave({ name: 'infinite-context', origin: 'upstream', repository: (x) => x.upstream });
  assert.equal(r.head, 'probe save', r.log);
  assert.doesNotMatch(r.upstream, /probe save/, 'the memory commit reached the public repository');
  assert.match(r.log, /committed, not pushed: no backup remote/, r.log);
  assert.equal(r.code, 0, r.log);
});

test('an install never pushes to origin by default, even a repository of its own (a public fork would publish it)', () => {
  const r = runSave({ name: 'infinite-context', origin: 'mine', repository: (x) => x.upstream });
  assert.doesNotMatch(r.mine, /probe save/, r.log);
  assert.match(r.log, /committed, not pushed: no backup remote/, r.log);
  assert.equal(r.code, 0, r.log);
});

test('an install pushes to the backup remote named in brain.json, by address', () => {
  const r = runSave({ name: 'infinite-context', origin: 'upstream', repository: (x) => x.upstream, backup: (x) => x.mine });
  assert.match(r.mine, /probe save/, r.log);
  assert.doesNotMatch(r.upstream, /probe save/, r.log);
  assert.match(r.log, /done: probe save/, r.log);
});

test('a backup remote that is the public repository is refused, however it is spelled', () => {
  const r = runSave({ name: 'infinite-context', origin: 'mine', repository: (x) => 'git+' + x.upstream + '/', backup: (x) => x.upstream });
  assert.doesNotMatch(r.upstream, /probe save/, 'the memory commit reached the public repository');
  assert.match(r.log, /committed, not pushed: the backup remote is the public Infinite Context repository/, r.log);
});

test('an install with no remote at all commits and says so in one line', () => {
  const r = runSave({ name: 'infinite-context', origin: null, repository: (x) => x.upstream });
  assert.equal(r.head, 'probe save', r.log);
  assert.match(r.log, /committed, not pushed/, r.log);
  assert.equal(r.code, 0, r.log);
});

test('a brain that is not an install pushes to origin as before', () => {
  const r = runSave({ name: 'my-brain', origin: 'upstream', repository: (x) => x.upstream });
  assert.match(r.upstream, /probe save/, r.log);
  assert.match(r.log, /done: probe save/, r.log);
});

// An install ignores index/ and MANIFEST.md (its .gitignore), and git add refuses a named path that is ignored, so
// every save in an install failed before it committed (clean-install test, 2026-11-02).
test('an install that ignores index/ and MANIFEST.md still commits the memory', () => {
  const r = runSave({ name: 'infinite-context', origin: 'upstream', repository: (x) => x.upstream, ignore: 'index/\nMANIFEST.md\n' });
  assert.equal(r.head, 'probe save', r.log);
  assert.match(r.log, /committed, not pushed/, r.log);
});
