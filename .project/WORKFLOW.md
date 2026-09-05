# WORKFLOW.md, Branching, Commits, PRs, Versioning

*Living document. Update when workflow rules evolve.*

## Branch Structure

```
main                 <- default branch, always installable, tagged releases
  ^
feature/*  fix/*     <- short-lived work branches, one task each
docs/*               <- documentation only, no code
```

This is a small open-source engine, not a multi-tier product. One protected branch is enough.

## Branch Rules

| Branch | Purpose | Protection |
|---|---|---|
| `main` | Always installable. Every commit passes `tools/verify.mjs` on a fresh clone. | PR required, owner review, CLA signed, no force-push |
| `feature/*`, `fix/*` | One task per branch. Short-lived. | None: merge via PR to `main` |
| `docs/*` | Documentation only. | None: merge via PR to `main` |

**Rules:**
- Nobody pushes directly to `main`: PRs only, including the owner
- Work branches are deleted after merge
- A release is a tag on `main`: `v0.1.0`, `v0.2.0`, following semantic versioning

## The gate

`node tools/verify.mjs` must pass before any commit. It parses every tool and hook, checks the index
matches `memory/`, and requires reflection to be clean. It is never bypassed. If it fails, fix the
cause, not the check.

The release gate is stricter: **a fresh `git clone` of `main` into an empty directory, with no
environment variables set, then exactly the README steps, must end with `BRAIN VERIFY PASSED`.**
Every release so far has found something by running that test that no amount of reading found.

## Commit Convention

Format: `type(scope): description`, lowercase, imperative, under 72 chars, followed by a body that
explains **why** and names what was measured.

| Type | When |
|---|---|
| `feat` | New capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Tests and measurement tools |
| `refactor` | Restructure, no behaviour change |
| `chore` | Maintenance, dependencies, config |

Examples:
```
feat(recall): fall back to a fetch command when the local memory file is absent
fix(hook): resolve the brain the hook lives in before the global marker
test(bench): report median and p95, never the mean
```

## PR Process

1. Create a `feature/*` or `fix/*` branch from `main`
2. Implement, run `node tools/verify.mjs`, commit with conventional messages
3. Update `.project/CHANGELOG.md`, and `.project/STRUCTURE.md` if files moved
4. Open a PR to `main` using the template
5. Sign the CLA when the bot asks, once, on your first PR
6. Owner reviews and merges. Branch is deleted.

## Versioning

Semantic versioning. A change to the memory file format, the frontmatter contract, or the hook
injection format is a major version. New tools and flags are minor. Fixes are patch.
