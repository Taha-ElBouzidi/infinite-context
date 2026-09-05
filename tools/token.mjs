// Issue, list and revoke SCOPED server tokens.
//
// Why scopes exist, found 2026-08-24: /vault/get authenticated on the shared bearer token and never
// checked which machine was asking, so any machine holding it could read every secret the owner owns.
// Moving the age keys to the server did not reduce that, it only changed the route. It also left no
// middle setting: "can do recall" and "can read every credential" were the same permission, so a
// company laptop could not be given recall without being given the vault.
//
//   full    everything, including /vault/*. Only the server's own token should have this.
//   recall  /recall, /embed, /rules, /index/*, /memory/*. The server returns 403 on /vault/*.
//
// Tokens live in havok-tokens.json under CONFIG_DIR (HAVOK_HOME, else ~/.claude), server side only.
// NEVER in git: the file sits outside the repo and .gitignore already covers the pattern.
//
// Usage:
//   node tools/token.mjs issue <NAME> [--scope recall|full]   mint one, write it to a file
//   node tools/token.mjs list                                 names, scopes, dates. Never values.
//   node tools/token.mjs revoke <NAME>                         remove it
//   node tools/token.mjs show <NAME> --out <path>              re-export the value to a file

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const FILE = resolve(CONFIG_DIR, 'havok-tokens.json');
const SCOPES = ['recall', 'full'];

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
function save(db) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
  // Lock it down. On Windows chmod is a no-op, so follow with an ACL that actually applies.
  try { chmodSync(FILE, 0o600); } catch { /* not posix */ }
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [FILE, '/inheritance:r', '/grant:r', process.env.USERNAME + ':(R,W)', '/grant:r', 'SYSTEM:(F)'],
        { stdio: 'ignore', timeout: 15000 });
    } catch { /* best effort: the file is outside the repo either way */ }
  }
}

const [cmd, name] = process.argv.slice(2);
const flag = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };

if (cmd === 'issue') {
  if (!name) { console.log('usage: node tools/token.mjs issue <NAME> [--scope recall|full]'); process.exit(1); }
  const scope = flag('--scope', 'recall');
  if (!SCOPES.includes(scope)) { console.log('scope must be one of: ' + SCOPES.join(', ')); process.exit(1); }

  const db = load();
  // One token per name. Re-issuing replaces the old one, which is how rotation works: the previous
  // value stops being accepted the moment the server reloads.
  for (const [tok, meta] of Object.entries(db)) if (meta.name === name) delete db[tok];

  const value = randomBytes(32).toString('base64url');
  db[value] = { name, scope, issued: new Date().toISOString() };
  save(db);

  // The value is written to a FILE, never printed. A token echoed into a terminal lands in
  // scrollback, in a transcript, and in whatever captures stdout. That has already happened once
  // in this project and the credential had to be treated as burned.
  const out = flag('--out', join(CONFIG_DIR, 'issued-' + name + '.token'));
  writeFileSync(out, value, 'utf8');
  console.log('issued ' + name + '  scope=' + scope);
  console.log('value written to: ' + out);
  console.log('Move that file to the target machine as ~/.claude/havok-server-token, then DELETE it here.');
  console.log('Restart the server so it reloads the token list: Start-ScheduledTask -TaskName HavokBrainServer');
} else if (cmd === 'list') {
  const db = load();
  const rows = Object.values(db);
  if (!rows.length) { console.log('no scoped tokens issued. The server token itself is always scope=full.'); process.exit(0); }
  console.log('SERVER'.padEnd(16) + 'full'.padEnd(10) + '(the built-in token, not listed in this file)');
  for (const m of rows.sort((a, b) => String(a.name).localeCompare(b.name))) {
    console.log(String(m.name).padEnd(16) + String(m.scope).padEnd(10) + 'issued ' + String(m.issued).slice(0, 10));
  }
} else if (cmd === 'revoke') {
  if (!name) { console.log('usage: node tools/token.mjs revoke <NAME>'); process.exit(1); }
  const db = load();
  let n = 0;
  for (const [tok, meta] of Object.entries(db)) if (meta.name === name) { delete db[tok]; n++; }
  save(db);
  console.log(n ? 'revoked ' + n + ' token(s) for ' + name : 'no token found for ' + name);
  if (n) console.log('Restart the server so it stops accepting it: Start-ScheduledTask -TaskName HavokBrainServer');
} else if (cmd === 'arm') {
  // Arm a ONE-SHOT bootstrap so a machine can collect its own token over the connection it already
  // has. Needed because Taildrop failed on the the client company link while its HTTPS requests arrived
  // fine. The tailnet IP is the identity: a 100.64.0.0/10 address is cryptographically bound to a
  // WireGuard node key and cannot be spoofed from outside the tailnet.
  const ip = flag('--ip', null);
  if (!name || !ip) { console.log('usage: node tools/token.mjs arm <NAME> --ip <tailnet-ip>'); process.exit(1); }
  if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) {
    console.log('refusing: ' + ip + ' is not a tailnet address (100.64.0.0/10). Only a tailnet IP is an identity.');
    process.exit(1);
  }
  if (!Object.values(load()).some((m) => m.name === name)) {
    console.log('no token issued for ' + name + '. Run: node tools/token.mjs issue ' + name + ' --scope recall');
    process.exit(1);
  }
  const F = resolve(CONFIG_DIR, 'havok-bootstrap.json');
  let armed = {};
  try { armed = JSON.parse(readFileSync(F, 'utf8')); } catch { /* none yet */ }
  armed[name] = { ip, armed: new Date().toISOString() };
  writeFileSync(F, JSON.stringify(armed, null, 2), 'utf8');
  console.log('armed ' + name + ' for ' + ip + ', ONE SHOT.');
  console.log('That machine collects it with:');
  let epUrl = '<server url>';
  try { epUrl = String(JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url || epUrl); } catch { /* keep the placeholder */ }
  console.log('  curl -s --cacert <brain>/server-cert.pem ' + epUrl + '/bootstrap/' + name);
  console.log('Restart the server so it can read the arm: Start-ScheduledTask -TaskName HavokBrainServer');
} else if (cmd === 'show') {
  if (!name) { console.log('usage: node tools/token.mjs show <NAME> --out <path>'); process.exit(1); }
  const out = flag('--out', null);
  if (!out) { console.log('--out is required. The value is never printed to stdout.'); process.exit(1); }
  const hit = Object.entries(load()).find(([, m]) => m.name === name);
  if (!hit) { console.log('no token for ' + name); process.exit(1); }
  writeFileSync(out, hit[0], 'utf8');
  console.log('written to: ' + out);
} else {
  console.log('token.mjs, scoped server tokens');
  console.log('  issue <NAME> [--scope recall|full]   mint one, value written to a file');
  console.log('  list                                 names and scopes, never values');
  console.log('  revoke <NAME>');
  console.log('  arm <NAME> --ip <tailnet-ip>          one-shot self-collect over the tailnet');
  console.log('  show <NAME> --out <path>');
  console.log('');
  console.log('scope recall = /recall /embed /rules /index/* /memory/*, and 403 on /vault/*');
}
