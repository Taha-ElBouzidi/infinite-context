// node --test tools/brain-recover.test.mjs
// tools/brain-recover.mjs with a fake server (a real HTTP listener that answers, refuses or hangs) and a fake clock.
// Nothing here restarts a real process: restart is a stand-in that flips the fake server back to healthy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recover, probeHealth, writeAlert, MAX_PER_HOUR, certRefusal, restartScript, TARGETS } from './brain-recover.mjs';

let server, url, mode = 'ok';
before(async () => {
  server = createServer((req, res) => {
    if (mode === 'hang') return; // holds the connection open and never answers, like the frozen server
    if (mode === 'error') { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  url = 'http://127.0.0.1:' + server.address().port + '/health';
});
after(() => { server.closeAllConnections(); server.close(); });

function rig({ enabled = true, restarts = [], fixes = true } = {}) {
  let clock = Date.parse('2026-11-02T20:40:00Z');
  const rows = [], alerts = [];
  let restartCalls = 0;
  return {
    rows, alerts, get restartCalls() { return restartCalls; },
    args: (what = 'brain') => ({
      what, why: 'recall failed: no answer in 9 s', enabled,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      probe: async () => { const r = await probeHealth(url, { timeoutMs: 300 }); clock += r.ms; return r; },
      restart: async () => { restartCalls += 1; if (fixes) mode = 'ok'; return { done: 'fake' }; },
      state: { restarts: { [what]: restarts } },
      log: (row) => rows.push(row),
      alert: (id, text) => alerts.push({ id, text }),
    }),
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

test('a server that answers /health is left alone', async () => {
  mode = 'ok';
  const r = rig();
  assert.equal(await recover(r.args()), 'healthy');
  assert.equal(r.restartCalls, 0);
  assert.equal(r.rows[0].action, 'none');
});

test('one answer out of the probes is enough: a blip does not restart', async () => {
  mode = 'hang';
  const r = rig();
  const a = r.args();
  let n = 0;
  const realProbe = a.probe;
  a.probe = async () => { n += 1; if (n === 2) mode = 'ok'; return realProbe(); };
  assert.equal(await recover(a), 'healthy');
  assert.equal(r.restartCalls, 0);
});

test('a server that hangs on /health is restarted, logged with /health before and after', async () => {
  mode = 'hang';
  const r = rig();
  const a = r.args();
  assert.equal(await recover(a), 'restarted');
  assert.equal(r.restartCalls, 1);
  const row = r.rows.at(-1);
  assert.equal(row.action, 'restarted');
  assert.equal(row.before.length, 3);
  assert.ok(row.before.every((p) => !p.ok && /no answer/.test(p.error)), JSON.stringify(row.before));
  assert.equal(row.after.at(-1).ok, true);
  assert.equal(row.up, true);
  assert.equal(a.state.restarts.brain.length, 1);
  assert.equal(r.alerts.length, 0);
});

test('at most ' + MAX_PER_HOUR + ' restarts an hour, then an alert and no restart', async () => {
  mode = 'error';
  const r = rig();
  const state = { restarts: { brain: [] } };
  for (let i = 0; i < MAX_PER_HOUR; i++) {
    mode = 'error';
    const a = r.args(); a.state = state;
    assert.equal(await recover(a), 'restarted');
    r.advance(5 * 60 * 1000);
  }
  mode = 'error';
  const a = r.args(); a.state = state;
  assert.equal(await recover(a), 'capped');
  assert.equal(r.restartCalls, MAX_PER_HOUR);
  assert.equal(r.alerts.at(-1).id, 'recover-capped-brain');
  assert.match(r.alerts.at(-1).text, /NOT restarted/);
  // An hour after the first restart the window has room again.
  r.advance(60 * 60 * 1000);
  mode = 'error';
  const b = r.args(); b.state = state;
  assert.equal(await recover(b), 'restarted');
});

test('the cap is per server: the embed server can restart while the brain is capped', async () => {
  mode = 'error';
  const r = rig();
  const t = r.now();
  const a = r.args('embed');
  a.state = { restarts: { brain: [t - 1000, t - 2000, t - 3000], embed: [] } };
  assert.equal(await recover(a), 'restarted');
});

test('a restart that does not bring /health back raises an alert', async () => {
  mode = 'error';
  const r = rig({ fixes: false });
  assert.equal(await recover(r.args()), 'restart-failed');
  assert.equal(r.alerts.at(-1).id, 'recover-failed-brain');
  assert.equal(r.rows.at(-1).up, false);
});

test('switched off: it confirms and logs what it would do, and restarts nothing', async () => {
  mode = 'hang';
  const r = rig({ enabled: false });
  assert.equal(await recover(r.args()), 'disabled');
  assert.equal(r.restartCalls, 0);
  assert.equal(r.rows.at(-1).action, 'would-restart');
});

test('an alert joins the analyzer file without dropping its alerts or first-seen times', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-alert-'));
  try {
    const f = join(dir, '.brain-alerts.json');
    writeFileSync(f, JSON.stringify({ generated: 'x', alerts: { slow: { text: 'slow', firstSeen: 'a', lastSeen: 'a' } } }));
    writeAlert(f, 'recover-capped-brain', 'capped', '2026-11-02T20:40:00.000Z');
    writeAlert(f, 'recover-capped-brain', 'capped again', '2026-11-02T20:50:00.000Z');
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(doc.alerts.slow.text, 'slow');
    assert.equal(doc.alerts['recover-capped-brain'].firstSeen, '2026-11-02T20:40:00.000Z');
    assert.equal(doc.alerts['recover-capped-brain'].text, 'capped again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Without server-cert.pem the https probe fails TLS on a healthy brain server, which would then be restarted.
test('the brain server is not restarted when its certificate cannot be read: the reason is logged instead', async () => {
  mode = 'ok';
  assert.match(certRefusal('brain', null), /server-cert.pem/);
  assert.equal(certRefusal('brain', Buffer.from('CERT')), '');
  assert.equal(certRefusal('embed', null), '', 'the embed server is plain http');
  const r = rig();
  const a = { ...r.args(), refuse: certRefusal('brain', null) };
  a.probe = async () => ({ ok: false, error: 'self-signed certificate', ms: 1 });
  assert.equal(await recover(a), 'refused');
  assert.equal(r.restartCalls, 0);
  assert.equal(r.rows[0].action, 'refused');
  assert.match(r.rows[0].reason, /server-cert.pem/);
});

// A fixed 1 s pause could start the task while it still counted as running, and Start-ScheduledTask then does nothing.
test('the restart waits for the scheduled task to leave Running before starting it again', () => {
  const ps = restartScript(TARGETS.brain);
  const wait = ps.indexOf("(Get-ScheduledTask -TaskName 'HavokBrainServer'");
  const start = ps.indexOf("Start-ScheduledTask -TaskName 'HavokBrainServer'");
  assert.ok(wait > 0 && start > wait, ps);
  assert.match(ps, /\.State -eq 'Running'/);
  assert.doesNotMatch(ps, /Start-Sleep -Seconds 1\n/);
});
