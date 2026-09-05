// PreToolUse hook (Bash, git commit only): scan the staged diff for secrets and
// block the commit if any are found. Fails open on any error.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

const ti = data.tool_input || {};
const cmd = String(ti.command || '');
if (!/git\s+commit/.test(cmd)) process.exit(0);

let diff = '';
try {
  diff = execSync('git diff --cached --no-color', { encoding: 'utf8', cwd: data.cwd || process.cwd() });
} catch { process.exit(0); }
if (!diff) process.exit(0);

const PATTERNS = [
  { name: 'Google OAuth client secret', re: /GOCSPX-[A-Za-z0-9_-]{8,}/ },
  { name: 'OpenAI-style API key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Stripe-style key', re: /sk_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer token', re: /[Bb]earer\s+[A-Za-z0-9._-]{24,}/ }
];

// Only scan added lines (start with + but not the +++ file header).
const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');

const hits = [];
for (const p of PATTERNS) {
  if (p.re.test(added)) hits.push(p.name);
}

if (hits.length) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Blocked: the staged diff appears to contain a secret (' + hits.join(', ') + '). Do not commit credentials. Remove the secret, move it to an env var or .gitignored file, restage, and retry.'
    }
  };
  process.stdout.write(JSON.stringify(out));
}
process.exit(0);
