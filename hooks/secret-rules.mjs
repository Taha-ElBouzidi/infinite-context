// The secret scan of a git commit, in one place: check-secrets.mjs (the command hook) and the mod import
// this file. Pure: no Node imports. Only added lines of the staged diff are scanned (not the +++ file header).
//
// A scan that does not finish never lets the commit through (the owner 2026-11-02: hooks "go past the time we allow
// them and no issue"; a timed-out safety hook let the action run). Its callers refuse with SCAN_UNFINISHED.

export const SECRET_PATTERNS = [
  { name: 'Google OAuth client secret', re: /GOCSPX-[A-Za-z0-9_-]{8,}/ },
  { name: 'OpenAI-style API key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Stripe-style key', re: /sk_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer token', re: /[Bb]earer\s+[A-Za-z0-9._-]{24,}/ },
];

// Bash and PowerShell both run git (the PowerShell tool was never scanned before 2026-11-02).
export const isShell = (tool) => tool === 'Bash' || tool === 'PowerShell';
const COMMIT_AT = /\bgit\b[^|;&]*\bcommit\b/;
export const isCommitAttempt = (cmd) => COMMIT_AT.test(String(cmd || ''));

// The folder the commit runs in. A command often moves first (`cd <repo> && git commit`, PowerShell's Set-Location,
// `git -C <repo> commit`); checking the session's folder then scans the wrong repository. A move this cannot follow
// ($VAR, ~, cd -, popd) keeps `base`, the session's folder, as before.
const SEP = /&&|\|\||;|\r?\n/;
const MOVE = /^(?:cd|chdir|pushd|sl|set-location|push-location)(?:\s+-(?:path|literalpath))?\s+(.+)$/i;
const BLIND = /^(?:cd|chdir|popd|pop-location)\s*$/i;
const unquote = (s) => {
  const t = String(s).trim();
  const q = /^"([^"]*)"$|^'([^']*)'$/.exec(t);
  return q ? (q[1] ?? q[2]) : /\s/.test(t) ? '' : t;
};
const readable = (p) => !!p && p !== '-' && !/[$%`~*?]/.test(p);
const into = (dir, p) => {
  let x = p.replace(/\\/g, '/');
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(x);
  if (msys) x = msys[1].toUpperCase() + ':' + (msys[2] || '/');
  x = x.replace(/(.)\/+$/, '$1');
  return /^([a-zA-Z]:)?\//.test(x) ? x : dir.replace(/[\\/]+$/, '') + '/' + x;
};
export function commitDir(cmd, base) {
  const s = String(cmd || '');
  const b = String(base || '');
  const m = COMMIT_AT.exec(s);
  if (!m) return b;
  let dir = b;
  for (const raw of s.slice(0, m.index).split(SEP)) {
    const part = raw.trim().replace(/^[({]\s*/, '');
    if (BLIND.test(part)) return b;
    const mv = MOVE.exec(part);
    if (mv) {
      const p = unquote(mv[1]);
      if (!readable(p)) return b;
      dir = into(dir, p);
    }
    if (raw.includes(')') || raw.includes('}')) dir = b;
  }
  for (const c of m[0].matchAll(/\s-C\s+("[^"]*"|'[^']*'|\S+)/g)) {
    const p = unquote(c[1]);
    if (!readable(p)) return b;
    dir = into(dir, p);
  }
  return dir;
}

export function addedLines(diff) {
  return String(diff || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
}

export function secretsIn(diff) {
  const added = addedLines(diff);
  return SECRET_PATTERNS.filter((p) => p.re.test(added)).map((p) => p.name);
}

export function secretDenyReason(hits) {
  return 'Blocked: the staged diff appears to contain a secret (' + hits.join(', ') + '). Do not commit credentials. Remove the secret, move it to an env var or .gitignored file, restage, and retry.';
}

export const SCAN_UNFINISHED = 'Blocked: the secret scan of the staged diff did not finish in time, so this commit was not checked and did not run. Run the same commit again; if it keeps happening, check git diff --cached yourself for a secret first.';
