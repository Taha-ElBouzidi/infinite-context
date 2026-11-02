// The "fake off": the recall note said "semantic recall is OFF (embed server not running)" while the embed
// daemon was healthy (The owner, 2026-10-31: "these fake off happen a lot we should diagnose them").
//
// WHY. 54 of 3175 recall turns on the host carried that note, 2026-08-21 to 2026-10-31. The live cases traced
// that day: the brain server took 17.7 s on its first recall after the index changed (it rebuilds its link
// graph and rereads every memory, synchronously), the hook gave up at 9 s and marked the server down for 3
// minutes, and the local daemon could not stand in because its alive marker had been deleted by a session
// start whose /health probe found it busy. The note then named the one thing that was fine.
//
// Runs the REAL hooks/pre-turn.mjs, payload on stdin, against stub servers in their own processes, with
// HOME pointed at a temporary folder so no down mark or marker of this machine is touched. Also runs the
// exact text of the marker check in hooks/check-session-start.mjs. About 15 s, most of it the one case that
// waits for the 9 s timeout.
import { spawn, spawnSync, execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = mkdtempSync(join(tmpdir(), 'havok-recall-note-'));
const SB = join(T, 'brain');
const HOME = join(T, 'home');
const CFG = join(HOME, '.claude');
mkdirSync(join(SB, 'memory'), { recursive: true });
mkdirSync(CFG, { recursive: true });
cpSync(join(BRAIN, 'index'), join(SB, 'index'), { recursive: true });
writeFileSync(join(SB, 'REFLEX.md'), '# test brain\n');
writeFileSync(join(SB, 'memory', 'reference_test_only.md'), '---\nname: test only\n---\nbody\n');
// A machine that runs its own daemon. No tools/embed-server.mjs here, so the hook can never start a real one.
mkdirSync(join(SB, 'node_modules', '@xenova', 'transformers'), { recursive: true });
writeFileSync(join(CFG, 'havok-server-token'), 'test-token-not-a-secret');
const DOWN = join(CFG, 'havok-remote-embed-down');
const ALIVE = join(CFG, 'havok-embed.alive');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  process.stdout.write((ok ? 'ok    ' : 'FAIL  ') + name + (ok || !detail ? '' : ' | ' + detail) + '\n');
};

