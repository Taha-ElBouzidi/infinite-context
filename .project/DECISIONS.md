# DECISIONS.md, Architectural and Product Decisions

Append-only. This is the permanent "why" record.
CHANGELOG captures chronology (what happened). DECISIONS captures rationale (why it happened).
Never conflate the two.

Each entry uses the format below. Add new entries at the bottom.

---

## [2026-09-05] Memories are markdown files, one fact per file

**Status:** Active

**Decision:** The source of truth is a directory of plain markdown files with frontmatter. Every
index is derived from them and can be rebuilt at any time.

**Why:** The owner must be able to read, diff, grep and edit their own memory with no tool in the
way. A database hides the contents behind a schema and a client, and makes "what does my agent
believe" a query instead of a glance.

**Rejected:** A vector database as the primary store. Faster to query, impossible to audit by eye,
and it makes the memory hostage to one library.

**Decider:** Repository owner

---

## [2026-09-05] Recall returns pointers, never memory bodies

**Status:** Active

**Decision:** The hook injects up to five pointers per prompt, each a slug, a one-line description
and a file path. The agent opens the files it needs.

**Why:** Five come back and typically one or two matter. Injecting all five bodies would multiply the
per-prompt cost to save a single file read, and more context makes a model worse, not better.

**Rejected:** Injecting full memory text. Simpler for the agent, ruinous for the prompt.

**Decider:** Repository owner

---

## [2026-09-05] Only the description is indexed

**Status:** Active

**Decision:** The retrieval surface is the slug and the one-line `description`, nothing in the body.

**Why:** Indexing bodies was tried and measured on 2026-08-07 and made both precision and recall
worse. Forcing the description to carry the meaning makes every memory findable on purpose.

**Rejected:** Full-text indexing. Measured worse.

**Decider:** Repository owner

---

## [2026-09-05] Behaviour rules are memories

**Status:** Active

**Decision:** Any memory with a `rule:` line is injected on every turn. There is no separate rules
file to maintain.

**Why:** Rules used to be duplicated in several documents and drifted. One source, generated into
the injection, cannot drift. It also means an empty brain has no rules, which is why five generic
seeds ship.

**Rejected:** A hardcoded rules list in the hook. It was the previous design and it drifted.

**Decider:** Repository owner

---

## [2026-09-05] Local-only is the first release; multi-machine mode stays undocumented

**Status:** Active

**Decision:** 0.1.0 documents and supports one machine with no server. The client-server mode
exists in the code and is used by the authors but is not documented for outside use.

**Why:** Local mode needs Node and nothing else, and removes every hard part: no private network,
no TLS, no tokens, no vault. Ship the thing that cannot fail on a stranger's machine first.

**Rejected:** Shipping both modes at once. The multi-machine mode has a support cost the project
cannot yet carry.

**Decider:** Repository owner

---

## [2026-09-05] AGPL-3.0 with a Contributor Licence Agreement

**Status:** Active

**Decision:** The licence is AGPL-3.0. Every contribution requires a signed CLA granting the owner
the right to relicense. Commercial licences are offered by the owner.

**Why:** Open source with contributions, and the owner still able to sell it, is only possible if
the owner holds relicensing rights to every line. Without the CLA that right is lost with the first
outside pull request, permanently.

**Rejected:** MIT or Apache, which let anyone fork, close and resell. A DCO alone, which does not
grant relicensing rights.

**Decider:** Repository owner

---

## [2026-09-05] Everything instance-specific lives in brain.json and is never committed upstream

**Status:** Active

**Decision:** Owner name, pronoun, required rules, restricted machines, git identity and the
anonymisation tables live in `brain.json`, ignored by the upstream repository.

**Why:** The engine source must name nobody. Publishing the authors' original repository would have
published their life, their clients and their network. The split is what makes publishing possible.

**Rejected:** Environment variables for everything. Fine for a machine, invisible to a reader.

**Decider:** Repository owner

---

## [2026-09-05] The hook resolves the brain it lives in before any global marker

**Status:** Active

**Decision:** Resolution order is the `HAVOK_BRAIN` environment variable, then the hook's own
parent directory, then the marker file in the config directory.

**Why:** `install-hook.mjs` registers a specific path on purpose. With the marker second, a second
brain installed on a machine that already had one silently recalled from the first. Found by
cloning the export on a machine that had a brain.

**Rejected:** Marker before own location, the previous order.

**Decider:** Repository owner
