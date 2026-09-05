# Brain Edit Governance

All machines and conversations belong to the owner. There are no external clients, and there
is exactly one reviewer. Governance is therefore **automated, not procedural**.

## The rule

**Every conversation, on every machine, may edit any part of the brain directly and push
to master.** Memory, METHODOLOGIES, REFLEX, hooks, tools, `.mcp.json`, structure. No pull
request, no queue, no waiting for a central authority.

**The gate is verification, not review.**

```
node tools/verify.mjs
```

It must pass before you push. It checks:

1. **Every hook and tool parses.** The one genuinely catastrophic failure. A syntax error
   in `hooks/` exits non-zero, and a non-zero PreToolUse hook blocks every Write, Edit, and
   Bash on every machine that pulls it. A hook's own try/catch cannot save it, because node
   fails before executing.
2. **Tier 0 and Tier 1 exist** (`REFLEX.md`, `memory/MEMORY.md`, `CLAUDE.md`,
   `METHODOLOGIES.md`). An agent that cannot load these has no rules and no router, and
   fails silently rather than loudly.
3. **The generated index matches `memory/`** (`build-index --check`).
4. **Reflection is clean** (`reflect.mjs`, zero findings): no contradictions, dead links,
   orphans, mistyped files, or stale entries.

## Where it is enforced

| Path | Mechanism |
|---|---|
| **Any commit, from anywhere** | `hooks/git/pre-commit` (native git hook, via `core.hooksPath`). Refreshes `updated` and the index and re-stages them, then runs `verify.mjs` if the commit touches anything outside `memory/` and `index/`. This is the real gate: it fires for terminal commits, scripts, other agents, and other machines. |
| A commit made through Claude Code | `hooks/check-brain-commit.mjs` runs the same verifier and denies with a readable reason. A nicer error on top of the git hook, not a replacement. |
| The unattended sync engine (every 5 min) | `hooks/sync-brain.mjs` verifies before staging. Passing, it stages everything. Failing, it stages `memory/` and `index/` only and logs `VERIFY-FAILED-held-non-memory(n)`, so facts keep flowing while broken tooling stays on that machine. |

All three paths are covered deliberately. Gating the careful path while leaving the
automated one open would protect nothing.

`core.hooksPath` is per-clone git config and is **not** carried by git, so a fresh clone
would treat `hooks/git/pre-commit` as an inert file. The session-start hook sets it
automatically on every machine, so no manual arming step is needed. To check:
`git config --get core.hooksPath` should print `hooks/git`.

The git hook also keeps `updated` honest on hand-made commits. Before it existed, that only
happened inside the sync engine, so committing a memory edit yourself left the date and the
index silently stale.

## Why this replaced the pull-request rule

Decided 2026-07-26.

The old rule said memory was open but every other brain change went by PR, reviewed by the
"Tier 1 central brain." In practice there was one reviewer, he merged without reading the
diff, and on 2026-07-26 three real bugs shipped into brain tooling in a single session: a
CRLF parse failure that silently emptied `name` and `description`, an index that
invalidated itself on every commit, and a stamper that flattened 88 dates in one run. The
PR process caught none of them. Negative tests and `reflect.mjs` caught all three.

A control that never fires is not a control. Worse, the PR rule was already fiction: the
sync engine ran `git add -A` every five minutes and pushed hooks and methodology straight
to master, so the written policy and the running system disagreed and the system was
winning.

So the ceremony is gone and a real gate took its place. Speed goes up (no queue, any
conversation can improve the brain the moment it learns something) and safety goes up (the
brick scenario is now impossible to commit). Those usually trade against each other; here
they did not, because the thing being removed was not providing safety.

## The one hard rule

**Never bypass a failing gate.** Do not use `--no-verify`, do not disable the hook, do not
commit around it. A red gate means the brain is broken for every machine. Fix the brain.

## Removing shared memory

Deleting or gutting a memory that other sessions rely on is still the highest-risk edit,
because it destroys knowledge rather than adding it. It does not need a PR, but it does
need the owner's explicit confirmation first, per the destructive-action gate in `REFLEX.md`:
show exactly what will be removed, then wait.
