// The keychain. Encrypted secrets that live IN the brain and travel with it.
//
// The owner, 2026-08-19: "something accessible online for all models, without asking me again and
// again, and I can ask them for them like a keychain." And, when offered hosted vaults: "no I
// want something in the brain, not a bitwarden or a onepassword."
//
// So: values are encrypted at rest in vault.json, committed to the brain, pushed with it. Any
// machine that is a RECIPIENT has the secrets. Any agent on it can read one without asking him.
//
// ── v2, 2026-08-21: per-machine keys instead of one shared passphrase ──────────────────────
//
// v1 derived one AES key from one passphrase that every machine had to hold. That has two faults
// the owner ran into directly:
//
//   1. It is all or nothing. One of his machines is a the locked-down client-ISSUED LAPTOP. Giving it the
//      passphrase gives it every personal credential he owns, and his own brain notes say to keep
//      personal engagements off that machine.
//   2. Sharing it is a manual step. He said: "I don't want to do anything, all is gonna be done
//      by the agents." A passphrase a human must copy is the opposite of that.
//
// v2 is envelope encryption. Each secret gets its own random 32-byte data key. The VALUE is
// encrypted once with that data key (AES-256-GCM, as before). The DATA KEY is then encrypted
// separately to each recipient machine's age public key. A machine decrypts by unwrapping the
// data key with its own private key, which never leaves it and is never shared with anything.
//
// Consequences worth stating:
//   - Per-secret, per-machine access. `set --to the host,a laptop client` simply omits the laptop, and
//     the laptop is then refused by cryptography, not by policy. age answers "no identity matched
//     any of the recipients".
//   - Adding a machine never re-encrypts a secret. A machine that already has access unwraps the
//     data key and rewraps it for the newcomer. The value is never rewritten and never touches
//     disk in the clear.
//   - Onboarding is automatable end to end. A new machine's agent runs `machine-init`, which
//     prints a PUBLIC key. Public keys are safe to commit. An agent opens a PR adding it, an agent
//     here runs `grant`. Zero human steps.
//   - No shared secret exists any more. There is nothing to copy between machines, so there is
//     nothing to leak in transit.
//
// v1 entries still decrypt. `migrate` converts them. Nothing is removed until the owner confirms.
//
// THREAT MODEL, stated plainly, because this is the one file where vagueness is dangerous.
//   - the repository this vault is committed to is PRIVATE, verified 2026-08-19. Treat the ciphertext
//     as if it could become public anyway: repos get shared, forked or flipped by accident, and
//     git history is permanent.
//   - AES-256-GCM per secret with a random data key and IV. GCM is authenticated, so a tampered
//     entry fails loudly instead of decrypting to garbage.
//   - Data keys wrapped with age (X25519 + ChaCha20-Poly1305).
//   - A machine's private key lives at ~/.claude/havok-age-key.txt, outside the brain and outside
//     git. Losing it costs that ONE machine access; every other machine is unaffected. Under v1,
//     losing the passphrase meant losing everything.
//   - Revoking a machine means removing its wrapped key AND rotating the underlying credentials,
//     because the old wrapped key stays in git history forever. Removal alone is not revocation.
//
// WHAT MUST NEVER HAPPEN
//   - No plaintext value is written to the repo, echoed into a transcript, or passed in argv.
//     `get` writes to stdout so it can be piped. Anything that prints it into a conversation has
//     leaked it, and a leaked secret is burned: rotate the real credential, not just this entry.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = join(BRAIN, 'vault.json');
const RECIPIENTS = join(BRAIN, 'vault-recipients.json');
const REQUESTS = join(BRAIN, 'vault-requests');
// WHERE THIS PROCESS KEEPS ITS PRIVATE FILES.
//
// Normally the user profile. But the brain server is started AT BOOT as SYSTEM so it comes back
// after a reboot without waiting for the owner to log in, and SYSTEM's profile is
// C:/Windows/System32/config/systemprofile, where none of these files exist. Without this the
// server would boot, find no token and no age key, and serve nothing while looking healthy.
//
// HAVOK_HOME is inherited by child processes, so brain-server passing it once reaches vault.mjs
// automatically when it shells out to decrypt a secret.
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');

