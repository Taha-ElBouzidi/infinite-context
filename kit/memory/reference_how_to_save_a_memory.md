---
name: How to save a memory
description: Remember this, keep that in mind, from now on, note that, update what you know: how to save one lasting fact as a memory, check for duplicates, link it, replace an outdated one, and index it.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to save a memory

Memory lives in the brain folder, one memory per Markdown file, one file holding exactly one thing. It gets saved the moment it is learned, not gathered up and written at the end of a session, because a session's context does not persist and a fact left unwritten is a fact lost.

## What makes a good memory

- One thing per file. If the description needs the word "also", that is two memories, not one with two ideas glued together.
- The description is how the memory is ever found again: write it in the words that would actually be used to ask for it, and say when it should be read. Recall only searches the name, the description, and the start of the body, so a fact that lives only deeper in the body is invisible to search.
- The body has four parts: the fact itself; its source, meaning the exact words and date it came from, or the file, command, or test that proved it; its scope, meaning which system, place, or period it applies to; and why it matters.
- Dates matter: when a memory is first written down, and again whenever it changes.
- Before writing, check whether the fact is already there. If it is, that existing memory gets updated; a fact never gets a second, competing memory.
- Every memory links to at least one other memory it depends on, changes, or is normally used alongside, and only for a real relation, not a token link to satisfy a rule.
- When a fact changes, the old memory is replaced rather than left standing next to a new, contradicting one. Two memories that disagree mean one of them is quietly wrong and nobody notices until it causes a real mistake.
- What does not belong in memory: a narrative of the session, anything a codebase or its history already records on its own, a temporary status that will be stale by next week, and never a password, key, or token.

## The file itself

Named `memory/<type>_<short_slug>.md`, where type is one of user, contact, project, feedback, or reference, and feedback is specifically for rules and corrections. The filename must start with its type, because a mismatch between the filename and the declared type silently misfiles the memory.

```
---
name: <short title>
description: <the words that would be used to ask for this, and when to read it>
type: <user | contact | project | feedback | reference>
metadata:
  type: <same type as the file name>
  asserted: YYYY-MM-DD
---

<the fact, its source, its scope, why it matters>

## Related
<the slugs of related memories, each in double square brackets>
```

A rule that must be surfaced on every turn, rather than only when recalled, additionally carries the full rule text, a one-line short form, and an ordering value in the front matter. This is added rarely, because every such rule adds to what loads by default on every single turn.

## Steps, in order

1. Look for an existing match first, running the brain's duplicate-check tool against the draft description, from the brain folder.
2. Write the draft file, then run the same tool against the file itself. A result meaning it is genuinely new means write it; a result meaning it already exists means update that memory instead; a result listing related memories means link them in.
3. To retire an outdated memory, write its replacement first, carrying forward whatever history is still useful, then run the brain's replace tool naming the old and new memory and the reason, from the brain folder.
4. Rebuild the index, from the brain folder. Skipping this step means the memory exists on disk but recall cannot find it.
5. State in one line what was saved.

## Related
[[reference_how_to_write_a_document]] [[reference_how_to_set_and_follow_a_goal]] [[feedback_one_fact_one_memory]]
