# Infinite Context

This directory is a memory system for the agent reading this. You never lose a fact, and you load
almost nothing on any given turn. More context in the window makes you worse, not better: attention
dilutes and cost rises. Load small, recall deep.

If you are installing it, read `AGENTS.md` first. It is written for you and every step is verifiable.

## How recall reaches you

A hook runs on every prompt. It injects the always-on rules and up to five pointers, each a slug and
a one-line description, with the path to the file. **Open the files it names. Never answer from the
description.** The description tells you whether a file is worth opening, not what it says.

## Tiered loading

| Tier | What | When |
|---|---|---|
| 0 | `REFLEX.md` | Always. The never-miss rules and the recall loop. Tiny on purpose. |
| 1 | `memory/MEMORY.md` | Always. The router: counts, active projects, where to look. |
| 2 | `index/<type>.md` | On demand, when you need something of that kind. |
| 3 | `memory/<file>.md` | Only the specific memories the task needs. |

Do not read every index at session start. Pull the tier the task requires and nothing more.

## Writing a memory

One fact, one file, under `memory/`, named `<type>_<slug>.md` where type is one of `user`,
`contact`, `project`, `feedback`, `reference`. Frontmatter:

```
---
name: <short title>
description: <one line, in the words the person would type when looking for this>
type: <same as the filename prefix>
metadata:
  type: <same again>
  asserted: YYYY-MM-DD
---
```

- **The description is the retrieval surface.** Only the slug and the description are indexed, never
  the body. A vague description makes a memory unfindable.
- **A rule is a memory with a `rule:` line.** It is injected on every turn. Add `rule_order: N`.
- **Link with `[[slug]]`.** A memory with no links in or out fails the gate.
- **Never store secrets.**

After writing, run `node tools/build-index.mjs`.

## The gate

`node tools/verify.mjs` before any commit. It parses every tool and hook, checks the index matches
`memory/`, and requires reflection to be clean. Never bypass a failing gate. Fix the brain instead.

## The rule above all rules

Knowledge flows one way: into the memory, then out to every future session. If it is worth
knowing, it goes in the brain in the same turn you learned it, never later.
