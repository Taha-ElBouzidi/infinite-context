// The brain commit gate's rules (check-brain-commit.mjs and the mod import this file). Pure: no Node imports.
// A commit that touches the brain's code or rules must pass tools/verify.mjs: a syntax error in hooks/ blocks every
// Write, Edit and Bash on every machine within one sync cycle, and a parse check catches it where ceremony did not.
// Scoped to git commit, never to Write or Edit: if this gate ever breaks, it blocks commits only, which is
// recoverable from any plain terminal.

export const COMMIT_CMD = /\bgit\b[^|;&]*\bcommit\b/;
export const VERIFY_MS = 120000;

// Memory-only commits used to skip the checks, reasoning that a fact cannot brick a session. That stopped being true
// when the always-on behaviour rules moved INTO memory frontmatter: memory/*.md plus index/rules.json ARE the rules
// pipeline, so a commit deleting a rule was waved through. Touching the rules is always risky now.
export function needsVerify(stagedNames) {
  const files = String(stagedNames || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const touchesRules = files.some((f) => f === 'index/rules.json' || (f.startsWith('memory/') && f.endsWith('.md')));
  const risky = files.filter((f) => !/^(memory|index)\//.test(f));
  return { files, risky, verify: files.length > 0 && (risky.length > 0 || touchesRules) };
}

export function failedReason(riskyCount, detail) {
  return 'Brain verification FAILED, commit blocked. This commit touches ' + riskyCount
    + ' non-memory file(s) and would leave the shared brain broken for every machine.\n\n' + detail + '\n\nFix, then re-run: node tools/verify.mjs';
}

// A verifier that does not finish blocks too (The owner, 2026-11-02: no safety check lets an action through because it was
// slow). Before, a hung verifier let the commit through so it could not wedge the session; the commit still can be
// made once verify runs, or from a plain terminal.
export const HUNG_REASON = 'Brain verification did not finish within 120 s, so this commit was not checked and did not run. Run node tools/verify.mjs to see what hangs, then commit again.';
