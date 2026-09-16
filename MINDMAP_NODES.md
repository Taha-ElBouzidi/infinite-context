# Adding Nodes to the Mind Map (through memory)

The mind map is generated from this brain's `memory/` markdown files. You do not edit the map directly. You add a memory file, and the next rebuild turns it into a node. These are the rules any conversation follows to put a node on the map.

## The one rule that matters

One markdown file in `memory/` equals one node on the map. `MEMORY.md` is the index, not a node, and is skipped. Everything else in `memory/*.md` becomes a node.

## File shape

```
---
name: <human Title, or a kebab-slug>
description: <one line summary>
type: <user | contact | project | feedback | reference>
---

<body: one fact per line>
```

- `name` is the node label. A title with spaces is kept as written. A kebab-slug has its type prefix stripped and is title-cased (so `project_mahara` shows as "Mahara").
- `description` is a one line summary for recall. It does not change the graph shape.

## Where the node lands (regions)

`type` decides which of the four fixed regions the node hangs under. There are only four, and they are fixed:

- `user`, `contact` land under IDENTITY (people).
- `project` lands under PROJECTS (work, clients, builds, products).
- `feedback`, `feedback_rule` land under RULES & FEEDBACK (how the assistant is told to operate).
- `reference` lands under REFERENCES (tools, links, external pointers).

Any other value, or a missing type, falls back to REFERENCES. So always set a correct `type`.

**`type` must be TOP LEVEL.** A `type` nested under a `metadata:` block is invisible to the
map. Two schemas drifted into the brain and 65 of 95 files nested it, so the map filed them
all as REFERENCES and looked almost uncategorised. `node tools/reflect.mjs` now fails on
this (the "Mind-map contract" check), and `tools/fix-mindmap-type.mjs` repairs it in bulk.

## Detail dots (the small nodes around a memory)

Every non-trivial line in the body (more than two characters) becomes its own small detail node hanging off the memory. Put each fact on its own line or bullet. Markdown markers (bullets, numbering, headings, bold, code, strikethrough) are stripped for the label; the full line opens in the side panel when clicked. The visible detail label is the first few words, so lead each line with its point.

## Edges (connecting nodes)

To connect your node to another, write a wikilink in the body: `[[Target Name]]`. An edge is drawn only when `Target Name` resolves to an existing memory file (matched loosely against that file's `name`, its filename, or its title). A wikilink to something that has no file is shown as plain text, not an edge. So:

- To attach a node to a hub (a company, a project, a person), wikilink that hub's exact node name, and make sure the hub has its own memory file.
- Link both directions when it helps readability, but one resolvable link already creates the edge.

## There is no nested sub-hub

A node cannot be nested inside another node as a private branch. Every node sits under one of the four regions by its type, plus whatever wikilinks you add. To make a cluster form around a project (for example all the people and pieces of one venture), give each related file a `[[Project Node]]` link. They will pull together visually around that project node through those edges, while still belonging to their type region.

If you genuinely need a separate, branded map with its own centre node (its own brain, for example a a client assistant map centred on "a client Assistant" rather than HAVOK), do not try to force it into this map. Stand up a separate copy of the mind map pointed at a separate memory folder, using these environment variables on that deployment:

- `BRAIN_MEMORY_DIR`: path to that brain's own `memory/` folder (its nodes).
- `BRAIN_CORE_NAME`: the centre node label (for example `a client Assistant`). Defaults to `HAVOK`.
- `BRAIN_CORE_BLURB`: one line shown on the centre node. Optional.
- `BRAIN_LINK_TO`: the parent brain to link back to (for example `HAVOK`). This adds a node for the parent and an edge from the centre to it, so the two maps read as connected.

That produces a separate map with its own centre, linked to the main one, not a sub-hub inside it. The main map leaves all these unset and is unchanged.

## Hygiene

- Plain language only: no em dashes, no emojis, no arrows, no checkmarks. The hooks block these on commit.
- Keep node names unique and human-readable. Duplicate labels get a numeric suffix automatically, which reads badly, so avoid collisions.
- No secrets in any memory file (bank numbers, passwords, residential addresses).
- Do NOT hand-edit `MEMORY.md` or `index/`. They are GENERATED from frontmatter by
  `node tools/build-index.mjs`, which the git pre-commit hook runs for you. The old rule
  said to add a pointer line by hand; that stopped being true when the index became derived.

## How it goes live

The map rebuilds automatically: a GitHub Action fires on any push under `memory/`. Once
your file is on master the node appears within a few minutes, and you deploy nothing. There
is no cron: a 15-minute heartbeat used to run 24/7 and burned Actions minutes into billing
overage without doing useful work, so it was removed on 2026-07-17. Use `workflow_dispatch`
for a manual re-sync if you suspect drift.

## Who may write

Per `GOVERNANCE.md`: adding a node (a new memory file) or updating one is a direct push to master, any node, no PR. You only open a pull request to remove or gut a shared node, or for non-memory changes (methodology, hooks, config). So adding nodes is friction-free; deletions get reviewed.
