# WORKFLOW.md, Branching, Commits, PRs, Versioning

*Living document. Update when workflow rules evolve.*

## Branch Structure

```
main                 <- STABLE. What users clone. Every commit passes the release gate. Tagged releases.
  ^  merged from develop when a release is cut
develop              <- INTEGRATION. Where pull requests land. Always passes verify.mjs.
  ^
feature/*  fix/*     <- short-lived work branches, one task each, from develop
hotfix/*             <- from main, merged to main AND develop
docs/*               <- documentation only
```

This is the model most open-source projects that ship installable software use: GitHub Flow on
`main` (short-lived branches, `main` always shippable, releases are tags) with one integration
branch, `develop`, so a release can batch several merges and be verified as a whole before users
see it. Full Git Flow (`release/*` branches) is deliberately not used; it suits scheduled releases
by large teams and adds ceremony this project does not need.

References read before choosing, September 2026: the comparisons at inventivehq.com
(GitFlow vs GitHub Flow vs Trunk-Based), deployhq.com (GitHub Flow, GitFlow, GitLab Flow, Release
Flow) and harness.io (GitHub Flow vs Git Flow). Their shared conclusion: GitHub Flow for open
source and small teams, GitFlow for formal release cycles, and picking one and sticking to it
matters more than which.

## Branch Rules

| Branch | Purpose | Protection |
|---|---|---|
| `main` | Stable. Users clone this. A release is a tag here. | PR required, owner review, no force-push |
| `develop` | Integration. Every PR targets this. | PR required, owner review, CLA signed, no force-push |
| `feature/*`, `fix/*`, `docs/*` | One task per branch, from `develop`. Short-lived. | None: merge via PR to `develop` |
| `hotfix/*` | Emergency, from `main`. | Merge to `main`, then to `develop` so it is not lost |

**Rules:**
- Nobody pushes directly to `main` or `develop`: PRs only, including the owner
- A release is `develop` merged into `main` and tagged `vX.Y.Z`, never the other way
- Work branches are deleted after merge

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

1. Create a `feature/*` or `fix/*` branch from `develop`
2. Implement, run `node tools/verify.mjs`, commit with conventional messages
3. Update `.project/CHANGELOG.md`, and `.project/STRUCTURE.md` if files moved
4. Open a PR to `develop` using the template
5. Sign the CLA when the bot asks, once, on your first PR
6. Owner reviews and merges. Branch is deleted.

## Versioning

Semantic versioning. A change to the memory file format, the frontmatter contract, or the hook
injection format is a major version. New tools and flags are minor. Fixes are patch.
