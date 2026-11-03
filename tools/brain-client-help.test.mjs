// node --test tools/brain-client-help.test.mjs
// The help printed a "repo" command and the address of one owner's own git server, and the command ran
// tools/repo.mjs, which the engine export never ships (2026-11-02). In a public clone the command and its help line
// must not exist; where repo.mjs is present the command works and the help names the address from brain.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function client({ withRepoTool, brainJson }, ...args) {
  const root = mkdtempSync(join(tmpdir(), 'client-help-'));
  try {
    mkdirSync(join(root, 'tools'));
    for (const m of ['brain-client.mjs', 'provenance.mjs', 'brain-recover.mjs']) copyFileSync(join(HERE, m), join(root, 'tools', m));
    if (withRepoTool) writeFileSync(join(root, 'tools', 'repo.mjs'), 'console.log("repo tool ran: " + process.argv.slice(2).join(" "));\n');
    if (brainJson) writeFileSync(join(root, 'brain.json'), JSON.stringify(brainJson));
    const env = { ...process.env, HAVOK_SERVER_URL: 'https://127.0.0.1:9', HAVOK_SERVER_TOKEN: 'none' };
    const r = spawnSync(process.execPath, [join(root, 'tools', 'brain-client.mjs'), ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a clone without repo.mjs lists no repo command and no git server address', () => {
  const r = client({ withRepoTool: false }, 'help');
  assert.doesNotMatch(r.out, /^\s*repo\b/m, r.out);
  assert.doesNotMatch(r.out, /server\/git/, r.out);
  assert.match(r.out, /read <slug>/, r.out);
});

test('a clone without repo.mjs does not try to run it', () => {
  const r = client({ withRepoTool: false }, 'repo', 'list');
  assert.doesNotMatch(r.out, /repo\.mjs|Cannot find module/, r.out);
  assert.doesNotMatch(r.out, /^\s*repo\b/m, r.out);
});

test('with repo.mjs and a git server in brain.json, the command runs and the help names that address', () => {
  const cfg = { gitServer: { url: 'http://git.example.test/git/' } };
  const help = client({ withRepoTool: true, brainJson: cfg }, 'help');
  assert.match(help.out, /^\s*repo list\|url\|clone\|pull\|push .*http:\/\/git\.example\.test\/git/m, help.out);
  const run = client({ withRepoTool: true, brainJson: cfg }, 'repo', 'list');
  assert.match(run.out, /repo tool ran: list/, run.out);
  assert.equal(run.code, 0, run.out);
});
