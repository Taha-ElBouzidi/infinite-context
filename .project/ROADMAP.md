# ROADMAP.md, Sprint Plan and Backlog

*Living document. Update at the start and end of each sprint.*

## Current: 0.1.0, local-only mode

**Goal:** A stranger clones it, runs two commands, and has working memory in Claude Code.
**Started:** 2026-09-05
**Status:** shipped

### Done
- [x] Engine separated from the authors' instance; source names nobody
- [x] `init.mjs` seeds five generic rules; a fresh brain is never ruleless
- [x] `install-hook.mjs` wires Claude Code without clobbering existing settings
- [x] Clean-clone test with no environment variables passes the gate
- [x] Licence, CLA, security policy, governance, PR template, CODEOWNERS

---

## Next: 0.2.0

- [ ] macOS and Linux scheduling helpers (launchd, systemd timers) for the optional embedder
- [ ] Semantic recall on by default when the model is present, with a one-command model fetch
- [ ] A larger generic evaluation set so accuracy claims do not rest on the authors' own queries
- [ ] `AGENTS.md` tested with at least two agent runtimes other than Claude Code

---

## Backlog (prioritized)

| Priority | Task | Notes |
|---|---|---|
| P1 | Document multi-machine mode for outside use | Host, scoped tokens, per-machine encrypted secrets. It works; it is not written up. |
| P1 | Hook adapters for other agent runtimes | The injection format is the contract; the registration differs per tool |
| P2 | Rename `HAVOK_*` identifiers to `IC_*` with one release accepting both, then a deprecation window | Cosmetic mismatch with the product name; breaking for running instances, so it needs a migration, not a rename |
| P2 | An MCP server exposing recall and write | So agents that cannot run hooks can still use it |
| P2 | Memory import from existing notes | Markdown folders, Obsidian vaults |
| P3 | Web view of the memory graph | The wikilinks already form one |

---

## Milestones

| Milestone | Target | Status | Notes |
|---|---|---|---|
| 0.1.0 local-only | 2026-09-05 | shipped | clean-clone gate passes |
| 0.2.0 cross-platform | TBD | pending | macOS and Linux verified by someone who is not the author |
| 1.0.0 | TBD | pending | multi-machine mode documented and installed by an outside party |

---

## Explicitly out of scope (deferred)

- A hosted service. The whole point is that it runs where your data is.
- A GUI. The memory is markdown; your editor is the GUI.
