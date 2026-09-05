// Client for the live brain server. Falls back to the local git clone when the server is down.
//
// The point of the fallback is that it is not a fallback in the usual sense: the local clone is
// a complete brain, not a degraded copy. The server exists only for the two things git
// deliberately cannot carry, the vault passphrase and the embedding runtime. So "server
// unreachable" should feel like nothing at all for memories and rules, and only bite on those
// two.
//
// Config, in precedence order:
//   HAVOK_SERVER_URL      explicit override; otherwise server-endpoint.json in the repo, then loopback
//   HAVOK_SERVER_TOKEN    else ~/.claude/havok-server-token
//
// Usage:
//   node tools/brain-client.mjs secret <name>     print a secret value
//   node tools/brain-client.mjs list              names and dates
//   node tools/brain-client.mjs bootstrap         fetch the vault passphrase onto this machine
//   node tools/brain-client.mjs status            is the server reachable, and what works

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
// Where the server is, DISCOVERED rather than assumed.
//
// This hardcoded 127.0.0.1 until 2026-08-22, so on any machine that is not the host it probed
// loopback, found nothing, and reported the server unreachable while the server was in fact
// answering fine on the LAN. a laptop client caught it: hostname returned 200, loopback returned 000,
// and status confidently said "not reachable, which is EXPECTED and fine".
//
// That was worse than the bug it replaced. A scary wrong answer gets investigated; a reassuring
// wrong answer sends the next agent to look somewhere else entirely, on the very tool people run
// to find out whether the network is the problem.
//
// Root cause was a split: pre-turn.mjs read server-endpoint.json and this file never did. I could
// not have seen it here, because this machine IS the host and loopback works only here. Precedence
// is explicit override, then the published endpoint, then loopback as a last resort.
function resolveServerUrl() {
  if (process.env.HAVOK_SERVER_URL) return process.env.HAVOK_SERVER_URL.replace(/\/$/, '');
  try {
    const ep = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server-endpoint.json'), 'utf8'));
    if (ep && ep.url) return String(ep.url).replace(/\/$/, '');
  } catch { /* no published endpoint, fall through */ }
  // Loopback fallback is TLS on 8443 now. Plain HTTP on 8478 was removed on 2026-08-22 and
  // pointing here would report "server down" on a perfectly healthy machine.
  return 'https://127.0.0.1:8443';
}
const URL_BASE = resolveServerUrl();
const TOKEN_FILE = resolve(homedir(), '.claude', 'havok-server-token');
const KEYFILE = resolve(homedir(), '.claude', 'havok-vault-key');

const token = () => {
  if (process.env.HAVOK_SERVER_TOKEN) return process.env.HAVOK_SERVER_TOKEN.trim();
  try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
};

