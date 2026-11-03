// node --test tools/recall-turn.test.mjs
// Turn recall on the server (context release, 2026-11-02): POST /recall/turn does what hooks/pre-turn.mjs did on each
// machine (conversation, chunking, translation, the per-session "shown earlier" state) so the mod can ask for it in
// one request. The unit tests use a fake recall; the last test runs a throwaway server on a copy of this brain and
// checks, on 30 real prompts, that the route finds the same memories as the hook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeRecallTurn, contextFromPrevious } from './recall-turn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN = join(HERE, '..');

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'recall-turn-'));
  mkdirSync(join(root, 'index'));
  writeFileSync(join(root, 'index', 'keywords.json'), JSON.stringify({
    terms: { invoice: ['project_invoice', 'reference_billing'], billing: ['reference_billing'], gitea: ['reference_gitea'] },
    descriptions: { project_invoice: 'the invoice project', reference_billing: 'how billing works', reference_gitea: 'our git server', reference_linked: 'a linked one' },
  }));
  mkdirSync(join(root, 'LAYERS', 'machine'), { recursive: true });
  writeFileSync(join(root, 'LAYERS', 'global.md'), 'g');
  writeFileSync(join(root, 'LAYERS', 'machine', 'SERVER.md'), 'm');
  return root;
}
const hit = (slug, how, direct = how !== 'linked') => ({ slug, how, direct, description: 'about ' + slug });