const KEYFILE = resolve(CONFIG_DIR, 'havok-vault-key');       // v1 passphrase
const AGEKEY = resolve(CONFIG_DIR, 'havok-age-key.txt');      // v2 private key

// v1 only. Deliberately slow: it was the only thing between a leaked ciphertext and a
// brute-forced passphrase. v2 has no passphrase to brute force.
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

const NL = '\n';
const die = (m) => { process.stderr.write(m + NL); process.exit(1); };
const today = () => new Date().toISOString().slice(0, 10);

// ── age plumbing ───────────────────────────────────────────────────────────────────────────
// Every value crosses process boundaries on STDIN, never argv. argv is readable by other
// processes on the machine and lands in shell history.

function ageAvailable() {
  try { execFileSync('age', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function requireAge() {
  if (!ageAvailable()) {
    die('age is not installed on this machine.' + NL
      + 'Install it with:  winget install --id FiloSottile.age --exact --scope user' + NL
      + 'Then open a NEW shell, because PATH changes do not reach a running process.');
  }
}

function wrapKey(dataKey, pubkeys) {
  const args = [];
  for (const p of pubkeys) args.push('-r', p);
  args.push('-a');
  return execFileSync('age', args, { input: dataKey, encoding: 'utf8' });
}

function unwrapKey(armored) {
  if (!existsSync(AGEKEY)) {
    die('This machine has no age key, so it cannot decrypt anything.' + NL
      + 'Run: node tools/vault.mjs machine-init' + NL
      + 'Then send the PUBLIC key it prints to a machine that already has access.');
  }
  try {
    return execFileSync('age', ['-d', '-i', AGEKEY], { input: Buffer.from(armored, 'utf8') });
  } catch {
    return null;
  }
}

// ── files ──────────────────────────────────────────────────────────────────────────────────

const loadVault = () => (existsSync(VAULT)
  ? JSON.parse(readFileSync(VAULT, 'utf8'))
  : { version: 2, secrets: {} });

const saveVault = (v) => writeFileSync(VAULT, JSON.stringify(v, null, 2) + NL, 'utf8');

const loadRecipients = () => (existsSync(RECIPIENTS)
  ? JSON.parse(readFileSync(RECIPIENTS, 'utf8'))
  : { version: 1, machines: {} });

const saveRecipients = (r) => writeFileSync(RECIPIENTS, JSON.stringify(r, null, 2) + NL, 'utf8');

function thisMachine() {
  return (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
}

// ── v1 compatibility ───────────────────────────────────────────────────────────────────────

function loadPassphrase(soft) {
  if (process.env.HAVOK_VAULT_KEY) return process.env.HAVOK_VAULT_KEY.trim();
  if (!existsSync(KEYFILE)) {
    if (soft) return null;
    die('No v1 vault passphrase on this machine and no v2 age key matched.');
  }
  return readFileSync(KEYFILE, 'utf8').trim();
}

function decryptV1(box, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(box.salt, 'base64'), 32, SCRYPT);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}

// ── v2 crypto ──────────────────────────────────────────────────────────────────────────────

function encryptV2(plaintext, recipientMap) {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const keys = {};
  for (const [machine, pubkey] of Object.entries(recipientMap)) keys[machine] = wrapKey(dataKey, [pubkey]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'), keys };
}

// Returns the raw data key, or null if this machine is not a recipient.
function openDataKey(box) {
  const me = thisMachine();
  const mine = box.keys && box.keys[me];
  if (mine) {
    const dk = unwrapKey(mine);
    if (dk) return dk;
  }
  // Fall back to trying every wrapped key: the machine name may differ from the recipient label
  // (renamed host, HAVOK_MACHINE_NAME unset). age itself decides, so this cannot grant access
  // that the key does not already carry.
  for (const armored of Object.values(box.keys || {})) {
    const dk = unwrapKey(armored);
    if (dk) return dk;
  }
  return null;
}

function decryptV2(box) {
  const dk = openDataKey(box);
  if (!dk) return null;
  const d = createDecipheriv('aes-256-gcm', dk, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}

const isV2 = (box) => !!(box && box.keys);

function readSecret(box, nameForError) {
  if (isV2(box)) {
    const v = decryptV2(box);
    if (v === null) {
      die('This machine is not a recipient for "' + nameForError + '", or its age key does not match.' + NL
        + 'Machine: ' + thisMachine() + NL
        + 'Recipients: ' + Object.keys(box.keys).join(', ') + NL
        + 'To grant access, on a machine that already has it: node tools/vault.mjs grant '
        + nameForError + ' --to ' + thisMachine());
    }
    return v;
  }
  const pass = loadPassphrase(true);
  if (!pass) die('"' + nameForError + '" is still in v1 format and this machine has no passphrase. Run migrate on the machine that has it.');
  try { return decryptV1(box, pass); }
  catch { die('Decryption failed for "' + nameForError + '". Wrong passphrase, or GCM rejected a tampered entry.'); }
}

const readStdin = () => {
  try { return readFileSync(0, 'utf8').replace(/\r?\n$/, ''); } catch { return ''; }
};

function getFlag(flag) {
  const i = process.argv.indexOf('--' + flag);
  return i > -1 ? process.argv[i + 1] : null;
}

// Recipients to encrypt to: --to NAME,NAME or every registered machine.
function resolveRecipients() {
  const reg = loadRecipients().machines;
  const wanted = getFlag('to');
  if (!wanted) {
    if (!Object.keys(reg).length) {
      die('No machines registered yet. Run: node tools/vault.mjs machine-init');
    }
    return reg;
  }
  const out = {};
  for (const raw of wanted.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    if (!reg[raw]) die('Unknown machine "' + raw + '". Registered: ' + (Object.keys(reg).join(', ') || 'none'));
    out[raw] = reg[raw];
  }
  if (!Object.keys(out).length) die('--to matched no machines');
  return out;
}

const pubkeysOf = (machines) => Object.fromEntries(Object.entries(machines).map(([n, m]) => [n, m.pubkey || m]));

// ── commands ───────────────────────────────────────────────────────────────────────────────

const [cmd, name] = process.argv.slice(2);

if (cmd === 'machine-init') {
  requireAge();
  if (existsSync(AGEKEY)) {
    const pub = readFileSync(AGEKEY, 'utf8').split(/\r?\n/).find((l) => l.startsWith('# public key:'));
    process.stderr.write('This machine already has an age key at ' + AGEKEY + NL
      + 'Deleting it would cost this machine access to every secret, so it is left alone.' + NL);
    if (pub) process.stdout.write(pub.split(': ')[1].trim() + NL);
    process.exit(0);
  }
  const generated = execFileSync('age-keygen', [], { encoding: 'utf8' });
  mkdirSync(dirname(AGEKEY), { recursive: true });
  writeFileSync(AGEKEY, generated, 'utf8');
  try { chmodSync(AGEKEY, 0o600); } catch { /* Windows ACLs differ, best effort */ }
  const pub = generated.split(/\r?\n/).find((l) => l.startsWith('# public key:')).split(': ')[1].trim();
  // Only the PUBLIC key reaches stdout. The private key is written to disk and never printed,
  // so it cannot be scraped from a transcript or a scrollback buffer.
  process.stdout.write(pub + NL);
  process.stderr.write(NL + 'Private key written to ' + AGEKEY + ' and never printed.' + NL
    + 'Machine name: ' + thisMachine() + NL
    + 'The line on stdout is the PUBLIC key and is safe to commit or send.' + NL
    + 'On a machine that already has access, run:' + NL
    + '  node tools/vault.mjs machine-add ' + thisMachine() + ' <public key>' + NL
    + '  node tools/vault.mjs grant --all --to ' + thisMachine() + NL);

} else if (cmd === 'machine-add') {
  const pubkey = process.argv[4];
  if (!name || !pubkey) die('usage: vault.mjs machine-add <MACHINE-NAME> <age1...public-key> [--note "..."]');
  if (!/^age1[0-9a-z]{50,}$/.test(pubkey)) die('That does not look like an age public key. It must start with age1.');
  const r = loadRecipients();
  const key = name.trim().toUpperCase();
  r.machines[key] = { pubkey, added: today(), note: getFlag('note') || '' };
  saveRecipients(r);
  process.stderr.write('registered ' + key + NL
    + 'It can decrypt nothing yet. Grant access with: node tools/vault.mjs grant --all --to ' + key + NL);

} else if (cmd === 'machine-rm') {
  if (!name) die('usage: vault.mjs machine-rm <MACHINE-NAME>');
  const key = name.trim().toUpperCase();
  const r = loadRecipients();
  if (!r.machines[key]) die('No machine named "' + key + '"');
  delete r.machines[key];
  saveRecipients(r);
  const v = loadVault();
  let stripped = 0;
  for (const box of Object.values(v.secrets)) {
    if (box.keys && box.keys[key]) { delete box.keys[key]; stripped++; }
  }
  saveVault(v);
  process.stderr.write('removed ' + key + ' and stripped its wrapped key from ' + stripped + ' secret(s).' + NL
    + 'THIS IS NOT REVOCATION. The old wrapped keys stay in git history forever, so that machine '
    + 'can still decrypt anything it kept a copy of.' + NL
    + 'If the machine is untrusted, rotate the underlying credentials at the provider.' + NL);

} else if (cmd === 'request') {
  // Run by a machine that has no access yet. Publishes ONLY its public key, so this is safe to
  // commit and safe to run automatically. It grants nothing by itself.
  requireAge();
  const me = thisMachine();
  let pub;
  try {
    pub = execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'machine-init'], { encoding: 'utf8' }).trim();
  } catch { die('machine-init failed, cannot build a request'); }
  mkdirSync(REQUESTS, { recursive: true });
  writeFileSync(join(REQUESTS, me + '.json'), JSON.stringify({
    machine: me, pubkey: pub, requested: today(),
    note: 'auto-generated at session start by check-session-start.mjs',
  }, null, 2) + NL, 'utf8');
  process.stderr.write('wrote vault-requests/' + me + '.json' + NL
    + 'Commit and push it. An agent on the host machine approves with: node tools/vault.mjs approve ' + me + NL);
  process.stdout.write(pub + NL);

} else if (cmd === 'requests') {
  if (!existsSync(REQUESTS)) { process.stdout.write('no pending requests' + NL); process.exit(0); }
  const reg = loadRecipients().machines;
  const files = readdirSync(REQUESTS).filter((f) => f.endsWith('.json'));
  const pending = files.map((f) => JSON.parse(readFileSync(join(REQUESTS, f), 'utf8'))).filter((r) => !reg[r.machine]);
  if (!pending.length) { process.stdout.write('no pending requests' + NL); process.exit(0); }
  for (const r of pending) process.stdout.write(r.machine.padEnd(22) + 'requested ' + r.requested + '  ' + r.pubkey + NL);

} else if (cmd === 'approve') {
  // Register a requesting machine and grant it every secret. Deliberately a separate, explicit
  // step from `request`: auto-approving anything that shows up in the repo would hand the vault
  // to whatever machine cloned it, which is precisely the hole the deny list exists to close.
  requireAge();
  if (!name) die('usage: vault.mjs approve <MACHINE-NAME>   (see: vault.mjs requests)');
  const key = name.trim().toUpperCase();
  const r = loadRecipients();
  for (const d of r.denied || []) {
    if (key.includes(d)) {
      die('REFUSED. "' + key + '" matches the deny list entry "' + d + '".' + NL
        + 'That is a company-issued machine. Granting it the personal vault hands over every '
        + 'credential the owner owns. Do not override this without him saying so in the conversation, '
        + 'and if he does, grant single secrets with --to, never --all.');
    }
  }
  const f = join(REQUESTS, key + '.json');
  if (!existsSync(f)) die('No request from "' + key + '". Run: node tools/vault.mjs requests');
  const req = JSON.parse(readFileSync(f, 'utf8'));
  if (!/^age1[0-9a-z]{50,}$/.test(req.pubkey)) die('The request does not contain a valid age public key.');
  r.machines[key] = { pubkey: req.pubkey, added: today(), note: req.note || '' };
  saveRecipients(r);
  const v = loadVault();
  let done = 0; const skipped = [];
  for (const [n, box] of Object.entries(v.secrets)) {
    if (!isV2(box)) { skipped.push(n + ' (still v1)'); continue; }
    const dk = openDataKey(box);
    if (!dk) { skipped.push(n + ' (this machine cannot read it)'); continue; }
    box.keys[key] = wrapKey(dk, [req.pubkey]);
    done++;
  }
  saveVault(v);
  unlinkSync(f);
  process.stderr.write('approved ' + key + ', granted ' + done + ' secret(s)' + NL);
  for (const s of skipped) process.stderr.write('  skipped ' + s + NL);
  process.stderr.write('Commit and push so ' + key + ' can pull it.' + NL);

} else if (cmd === 'machines') {
  const r = loadRecipients();
  const v = loadVault();
  const names = Object.keys(r.machines).sort();
  if (!names.length) { process.stdout.write('no machines registered' + NL); }
  const me = thisMachine();
  for (const n of names) {
    const count = Object.values(v.secrets).filter((b) => b.keys && b.keys[n]).length;
    process.stdout.write(n.padEnd(22) + String(count).padStart(3) + ' secret(s)  added ' + r.machines[n].added
      + (n === me ? '  <- this machine' : '') + (r.machines[n].note ? '  ' + r.machines[n].note : '') + NL);
  }

} else if (cmd === 'set') {
  if (!name) die('usage: vault.mjs set <name> [--to MACHINE,MACHINE] [--note "..."]   (value on stdin)');
  requireAge();
  const value = readStdin();
  if (!value) {
    die('No value on stdin. Pipe it in, never pass it as an argument: argv is visible to other '
      + 'processes and lands in shell history.');
  }
  const v = loadVault();
  const existed = !!v.secrets[name];
  const targets = resolveRecipients();
  v.secrets[name] = {
    ...encryptV2(value, pubkeysOf(targets)),
    updated: today(),
    note: getFlag('note') || (v.secrets[name] && v.secrets[name].note) || '',
  };
  v.version = 2;
  saveVault(v);
  process.stderr.write((existed ? 'updated ' : 'stored ') + name + ' for: ' + Object.keys(targets).join(', ') + NL);

} else if (cmd === 'get') {
  if (!name) die('usage: vault.mjs get <name>');
  const v = loadVault();
  const box = v.secrets[name];
  if (!box) die('No secret named "' + name + '". Run: node tools/vault.mjs list');
  process.stdout.write(readSecret(box, name));

} else if (cmd === 'grant') {
  // Rewrap an existing secret for another machine. Never re-encrypts the value, and the plaintext
  // never exists outside memory: only the 32-byte data key is unwrapped and rewrapped.
  requireAge();
  const to = getFlag('to');
  if (!to) die('usage: vault.mjs grant <secret>|--all --to MACHINE[,MACHINE]');
  const registry = loadRecipients();
  const reg = registry.machines;
  const targets = {};
  for (const raw of to.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    if (!reg[raw]) die('Unknown machine "' + raw + '". Register it first with machine-add.');
    // The deny list guards `grant` too, not just `approve`. It only guarded approve until
    // 2026-08-21, and grant is the command actually used when a machine registers itself with
    // machine-add, so the guard was on the path nobody takes.
    for (const d of registry.denied || []) {
      if (raw.includes(d)) {
        die('REFUSED. "' + raw + '" matches the deny list entry "' + d + '".' + NL
          + 'That is a company-issued machine. Granting it the personal vault hands over every '
          + 'credential the owner owns, and the wrapped key stays in git history forever, so it cannot '
          + 'be taken back. Do not override without him saying so in the conversation.');
      }
    }
    targets[raw] = reg[raw].pubkey;
  }
  const v = loadVault();
  const all = process.argv.includes('--all');
  const which = all ? Object.keys(v.secrets) : [name].filter(Boolean);
  if (!which.length) die('Name a secret, or pass --all');
  let done = 0; const skipped = [];
  for (const n of which) {
    const box = v.secrets[n];
    if (!box) die('No secret named "' + n + '"');
    if (!isV2(box)) { skipped.push(n + ' (still v1, run migrate first)'); continue; }
    const dk = openDataKey(box);
    if (!dk) { skipped.push(n + ' (this machine cannot decrypt it, so it cannot grant it)'); continue; }
    for (const [m, pub] of Object.entries(targets)) box.keys[m] = wrapKey(dk, [pub]);
    done++;
  }
  saveVault(v);
  process.stderr.write('granted ' + Object.keys(targets).join(', ') + ' access to ' + done + ' secret(s)' + NL);
  for (const s of skipped) process.stderr.write('  skipped ' + s + NL);

} else if (cmd === 'revoke') {
  const from = getFlag('from');
  if (!from || !name) die('usage: vault.mjs revoke <secret>|--all --from MACHINE');
  const key = from.trim().toUpperCase();
  const v = loadVault();
  const which = process.argv.includes('--all') ? Object.keys(v.secrets) : [name];
  let n = 0;
  for (const s of which) {
    const box = v.secrets[s];
    if (box && box.keys && box.keys[key]) { delete box.keys[key]; n++; }
  }
  saveVault(v);
  process.stderr.write('stripped ' + key + ' from ' + n + ' secret(s).' + NL
    + 'THIS IS NOT REVOCATION: the old wrapped key is in git history forever. Rotate the real '
    + 'credential at the provider if that machine is untrusted.' + NL);

} else if (cmd === 'list') {
  const v = loadVault();
  const names = Object.keys(v.secrets).sort();
  if (!names.length) { process.stdout.write('vault is empty' + NL); }
  const me = thisMachine();
  for (const n of names) {
    const s = v.secrets[n];
    const who = isV2(s) ? Object.keys(s.keys).join(',') : 'v1-passphrase';
    const mine = isV2(s) ? (s.keys[me] ? '' : '  [NOT readable here]') : '';
    process.stdout.write(n.padEnd(34) + 'updated ' + s.updated + '  [' + who + ']' + mine
      + (s.note ? '  ' + s.note : '') + NL);
  }

} else if (cmd === 'rm') {
  if (!name) die('usage: vault.mjs rm <name>');
  const v = loadVault();
  if (!v.secrets[name]) die('No secret named "' + name + '"');
  delete v.secrets[name];
  saveVault(v);
  process.stderr.write('removed ' + name + NL);

} else if (cmd === 'migrate') {
  // v1 passphrase entries to v2 per-machine envelopes. Refuses to start unless every entry can be
  // decrypted, so a partial migration cannot lose a secret.
  requireAge();
  const pass = loadPassphrase(true);
  const v = loadVault();
  const v1 = Object.entries(v.secrets).filter(([, b]) => !isV2(b));
  if (!v1.length) { process.stderr.write('nothing to migrate, every secret is already v2' + NL); process.exit(0); }
  if (!pass) die('This machine has no v1 passphrase, so it cannot read the old entries. Run migrate where the passphrase is.');
  const plain = {};
  for (const [n, box] of v1) {
    try { plain[n] = decryptV1(box, pass); }
    catch { die('Cannot decrypt "' + n + '" with the current passphrase. Aborting so nothing is lost.'); }
  }
  const targets = resolveRecipients();
  writeFileSync(VAULT + '.v1.bak', JSON.stringify(v, null, 2) + NL, 'utf8');
  for (const [n, val] of Object.entries(plain)) {
    v.secrets[n] = { ...encryptV2(val, pubkeysOf(targets)), updated: today(), note: v.secrets[n].note || '' };
  }
  v.version = 2;
  saveVault(v);
  process.stderr.write('migrated ' + Object.keys(plain).length + ' secret(s) to per-machine keys for: '
    + Object.keys(targets).join(', ') + NL
    + 'Backup of the v1 file: ' + VAULT + '.v1.bak (gitignored, delete once verified)' + NL);

} else {
  process.stdout.write([
    'vault.mjs, encrypted secrets stored in the brain, unlocked per machine',
    '',
    'machines',
    '  machine-init                 create THIS machine key, print its PUBLIC key',
    '  machine-add <NAME> <age1..>  register another machine public key',
    '  machine-rm <NAME>            unregister and strip its wrapped keys',
    '  machines                     who is registered and how many secrets each can read',
    '',
    'secrets',
    '  set <name> [--to A,B]        store a value read from STDIN, never from argv',
    '  get <name>                   print a value to stdout',
    '  list                         names, dates and who can read them, never values',
    '  rm <name>                    delete a secret',
    '  grant <name>|--all --to A    give a machine access without re-encrypting',
    '  revoke <name>|--all --from A strip a machine (then rotate the real credential)',
    '  migrate                      convert v1 passphrase entries to per-machine keys',
    '',
    'This machine: ' + thisMachine() + (existsSync(AGEKEY) ? ' (has an age key)' : ' (NO age key, run machine-init)'),
    '',
  ].join(NL));
}
