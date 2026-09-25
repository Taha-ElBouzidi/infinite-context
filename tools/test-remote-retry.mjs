// Tests the one retry hooks/pre-turn.mjs makes when a remote call loses the connect race.
//
// WHY. the locked-down client machine, 2026-09-17: the first connection to the server after the laptop sat idle took 6.9 s
// through the Madrid DERP relay, the next ones 93 ms. The hook gave up at connect-timeout 4, marked the
// server down, and recall stayed keyword only for the whole cooldown. One retry, inside what is left of
// the hook's 10 second limit, catches the warm relay instead.
//
// The helper is taken from the hook's own source, so what runs here is exactly what ships. Only
// execFileSync is replaced, with a stub that records each call.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(BRAIN, 'hooks/pre-turn.mjs'), 'utf8');
const begin = src.indexOf('// BEGIN curlRemote');
const end = src.indexOf('// END curlRemote');
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  process.stdout.write((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : ' | got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)) + '\n');
};
if (begin < 0 || end < 0) {
  check('the hook has a curlRemote helper between BEGIN and END markers', false, true);
  process.exit(1);
}
const helperSrc = src.slice(begin, end);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function load(startedAgoMs, plan) {
  const calls = [];
  const execFileSync = (cmd, args, opts) => {
    const step = plan[calls.length];
    calls.push({ conf: opts.input, timeout: opts.timeout });
    if (!step) throw Object.assign(new Error('no step planned'), { status: 99 });
    if (step.waitMs) sleep(step.waitMs);
    if (step.out !== undefined) return step.out;
    throw Object.assign(new Error(step.error || 'curl failed'), step.fields || {});
  };
  const make = new Function('execFileSync', 'HOOK_STARTED', helperSrc + '\nreturn { curlRemote, curlWhy: typeof curlWhy === "function" ? curlWhy : null };');
  const fns = make(execFileSync, Date.now() - startedAgoMs);
  return { curlRemote: fns.curlRemote, curlWhy: fns.curlWhy, calls };
}
const conf = (ct) => 'url = "https://x"\nsilent\nconnect-timeout = ' + ct + '\nmax-time = 9\n';
const remote = { ct: 1, connectTo: 'host:8443:1.2.3.4:8443' };

{
  const { curlRemote, calls } = load(500, [{ fields: { status: 28 } }, { out: '{"ranked":[]}' }]);
  let out = null;
  try { out = curlRemote(conf(1), 9000, remote); } catch { out = 'threw'; }
  check('a connect failure over the relay is retried once and the answer is used', out, '{"ranked":[]}');
  check('exactly two attempts', calls.length, 2);
}
{
  const { curlRemote, calls } = load(500, [{ waitMs: 2100, fields: { status: 28 } }, { out: 'late' }]);
  let threw = false;
  try { curlRemote(conf(1), 9000, remote); } catch { threw = true; }
  check('a failure after the connect phase (a slow answer) is not retried', [threw, calls.length], [true, 1]);
}
{
  const { curlRemote, calls } = load(500, [{ fields: { status: 7 } }, { out: 'x' }]);
  let threw = false;
  try { curlRemote(conf(1), 6000, { ct: 1, connectTo: null }); } catch { threw = true; }
  check('the host itself (no relay) is never retried', [threw, calls.length], [true, 1]);
}
{
  const { curlRemote, calls } = load(8000, [{ fields: { status: 28 } }, { out: 'x' }]);
  let threw = false;
  try { curlRemote(conf(4), 9000, { ct: 4, connectTo: remote.connectTo }); } catch { threw = true; }
  check('no retry when the hook has no time left before its 10 s limit', [threw, calls.length], [true, 1]);
}
{
  const { curlRemote, calls } = load(3000, [{ fields: { status: 28 } }, { out: 'ok' }]);
  try { curlRemote(conf(4), 9000, { ct: 4, connectTo: remote.connectTo }); } catch { /* checked below */ }
  const second = calls[1] || { conf: '', timeout: 0 };
  const ct = Number((second.conf.match(/connect-timeout = (\d+)/) || [])[1]);
  const maxTime = Number((second.conf.match(/max-time = (\d+)/) || [])[1]);
  check('the retry fits in what is left of the 10 s limit', ct >= 1 && ct <= 4 && maxTime <= 5 && second.timeout <= 5500, true);
}
{
  const { curlRemote, calls } = load(500, [{ fields: { code: 'ENOENT' } }, { out: 'x' }]);
  let threw = false;
  try { curlRemote(conf(1), 9000, remote); } catch { threw = true; }
  check('curl missing is not retried', [threw, calls.length], [true, 1]);
}

// The down mark says what curl actually reported. Until this, any failure wrote the same guessed sentence,
// which is why a TLS race looked exactly like the server being off (reference_recall_connect_timeout_derp).
{
  const { curlWhy } = load(0, []);
  const why = (fields, msg) => (curlWhy ? curlWhy(Object.assign(new Error(msg || 'x'), fields)) : '');
  check('curl exit 28 is reported as a timeout', /timed out/.test(why({ status: 28 })), true);
  check('curl exit 7 is reported as could not connect', /could not connect/.test(why({ status: 7 })), true);
  check('curl exit 35 is reported as the TLS handshake', /TLS/.test(why({ status: 35 })), true);
  check('curl exit 60 is reported as the certificate', /certificate/.test(why({ status: 60 })), true);
  check('an unknown exit keeps its number', /curl exit 99/.test(why({ status: 99 })), true);
  check('curl missing is reported as such', /curl not found/.test(why({ code: 'ENOENT' })), true);
  check('the hook giving up is reported as such', /stopped waiting/.test(why({ code: 'ETIMEDOUT' })), true);
  check('an answer that is not JSON is reported as such', /not JSON/.test(curlWhy ? curlWhy(new SyntaxError('Unexpected token <')) : ''), true);
}

const cooldown = src.match(/const DOWN_COOLDOWN_MS = ([^;]+);/);
check('the down mark lasts 3 minutes, not 10', cooldown && cooldown[1].replace(/\s/g, ''), '3*60*1000');
const client = readFileSync(resolve(BRAIN, 'tools/brain-client.mjs'), 'utf8');
check('brain-client reports the same 3 minute cooldown', /10 \* 60 \* 1000/.test(client), false);

process.stdout.write((failures ? 'FAILED: ' + failures : 'PASSED') + '\n');
process.exit(failures ? 1 : 0);