test('earlier lists only memories shown before in that session that still match the message itself', async () => {
  const root = scratch();
  try {
    let next = [hit('reference_gitea', 'both'), hit('reference_billing', 'meaning'), hit('reference_linked', 'linked')];
    const turn = makeRecallTurn({ brain: root, layersDir: join(root, 'LAYERS'), stateDir: join(root, 'state'), recall: async () => next });
    const first = await turn({ prompt: 'how does our git server work', session: 'sess-a', machine: 'SERVER' });
    assert.deepEqual(first.memories.map((m) => [m.slug, m.why]), [['reference_gitea', 'both'], ['reference_billing', 'meaning'], ['reference_linked', 'linked']]);
    next = [hit('reference_gitea', 'keyword'), hit('reference_linked', 'linked'), hit('reference_billing', 'meaning', false), hit('project_invoice', 'keyword')];
    const second = await turn({ prompt: 'and the gitea invoice', session: 'sess-a', machine: 'SERVER' });
    assert.deepEqual(second.memories.map((m) => [m.slug, m.why]), [['project_invoice', 'keyword'], ['reference_gitea', 'earlier']]);
    assert.equal(second.memories[1].description, 'about reference_gitea');
    assert.deepEqual(second.droppedEarlier, ['reference_linked', 'reference_billing']);
    const other = await turn({ prompt: 'and the gitea invoice', session: 'sess-b', machine: 'SERVER' });
    assert.ok(other.memories.every((m) => m.why !== 'earlier'), 'another session has its own state');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// No fixed count (The owner, feedback_recall_is_limitless): every earlier memory that still matches the current message
// stays, best match first; only the ones that no longer match it directly are dropped (HAVOK, 2026-11-02).
test('every earlier memory that still matches comes back, the best matches first; no count cap', async () => {
  const root = scratch();
  try {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...hit('reference_m' + i, 'meaning'), match: +(0.3 + i * 0.01).toFixed(2) }));
    const next = many;
    const turn = makeRecallTurn({ brain: root, layersDir: join(root, 'LAYERS'), stateDir: join(root, 'state'), recall: async () => next });
    await turn({ prompt: 'first message here', session: 'sess-cap' });
    const r = await turn({ prompt: 'second message here', session: 'sess-cap' });
    const earlier = r.memories.filter((m) => m.why === 'earlier').map((m) => m.slug);
    assert.equal(earlier.length, 14);
    assert.deepEqual(earlier.slice(0, 3), ['reference_m13', 'reference_m12', 'reference_m11']);
    assert.deepEqual(r.droppedEarlier, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('embedder down: keyword results from the index and a note that says so', async () => {
  const root = scratch();
  try {
    const turn = makeRecallTurn({ brain: root, layersDir: join(root, 'LAYERS'), stateDir: join(root, 'state'), recall: async () => { throw new Error('embedder failed to load'); } });
    const r = await turn({ prompt: 'the billing invoice', session: 'sess-c', machine: 'SERVER' });
    assert.deepEqual(r.memories.map((m) => [m.slug, m.why]), [['reference_billing', 'keyword'], ['project_invoice', 'keyword']]);
    assert.match(r.note, /keyword only/i);
    assert.match(r.note, /embedder failed to load/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the answer carries the layer versions when the request names a machine, and none otherwise', async () => {
  const root = scratch();
  try {
    const turn = makeRecallTurn({ brain: root, layersDir: join(root, 'LAYERS'), stateDir: join(root, 'state'), recall: async () => [] });
    const r = await turn({ prompt: 'hello there friend', session: 'sess-d', machine: 'SERVER', groups: ['none'] });
    assert.deepEqual(Object.keys(r.layers), ['global', 'machine/SERVER']);
    assert.equal((await turn({ prompt: 'hello there friend', session: 'sess-d' })).layers, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a system notification gets no recall', async () => {
  const root = scratch();
  try {
    let called = false;
    const turn = makeRecallTurn({ brain: root, layersDir: join(root, 'LAYERS'), stateDir: join(root, 'state'), recall: async () => { called = true; return [hit('reference_gitea', 'both')]; } });
    const r = await turn({ prompt: '<task-notification>done</task-notification>', session: 'sess-e' });
    assert.deepEqual([r.memories, called], [[], false]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the conversation is read the way the hook reads it: short and harness lines skipped, the last 700 characters', () => {
  assert.equal(contextFromPrevious(['ok', 'BRAIN RECALL: noise here', 'a real earlier question about the git server']), 'a real earlier question about the git server');
  assert.equal(contextFromPrevious(['x'.repeat(500), 'y'.repeat(500)]).length, 700);
  assert.equal(contextFromPrevious(undefined), '');
});

// ---- the same memories as the hook, on 30 real prompts --------------------------------------------------------
let root, home, port, child, token;
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(path, body, timeout = 120000) {
  return new Promise((ok, fail) => {
    const b = JSON.stringify(body);
    const rq = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), connection: 'close' } }, (r) => {
      let t = ''; r.setEncoding('utf8'); r.on('data', (d) => { t += d; }); r.on('end', () => ok({ status: r.statusCode, body: JSON.parse(t || '{}') }));
    });
    rq.on('error', fail); rq.setTimeout(timeout, () => rq.destroy(new Error('timeout'))); rq.end(b);
  });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'recall-turn-e2e-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  for (const d of ['hooks', 'tools', 'index', 'memory']) cpSync(join(BRAIN, d), join(root, d), { recursive: true, filter: (s) => !/node_modules|[\\/]\.git[\\/]?$/.test(s) });
  const ROOT_FILES = ['REFLEX.md', 'brain.json'];
  for (const f of ROOT_FILES) if (existsSync(join(BRAIN, f))) cpSync(join(BRAIN, f), join(root, f));
  if (existsSync(join(BRAIN, 'node_modules'))) execFileSync('cmd', ['/c', 'mklink', '/J', join(root, 'node_modules'), join(BRAIN, 'node_modules')], { windowsHide: true, stdio: 'ignore' });
  port = await freePort();
  writeFileSync(join(root, 'server-endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:' + port }));
  child = spawn(process.execPath, [join(root, 'tools', 'brain-server.mjs'), '--allow-plaintext'], {
    env: { ...process.env, HAVOK_HOME: home, HAVOK_SERVER_PORT: String(port), HAVOK_LAYERS_DIR: join(root, 'LAYERS') }, windowsHide: true, stdio: 'ignore',
  });
  for (let i = 0; i < 200 && !existsSync(join(home, 'havok-server-token')); i += 1) await sleep(100);
  token = readFileSync(join(home, 'havok-server-token'), 'utf8').trim();
  writeFileSync(join(home, '.claude', 'havok-server-token'), token);
  // Warm: the first recall loads the model and builds the snapshot, which the hook's 9 s cap would not wait for.
  for (let i = 0; i < 300; i += 1) { try { if ((await post('/recall', { prompt: 'warm up the model' })).status === 200) break; } catch { /* starting */ } await sleep(200); }
});
after(() => { try { child.kill(); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });

function hookSlugs(prompt, previous) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, HAVOK_BRAIN: root };
  const out = execFileSync(process.execPath, [join(root, 'hooks', 'pre-turn.mjs')], {
    input: JSON.stringify({ prompt, context: contextFromPrevious(previous), session_id: 'fixture-session' }), env, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  const text = JSON.parse(out).hookSpecificOutput.additionalContext;
  const slugs = new Set();
  for (const line of text.split('\n')) {
    const m = /^- \[(?:both|keyword|meaning|linked)\] ([A-Za-z0-9_-]+):/.exec(line);
    if (m) slugs.add(m[1]);
    const e = /^- shown earlier in this conversation, still relevant: (.*)$/.exec(line);
    if (e) for (const s of e[1].split(', ')) slugs.add(s.trim());
  }
  return slugs;
}

test('POST /recall/turn finds the same memories as hooks/pre-turn.mjs on 30 real prompts', { timeout: 600000 }, async () => {
  const { cases } = JSON.parse(readFileSync(join(HERE, 'recall-turn-prompts.json'), 'utf8'));
  assert.equal(cases.length, 30);
  for (const c of cases) {
    const old = hookSlugs(c.prompt, c.previous);
    const r = await post('/recall/turn', { prompt: c.prompt, previous: c.previous, session: 'fixture-session', machine: 'SERVER', agent: 'test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const now = new Set([...r.body.memories.map((m) => m.slug), ...r.body.droppedEarlier]);
    assert.deepEqual([...now].sort(), [...old].sort(), c.prompt.slice(0, 60));
    for (const m of r.body.memories) if (m.why === 'earlier') assert.ok(old.has(m.slug));
  }
});
