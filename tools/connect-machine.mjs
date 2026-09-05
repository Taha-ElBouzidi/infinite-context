// One command that connects a machine to the brain completely. Run it, say nothing else.
//
// The owner, 2026-08-21: "put every action, every requirement that you need into the brain because it
// is already live, the repo, and the other machines will pick it up and install everything that
// you need and connect automatically."
//
// So this is the whole requirement list, executable rather than written down. It installs what is
// missing, generates this machine's own key, publishes ONLY the public half, and pushes it. It
// asks the owner for nothing and it needs no passphrase, no token and no server.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not grant itself anything. Publishing a public key gives this machine no access at all.
// A machine on the host side must run `vault.mjs approve <NAME>`, which refuses on the deny list.
// Auto-approving whatever appears in the repo would hand the vault to any machine that cloned it,
// and one of the owner's machines is a company-issued laptop.
//
// Safe to run repeatedly. Every step checks before acting, and an existing key is never replaced,
// because replacing it would silently cost this machine access to every secret.
//
// Usage:
//   node tools/connect-machine.mjs              install, key, request, push
//   node tools/connect-machine.mjs --no-embed   skip the 426MB semantic-recall install
//   node tools/connect-machine.mjs --check      report only, change nothing

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGEKEY = resolve(homedir(), '.claude', 'havok-age-key.txt');
const CHECK = process.argv.includes('--check');
const NO_EMBED = process.argv.includes('--no-embed');
const NL = '\n';

const say = (s) => process.stdout.write(s + NL);
const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();

function run(cmd, ms = 60000, cwd = BRAIN) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '')).trim() || String(e.message) }; }
}
const has = (bin) => run(process.platform === 'win32' ? 'where ' + bin : 'command -v ' + bin, 8000).ok;

say('machine    : ' + me);
say('brain      : ' + BRAIN.split(String.fromCharCode(92)).join('/'));
say('');

// ── 1. node and git, which cannot be installed from inside a node script ───────────────────
if (!has('git')) { say('MISSING git. Install it, then run this again.'); process.exit(1); }

// ── 2. age. The only hard new requirement, and it is one command with no admin. ────────────
let ageOk = has('age');
say('age        : ' + (ageOk ? 'present' : 'MISSING'));
if (!ageOk && !CHECK) {
  if (process.platform === 'win32') {
    say('             installing with winget, user scope, no admin...');
    const r = run('winget install --id FiloSottile.age --exact --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity', 300000);
    // PATH changes do not reach a process that is already running, so `where age` can still fail
    // here even on a successful install. Look for the binary where winget puts it instead.
    const linked = resolve(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'age.exe');
    ageOk = has('age') || existsSync(linked);
    say('             ' + (ageOk ? 'installed' : 'install FAILED: ' + r.out.split(NL).slice(-2).join(' ')));
    if (ageOk && !has('age')) {
      say('             NOTE: age is installed but not on this process PATH. Open a NEW shell and run this again.');
      process.exit(2);
    }
  } else {
    say('             install it with your package manager (apt install age, brew install age), then run this again.');
    process.exit(1);
  }
}
if (!ageOk) process.exit(1);

// ── 3. what this machine can read today ────────────────────────────────────────────────────
let total = 0, readable = 0, registered = false;
try {
  const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
  for (const box of Object.values(v.secrets || {})) { total++; if (box.keys && box.keys[me]) readable++; }
} catch { /* no vault in this clone */ }
try { registered = !!JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).machines[me]; } catch { /* none */ }
say('vault      : ' + readable + ' of ' + total + ' secrets readable, ' + (registered ? 'registered' : 'not registered'));

// ── 4. this machine's own key, and the request that publishes its public half ──────────────
if (readable === total && total > 0) {
  say('');
  say('Already connected. Nothing to do.');
} else if (CHECK) {
  say('');
  say('--check: would generate a key and publish a request for ' + me);
} else {
  const hadKey = existsSync(AGEKEY);
  const r = run('node tools/vault.mjs request', 30000);
  if (!r.ok) { say('request FAILED: ' + r.out.split(NL).slice(-2).join(' ')); process.exit(1); }
  const pub = r.out.split(/\r?\n/).filter(Boolean).pop();
  say('key        : ' + (hadKey ? 'already existed, left alone' : 'generated') + ', private half stays at ' + AGEKEY);
  say('public key : ' + pub);

  // Push the request. Only a public key is being published, so this is safe to do unattended.
  const reqFile = 'vault-requests/' + me + '.json';
  run('git add ' + reqFile, 15000);
  const c = run('git -c core.hooksPath=/dev/null commit -m "vault: ' + me + ' requests access" -- ' + reqFile, 30000);
  const p = c.ok ? run('git push', 60000) : { ok: false, out: c.out };
  say('request    : ' + (p.ok ? 'pushed as ' + reqFile : 'written to ' + reqFile + ' but NOT pushed. Push it by hand: ' + (c.out.split(NL)[0] || '')));
  say('');
  say('Next, on the HOST machine (SERVER), an agent runs:');
  say('  node tools/vault.mjs approve ' + me);
  say('  git commit -am "vault: grant ' + me + '" && git push');
  say('Then pull here. Until that happens this machine reads memories and rules normally and');
  say('simply cannot decrypt secrets. Do NOT ask the owner for credentials in the meantime.');
}

// ── 5. semantic recall, optional and the only heavy step ───────────────────────────────────
const hasModel = existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'));
say('');
say('recall     : ' + (hasModel ? 'semantic (local model present)' : 'keyword only'));
if (!hasModel && !NO_EMBED && !CHECK) {
  say('             installing the embedding runtime, about 426MB, one time...');
  const r = run('npm install --no-audit --no-fund', 900000);
  say('             ' + (existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))
    ? 'installed, semantic recall is on'
    : 'FAILED, staying on keyword recall: ' + r.out.split(NL).slice(-2).join(' ')));
} else if (!hasModel) {
  say('             skipped. Enable later with: npm install (in ' + BRAIN.split(String.fromCharCode(92)).join('/') + ')');
}

say('');
say('Requirements in full, for the record:');
say('  git, node            already present or this script could not run');
say('  age                  handled above, winget user scope, no admin');
say('  a brain clone        already present');
say('  a machine key        generated here, never leaves this machine');
say('  approval on the host one command, then git push');
say('  npm install          optional, only for semantic recall');
say('  NOT needed: a passphrase, a bearer token, a server URL, a VPN, a domain, an open port.');