// Config on STDIN, never argv.
//
// The previous version passed the bearer token as `-H "Authorization: Bearer <token>"` in argv.
// Any process on the machine can read another's command line, and this repo already records a case
// where a token reached the transcript because a failing curl echoed its own command line back. The
// vault rule is explicit: never pass a secret in argv.
//
// The body cannot also ride stdin, since the config owns it, so it goes to a temp file that is
// deleted in the finally block.
function call(path, { method = 'GET', body = null, timeoutSec = 20 } = {}) {
  // REFUSE to call with an empty token, rather than sending "Bearer " and reading the 401 as a
  // dead server.
  //
  // Found 2026-08-24 by a laptop client. Its token file was missing, token() returned '', every
  // authenticated route came back 401, and the machine concluded the brain was down. It was not:
  // the requests were arriving and being correctly rejected for having no credential. The agent
  // then spent its time debugging the network instead of the one missing file.
  //
  // Worse, it had earlier cited three /health 200s as proof the token worked. Those calls also
  // carried an empty bearer, and passed only because /health needs no auth. A silent empty
  // credential does not just fail, it manufactures false evidence that things are fine.
  const t = token();
  if (!t) {
    process.stderr.write('NO TOKEN on this machine. Not calling ' + path + ' with an empty credential,'
      + ' because the 401 would look like the server being down.' + NL
      + 'Expected at: ' + TOKEN_FILE + NL
      + 'Ask the owner to arm a bootstrap, then collect it with:' + NL
      + '  curl -s --cacert <brain>/server-cert.pem ' + URL_BASE + '/bootstrap/<THIS-MACHINE>' + NL);
    return null;
  }
  const lines = [
    'header = "Authorization: Bearer ' + t + '"',
    'url = "' + URL_BASE + path + '"',
    'silent',
    'connect-timeout = 2',
    'max-time = ' + timeoutSec,
  ];
  // PIN the certificate whenever the endpoint is https. Without this every call fails validation
  // against the self-signed cert, which is what made a healthy machine report the brain as down.
  // Never --insecure: that accepts any certificate and is worse than plaintext, because it looks
  // encrypted while anything on the path could impersonate the server and take the token above.
  if (/^https:/i.test(URL_BASE)) {
    const cert = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server-cert.pem');
    // Forward slashes: a curl config treats a backslash as an escape character.
    if (existsSync(cert)) lines.push('cacert = "' + cert.split('\\').join('/') + '"');
  }
  let bodyFile = null;
  if (body) {
    bodyFile = join(tmpdir(), 'havok-bc-' + process.pid + '.json');
    writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
    lines.push('request = "POST"', 'header = "content-type: application/json"',
      'data-binary = "@' + bodyFile.split('\\').join('/') + '"');
  }
  try {
    const out = execFileSync('curl', ['-K', '-'], {
      input: lines.join('\n') + '\n',
      encoding: 'utf8', timeout: (timeoutSec + 2) * 1000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return JSON.parse(out || '{}');
  } catch { return null; } finally {
    if (bodyFile) { try { unlinkSync(bodyFile); } catch { /* already gone */ } }
  }
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'status') {
  const AGEKEY = resolve(homedir(), '.claude', 'havok-age-key.txt');
  const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
  let readable = 0, total = 0, registered = false, host = '';
  try {
    const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
    for (const box of Object.values(v.secrets || {})) { total++; if (box.keys && box.keys[me]) readable++; }
  } catch { /* no vault on this clone */ }
  try {
    const r = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
    registered = !!r.machines[me];
    host = (r.host || '').toUpperCase();
  } catch { /* none */ }
  const isHost = host && host === me;

  // The host and everyone else need different wording. On the host, a down server is a real
  // fault. Elsewhere it is a statement about reachability, and the first version of this attached
  // a reassuring "EXPECTED and fine" to it, which is how a wrong probe became a confident wrong
  // answer on 2026-08-22. Never soften a negative result you have not verified.
  const h = call('/health', { timeoutSec: 3 });
  const reachable = !!(h && h.ok);
  if (isHost) {
    process.stdout.write('brain server (this machine hosts it): ' + (reachable ? 'UP on ' + URL_BASE : 'DOWN, expected UP. Start it: Start-ScheduledTask -TaskName HavokBrainServer') + '\n');
    process.stdout.write('server token: ' + (token() ? 'present' : 'MISSING, the server cannot authenticate callers') + '\n');
  } else {
    // No reassuring sentence attached to a negative result. The previous version said "EXPECTED
    // and fine" whenever the probe failed, which turned a wrong probe into a confident wrong
    // answer. State what was tried and what happened, and let the reader judge.
    process.stdout.write('brain server: ' + (reachable
      ? 'reachable at ' + URL_BASE
      : 'NOT reachable at ' + URL_BASE + '. Vault and memories still work from this clone. Semantic recall does not,'
        + ' unless this machine runs its own daemon. If you are on the same network as ' + (host || 'the host')
        + ', that is a fault and not a normal state.') + '\n');
  }
  process.stdout.write('machine name: ' + me + (registered ? ' (registered)' : ' (NOT registered as a recipient)') + '\n');
  // A FILE IS NOT A CAPABILITY, and on every machine except the host a key file is a FINDING.
  //
  // This printed "vault key on this machine: yes" on a laptop client on 2026-08-24 for a key that could
  // decrypt nothing: its recipient entry was removed when identities were consolidated onto the host,
  // so age answers "no identity matched any of the recipients". Reporting file existence as though
  // it were an ability is the third status bug of exactly this shape, after "3 of 3" while the vault
  // returned an empty string and "0 of 3" while the server served the vault fine.
  //
  // It also inverts the security reading. The owner, 2026-08-24: "I don't want it on repo. I don't even
  // want it on a laptop client. I want it only on server." Off the host, a private key on disk is the thing
  // to report, not a tick in a box.
  if (isHost) {
    process.stdout.write('age identity: ' + (existsSync(AGEKEY)
      ? 'present, correct, this machine is the only one that should hold it'
      : 'MISSING on the host, so the server cannot decrypt the vault at all') + '\n');
  } else if (existsSync(AGEKEY)) {
    let decrypts = false;
    try {
      decrypts = execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'list'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim().length > 0;
    } catch { /* a key that cannot run vault.mjs decrypts nothing, which is the answer */ }
    process.stdout.write('age identity: PRESENT at ' + AGEKEY + ', and it '
      + (decrypts ? 'DOES decrypt the local vault' : 'decrypts nothing (dead leftover)')
      + '. Private keys are meant to live only on SERVER: report this rather than ignoring it.\n');
  } else {
    process.stdout.write('age identity: none on this machine, which is correct. Secrets come from the server.\n');
  }
  // Report what this machine can ACTUALLY reach, not what it could decrypt locally.
  //
  // This counted local age keys, which is dead by design since keys moved to SERVER on 2026-08-24.
  // a laptop client caught it saying '3 of 3' while vault.mjs returned an empty string, then '0 of 3'
  // at a moment it could demonstrably read the vault through the server with a full token. Wrong
  // in BOTH directions, on the line an agent quotes to the owner as evidence the machine is healthy.
  //
  // Decryption happens server side now, so the honest question is 'can I reach the vault route',
  // and the only honest way to answer it is to ask.
  if (isHost) {
    process.stdout.write('secrets: ' + total + ' in the vault, decrypted here (this machine holds the keys)' + NL);
  } else {
    const vl = call('/vault/list', { timeoutSec: 6 });
    process.stdout.write('secrets: ' + (vl && Array.isArray(vl.secrets)
      ? 'readable through the server, ' + vl.secrets.length + ' available'
      : vl && vl.error === 'forbidden'
        ? 'NOT permitted for this machine (recall-scoped token, 403). This is deliberate, do not retry.'
        : 'cannot be read: the server did not answer /vault/list') + NL);
    if (readable > 0) {
      process.stdout.write('  note: vault.json still lists a local key for ' + me + '. Keys are meant to live only on'
        + ' SERVER, so that is stale, pull the brain.' + NL);
    }
  }

  // Say out loud when semantic recall is being skipped, and why.
  //
  // a laptop client, 2026-08-22: "a degraded state is invisible in both directions ... the user infers
  // it from answers feeling shallower." That is the worst way to learn your recall got worse. The
  // hook writes this mark when the remote embed call fails and skips it for ten minutes; without
  // this line nothing anywhere reports that.
  const DOWN = resolve(homedir(), '.claude', 'havok-remote-embed-down');
  const ALIVE = resolve(homedir(), '.claude', 'havok-embed.alive');
  const localDaemon = existsSync(ALIVE);
  try {
    const raw = readFileSync(DOWN, 'utf8').trim();
    const m = /^\d+$/.test(raw) ? { at: Number(raw), reason: 'unknown (mark predates reasons)' } : JSON.parse(raw);
    const mins = Math.floor((Date.now() - Number(m.at)) / 60000);
    const cooled = (Date.now() - Number(m.at)) >= 10 * 60 * 1000;
    process.stdout.write('remote embedding: ' + (cooled
      ? 'marked down ' + mins + ' min ago (' + m.reason + '), cooldown lapsed so the next turn retries'
      : 'SKIPPED, marked down ' + mins + ' min ago (' + m.reason + '), retrying in ' + (10 - mins) + ' min') + '\n');
  } catch {
    process.stdout.write('remote embedding: not marked down\n');
  }
  // Do NOT say "semantic recall is local" here. The daemon running says nothing about which path
  // carries a turn, because the server is tried first. Two lines on the same screen disagreeing is
  // how a reader ends up trusting the wrong one.
  process.stdout.write('local embed daemon: ' + (localDaemon
    ? 'running, available as the fallback if the server is unreachable'
    : 'not running, so the server is the only semantic path') + '\n');

  // A positive statement, not only a negative one. a laptop client, 2026-08-22: without this "the only
  // two states a reader can distinguish are degraded and silent", so working recall looked
  // identical to broken recall. Say which path is actually carrying it.
  let markFresh = false;
  try {
    const raw = readFileSync(DOWN, 'utf8').trim();
    const m = /^\d+$/.test(raw) ? { at: Number(raw) } : JSON.parse(raw);
    markFresh = (Date.now() - Number(m.at)) < 10 * 60 * 1000;
  } catch { /* no mark */ }
  // THE SERVER IS TRIED FIRST, so report the server first.
  //
  // This said "SEMANTIC, via the local daemon" whenever a local daemon existed, which stopped being
  // true when recall moved server-side: hooks/pre-turn.mjs now calls /recall BEFORE it considers
  // the daemon, and the daemon only carries a turn if the server could not be reached. Measured on
  // SERVER 2026-08-23: one hook run produced exactly one /recall entry in the access log while this
  // line insisted recall was local.
  //
  // Caught by the a client project session, which read this line and concluded its turns were not
  // exercising the server path at all. That is the real cost of a wrong status line: it does not
  // just misinform, it sends the next person to debug the wrong component. Same failure as the
  // "semantic recall is OFF" notice that fired on every server-answered turn.
  process.stdout.write('recall right now: ' + (
    (reachable && !markFresh) ? 'SEMANTIC, via the server at ' + URL_BASE
      + (localDaemon ? ' (a local daemon is also running, used only if the server is unreachable)' : '')
      : localDaemon ? 'SEMANTIC, via the LOCAL daemon (the server is ' + (markFresh ? 'marked down' : 'not reachable') + ')'
        : 'KEYWORD ONLY, no local daemon and the server is ' + (markFresh ? 'marked down' : 'not reachable')
  ) + '\n');
  if (existsSync(KEYFILE)) process.stdout.write('legacy v1 passphrase still present at ' + KEYFILE + ', delete it once every secret is v2\n');
  process.stdout.write('local brain clone: ' + (existsSync(join(BRAIN, 'memory')) ? 'yes, memories and rules work offline' : 'MISSING') + '\n');

} else if (cmd === 'bootstrap') {
  // Rewritten 2026-08-21. This used to download the shared vault passphrase over the network,
  // which meant one stolen bearer token equalled every credential the owner owns, on every machine,
  // forever. There is no shared passphrase any more.
  //
  // The new flow moves only PUBLIC keys, so nothing sensitive crosses the wire and nothing has to
  // be kept secret in transit. It also does not need the server at all: a pull request against
  // the brain works just as well, which is the point.
  const AGEKEY = resolve(homedir(), '.claude', 'havok-age-key.txt');
  const vaultTool = join(BRAIN, 'tools', 'vault.mjs');
  let pub = '';
  try {
    pub = execFileSync(process.execPath, [vaultTool, 'machine-init'], { encoding: 'utf8' }).trim();
  } catch (e) {
    process.stderr.write('Could not create a machine key: ' + (e.message || e) + '\n');
    process.exit(1);
  }
  const machine = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
  process.stdout.write(pub + '\n');
  process.stderr.write([
    '',
    'This machine now has its own key. The private half stays at ' + AGEKEY + ' and never moves.',
    'The line above is the PUBLIC key and is safe to paste anywhere.',
    '',
    'To finish, on a machine that ALREADY has vault access, run:',
    '  node tools/vault.mjs machine-add ' + machine + ' ' + pub,
    '  node tools/vault.mjs grant --all --to ' + machine,
    '  git commit -am "vault: grant ' + machine + '" && git push',
    '',
    'Then pull here. No passphrase is ever copied, and no secret crosses the network.',
    '',
  ].join('\n'));

} else if (cmd === 'list') {
  const r = call('/vault/list');
  if (r && r.secrets) {
    for (const s of r.secrets) process.stdout.write(s.name.padEnd(34) + 'updated ' + s.updated + '\n');
  } else {
    // Server down: the local clone still has the encrypted vault, so listing works offline.
    process.stderr.write('server unreachable, using the local clone\n');
    process.stdout.write(execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'list'], { encoding: 'utf8' }));
  }

} else if (cmd === 'secret') {
  if (!arg) { process.stderr.write('usage: brain-client.mjs secret <name>\n'); process.exit(1); }
  const r = call('/vault/get/' + encodeURIComponent(arg));
  if (r && typeof r.value === 'string') {
    process.stdout.write(r.value);
  } else {
    // Offline path. Works only if this machine already has the passphrase, which is exactly
    // what bootstrap is for.
    try {
      process.stdout.write(execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'get', arg], { encoding: 'utf8' }));
    } catch {
      process.stderr.write('Could not read "' + arg + '" from the server or locally.\n'
        + 'If this machine has no passphrase, run: node tools/brain-client.mjs bootstrap\n');
      process.exit(1);
    }
  }

} else if (cmd === 'write') {
  // THE BODY NEVER COMES FROM ARGV. It arrives as a file path or on stdin, and both reasons are
  // scars: a memory body on a command line gets mangled by shell quoting, and this project has
  // already lost two working files to exactly that (a backslash eaten by an escape, a heredoc
  // swallowing another). A path has no quoting to get wrong. Argv is also the wrong place for
  // anything long or private, since it shows up in error output and process listings.
  const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
  const fromStdin = process.argv.includes('--stdin');
  const file = flag('--file');
  if (!arg || (!file && !fromStdin)) {
    process.stderr.write([
      'usage: brain-client.mjs write <slug> --file <path>',
      '       brain-client.mjs write <slug> --stdin',
      '',
      'The slug must start with user, contact, project, feedback or reference, and the file must',
      'carry frontmatter with name, description and a matching type. The description is the ONLY',
      'thing indexed for recall, so write it in the words the owner would actually type.',
      '',
    ].join(NL));
    process.exit(1);
  }
  let content = '';
  try {
    content = fromStdin ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
  } catch (e) {
    process.stderr.write('cannot read the memory body: ' + String(e.message) + NL);
    process.exit(1);
  }
  if (!content.trim()) { process.stderr.write('the body is empty, refusing to write' + NL); process.exit(1); }

  const r = call('/memory', { method: 'POST', body: { slug: arg, content }, timeoutSec: 300 });
  if (!r) {
    // NO LOCAL FALLBACK, deliberately, unlike list and secret above. The owner, 2026-08-24: the brain is
    // 100% on the server and git is only its backup. Writing to the local clone and pushing is the
    // exact path being retired, and doing it quietly here would put the memory somewhere the server
    // does not know about while telling the agent it succeeded.
    process.stderr.write('The server did not answer, so NOTHING was written. Do not commit this to'
      + ' your local clone instead: the server owns writes and git is only its backup.' + NL
      + 'Check with: node tools/brain-client.mjs status' + NL);
    process.exit(1);
  }
  if (!r.ok) {
    process.stderr.write('REFUSED: ' + (r.error || 'unknown') + NL
      + (r.detail ? String(r.detail) + NL : '')
      + 'The write was validated before it landed, so nothing is half-written. Fix it and run again.' + NL);
    process.exit(1);
  }
  process.stdout.write((r.updated ? 'updated ' : 'wrote ') + r.slug + ', indexed, index now ' + r.v + NL);
  // pushed:false is NOT a failed write. Say so here, or the next agent rolls back a memory that is
  // safely on the source of truth.
  if (r.pushed === false) {
    process.stdout.write('git backup did NOT get it: ' + (r.pushError || 'no reason given') + NL
      + 'The memory IS on the server and is live for every machine. This only means the backup is behind.' + NL);
  }

} else if (cmd === 'read') {
  // FETCH ONE MEMORY FROM THE the host, for a machine that holds no copy of memory/.
  //
  // Added 2026-09-04. Recall returns a slug, a description and a LOCAL FILE PATH, and the
  // injection tells the agent to open that path. On a machine whose memory/ is stale or absent
  // that path does not resolve, and the cheapest thing an agent can do then is answer from the
  // one-line description, which is the exact failure the recall design exists to prevent. With
  // the brain living only on the server there has to be a way to get a body without a local
  // file. The route existed since August; nothing used it.
  if (!arg) {
    process.stderr.write('usage: brain-client.mjs read <slug>' + NL);
    process.exit(1);
  }
  const slug = arg.slice(-3) === '.md' ? arg.slice(0, -3) : arg;
  const r = call('/memory/' + encodeURIComponent(slug));
  if (r && typeof r.content === 'string') {
    process.stdout.write(r.content);
  } else {
    // Local fallback, which is the normal path on the host itself.
    try {
      process.stdout.write(readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8'));
    } catch {
      process.stderr.write('no memory named ' + slug + ' on the server or on this machine' + NL);
      process.exit(1);
    }
  }
} else {
  process.stdout.write([
    'brain-client.mjs, talk to the live brain server with a local fallback',
    '',
    '  status                      is the server up, and what works on this machine',
    '  bootstrap                   fetch the vault passphrase onto this machine, once',
    '  list                        secret names and dates',
    '  secret <name>               print one secret value',
    '  read <slug>                 print one memory, from the server, no local copy needed',
    '  write <slug> --file <path>  write a memory through the server (also --stdin)',
    '',
    'Server URL: ' + URL_BASE + '  (override with HAVOK_SERVER_URL)',
    '',
  ].join('\n'));
}