const STUB = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const [mode, log] = process.argv.slice(2);
const srv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    appendFileSync(log, req.method + ' ' + req.url + '\\n');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const heavy = req.url === '/recall' || req.url === '/embed';
    if (mode === 'server-slow') return heavy ? setTimeout(() => send(200, { ranked: [] }), 10000) : send(200, { ok: true });
    if (mode === 'server-ok') return send(200, req.url === '/recall' ? { ranked: [{ slug: 'from_the_server', how: 'both', description: 'server hit' }] } : { ok: true });
    if (mode === 'server-429') return send(429, { error: 'too many requests' });
    if (mode === 'daemon-ok') return send(200, req.url === '/recall' ? { ranked: [{ slug: 'from_the_daemon', how: 'meaning', description: 'daemon hit' }] } : { ok: true, recall: true });
    if (mode === 'daemon-busy') return setTimeout(() => send(200, { ok: true }), 4000);
    send(500, { error: 'unknown mode' });
  });
});
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\\n'));
`;
const stubFile = join(T, 'stub.mjs');
writeFileSync(stubFile, STUB);
const children = [];
function startStub(mode) {
  const log = join(T, mode + '.log');
  writeFileSync(log, '');
  const child = spawn(process.execPath, [stubFile, mode, log], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  children.push(child);
  return new Promise((res) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) res({ port: Number(out.trim()), log }); });
  });
}
function closedPort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function runHook(serverPort, daemonPort, prompt = 'why does recall say the embed server is off when the daemon is running fine') {
  writeFileSync(join(SB, 'server-endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:' + serverPort }));
  const env = { ...process.env, USERPROFILE: HOME, HOME, HAVOK_HOME: CFG, HAVOK_BRAIN: SB, HAVOK_MACHINE_NAME: 'TEST', HAVOK_EMBED_PORT: String(daemonPort) };
  const payload = JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit', session_id: 'test-recall-note' });
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(BRAIN, 'hooks', 'pre-turn.mjs')], { input: payload, encoding: 'utf8', env, timeout: 20000, windowsHide: true });
  let ctx = '';
  try { ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput.additionalContext || ''; } catch { /* stays empty */ }
  const note = ctx.split('\n').filter((l) => /^NOTE:/.test(l)).join(' | ');
  return { ctx, note, ms: Date.now() - t };
}
const mark = (reason) => writeFileSync(DOWN, JSON.stringify({ at: Date.now(), reason }), 'utf8');
const clear = () => { for (const f of [DOWN, ALIVE]) { try { unlinkSync(f); } catch { /* absent */ } } };
const said = (r) => 'took ' + r.ms + ' ms, note: ' + (r.note || '(none)');

try {
  const slow = await startStub('server-slow');
  const ok = await startStub('server-ok');
  const r429 = await startStub('server-429');
  const daemon = await startStub('daemon-ok');
  const busy = await startStub('daemon-busy');
  const nothing = await closedPort();

  // 1. The server is busy past 9 s. The daemon is healthy, its marker gone.
  clear();
  let r = runHook(slow.port, daemon.port);
  check('busy server: recall still arrives', /BRAIN RECALL/.test(r.ctx), said(r));
  check('busy server: never says the embed server is not running', !/not running/i.test(r.ctx), said(r));
  check('busy server: says the server did not answer within 9 s', /did not answer within 9 s/.test(r.note), said(r));
  check('busy server: the hook stays inside its 10 s limit', r.ms < 10000, said(r));

  // 2. The next message, inside the 3 minute down mark. The daemon stands in.
  r = runHook(slow.port, daemon.port);
  check('next message: the healthy daemon answers instead', /from_the_daemon/.test(r.ctx), said(r));
  check('next message: no degraded note, recall was semantic', !/semantic recall (is OFF|missed)/.test(r.ctx), said(r));
  check('next message: fast, the skipped server costs nothing', r.ms < 4000, said(r));

  // 3. Same, but the daemon is busy (listening, slow to answer).
  clear(); mark('recall failed: timed out (connect or answer)');
  r = runHook(slow.port, busy.port);
  check('busy daemon: never says it is not running', !/not running/i.test(r.ctx), said(r));
  check('busy daemon: says it is busy', /busy/.test(r.note), said(r));
  check('busy daemon: says why the brain server was not used', /brain server/.test(r.note), said(r));

  // 4. The daemon really is down: then, and only then, say so.
  clear(); mark('recall failed: timed out (connect or answer)');
  r = runHook(slow.port, nothing);
  check('daemon down: says the embed server is not running', /embed server is not running/.test(r.note), said(r));
  check('daemon down: also says why the brain server was not used', /brain server/.test(r.note), said(r));
  check('daemon down: the probe stays cheap', r.ms < 4000, said(r));

  // 5. The server refuses as rate limited and the daemon is down.
  clear();
  r = runHook(r429.port, nothing);
  check('rate limited: says so', /rate limited/.test(r.note), said(r));

  // 6. A healthy turn touches nothing else.
  clear();
  writeFileSync(daemon.log, '');
  r = runHook(ok.port, daemon.port);
  check('healthy server: its answer is used', /from_the_server/.test(r.ctx), said(r));
  check('healthy server: no note', !/^NOTE: semantic/m.test(r.ctx), said(r));
  check('healthy server: the local daemon is not asked anything', readFileSync(daemon.log, 'utf8').trim() === '', readFileSync(daemon.log, 'utf8').trim());

  // 7. Marker present, server skipped: the daemon is used as before.
  clear(); mark('recall failed: timed out (connect or answer)'); writeFileSync(ALIVE, '1');
  r = runHook(slow.port, daemon.port);
  check('marker present: the daemon answers', /from_the_daemon/.test(r.ctx), said(r));

  // 7b. A system event skips recall on purpose. On a machine with no embeddings index of its own (every plugin-only
  //     install) the dense step still ran and printed "semantic recall missed", blaming the brain server (audit
  //     2026-11-01).
  clear();
  const embFile = join(SB, 'index', 'embeddings.json');
  const embKeep = readFileSync(embFile);
  unlinkSync(embFile);
  try { r = runHook(ok.port, nothing, '<task-notification>a helper finished</task-notification>'); } finally { writeFileSync(embFile, embKeep); }
  check('system event: no false "semantic recall missed" note', !/semantic recall missed/.test(r.ctx), said(r));

  // 8. The session-start marker check, its exact text: a busy daemon keeps its marker; a dead one loses it.
  const src = readFileSync(join(BRAIN, 'hooks', 'check-session-start.mjs'), 'utf8');
  const b = src.indexOf('// BEGIN embedMarkerCheck');
  const e = src.indexOf('// END embedMarkerCheck');
  check('check-session-start has its marker check between BEGIN and END markers', b >= 0 && e > b);
  if (b >= 0 && e > b) {
    const body = src.slice(b, e);
    const LF = String.fromCharCode(10);
    const runIn = (cwd, cmd, ms) => {
      try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }).trim(), err: '', stderr: '' }; }
      catch (x) { const stderr = String((x && x.stderr) || '').trim(); return { ok: false, out: '', err: stderr.split(LF)[0] || '', stderr, status: x && x.status }; }
    };
    const verdict = (port) => {
      writeFileSync(ALIVE, '1');
      const prev = process.env.HAVOK_EMBED_PORT;
      process.env.HAVOK_EMBED_PORT = String(port);
      try {
        const fn = new Function('resolve', 'join', 'homedir', 'existsSync', 'unlinkSync', 'runIn', 'execFileSync', 'BRAIN', body + '\nreturn running;');
        const running = fn(resolve, join, () => HOME, existsSync, unlinkSync, runIn, execFileSync, SB);
        return { running, marker: existsSync(ALIVE) };
      } finally { process.env.HAVOK_EMBED_PORT = prev; }
    };
    let v = verdict(daemon.port);
    check('session start, healthy daemon: marker kept', v.running && v.marker, JSON.stringify(v));
    v = verdict(busy.port);
    check('session start, busy daemon: marker kept and no second daemon started', v.running && v.marker, JSON.stringify(v));
    v = verdict(nothing);
    check('session start, nothing listening: marker removed so the daemon is restarted', !v.running && !v.marker, JSON.stringify(v));
  }
} finally {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { rmSync(T, { recursive: true, force: true }); } catch { /* a stub still holding a log on Windows */ }
}
process.stdout.write((failures ? 'FAILED: ' + failures : 'PASSED') + '\n');
process.exit(failures ? 1 : 0);
