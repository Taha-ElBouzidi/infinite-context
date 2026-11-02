// node --test tools/save-brain-lock.test.mjs
// Audit 2026-11-01. The WARN step added to save-brain.mjs that day runs reflect.mjs (18 s on the host, measured) while
// the save still held the shared brain write lock, so every other writer (memory queue, vault store, other saves)
// waited 18 s more per save for a report that only reads. Runs a copy of save-brain.mjs in a throwaway repo with a
// local bare remote; build-index and reflect are stand-ins, reflect taking 3 s and reporting one finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_REFLECT = 'setTimeout(() => console.log("## Broken wikilinks (1)\\n  a -> b\\n\\nTotal findings: 1"), 3000);\n';

async function runSave(reflectSource) {
  const root = mkdtempSync(join(tmpdir(), 'save-lock-'));
  try {
    const repo = join(root, 'repo');
    const git = (...a) => execFileSync('git', a, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['init', '-q', '--bare', join(root, 'remote.git')], { windowsHide: true });
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'save@test.invalid');
    git('config', 'user.name', 'save test');
    for (const d of ['tools', 'memory', 'index', 'provenance']) mkdirSync(join(repo, d));
    for (const m of ['save-brain.mjs', 'brain-git-lock.mjs']) copyFileSync(join(HERE, m), join(repo, 'tools', m));
    writeFileSync(join(repo, 'tools', 'build-index.mjs'), 'process.exit(0);\n');
    writeFileSync(join(repo, 'tools', 'reflect.mjs'), reflectSource);
    writeFileSync(join(repo, 'index', 'k.json'), '{}\n');
    writeFileSync(join(repo, 'provenance', 'ledger.jsonl'), '\n');
    writeFileSync(join(repo, 'MANIFEST.md'), 'm\n');
    writeFileSync(join(repo, '.gitignore'), '.save-brain.log\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('remote', 'add', 'origin', join(root, 'remote.git'));
    git('push', '-q', 'origin', 'HEAD');
    writeFileSync(join(repo, 'memory', 'reference_x.md'), '---\nname: x\n---\nbody\n');

    const lock = join(repo, '.git', 'havok-write.lock');
    const p = spawn(process.execPath, [join(repo, 'tools', 'save-brain.mjs'), '--worker', 'probe save'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    let exitedAt = 0;
    p.on('exit', () => { exitedAt = Date.now(); });
    let sawLock = false;
    let releasedAt = 0;
    while (!exitedAt) {
      const held = existsSync(lock);
      if (held) sawLock = true;
      if (sawLock && !held && !releasedAt) releasedAt = Date.now();
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!releasedAt) releasedAt = exitedAt;
    return { log: readFileSync(join(repo, '.save-brain.log'), 'utf8'), sawLock, heldMsBeforeExit: exitedAt - releasedAt };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('the brain write lock is released before the WARN report runs, and the WARN is still written', async () => {
  const r = await runSave(DEFAULT_REFLECT);
  assert.match(r.log, /done: probe save/, r.log);
  assert.match(r.log, /WARN .*brain has 1 finding/, r.log);
  assert.ok(r.sawLock, 'the save never took the lock');
  assert.ok(r.heldMsBeforeExit >= 2000, 'the lock was held until ' + r.heldMsBeforeExit + ' ms before exit, through the 3 s report');
});

test('the WARN names the save it follows', async () => {
  const r = await runSave(DEFAULT_REFLECT);
  assert.match(r.log, /WARN after "probe save"/, r.log);
});

// Index drift after a save is almost always the next save's memory, written but not indexed yet: all three WARN
// lines logged on 2026-11-01 before this audit were that, and each read as the saving agent's own problem.
test('index drift alone is not reported as a problem', async () => {
  const r = await runSave('console.log("## Index drift (2)\\n  memory/MEMORY.md differs\\n\\n## Broken wikilinks (0)\\n\\nTotal findings: 2");\n');
  assert.match(r.log, /done: probe save/, r.log);
  assert.doesNotMatch(r.log, /WARN/, r.log);
});
