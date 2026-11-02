---
name: How to use the brain
description: Recall, what do you remember about, look in the brain, search the memory, is the brain down: how to use the brain on every message, open the memories that recall names, search in your own words before a task, say so first when recall fails, and check that what a memory names still holds before acting on it. Read before starting any task and whenever recall or the memory server fails.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: 8dad6218bd069d7d
---

# How to use the brain

The brain is a folder of Markdown memories, one fact per file. It is a recall system, not a context dump: only a few pointers reach each message, and the agent opens the files that matter.

## What good looks like

- At session start read `REFLEX.md` and `memory/MEMORY.md` in the brain folder and nothing else. The rest is recalled when a task needs it.
- Every message arrives with a `BRAIN RECALL` block from a hook, below the standing rules: memory names with the first words of their descriptions. Before answering, open each memory that could change what you do, using the path given. A description says whether a file is worth opening, never what it says.
- Before a task, ask the brain again in your own words. The hook searched the owner's raw message, which may be short or vague; you know the task.
- Brain first, other sources second. Say so when the brain had nothing.

## Search in your own words

| This install | Command or tool |
|---|---|
| a brain server is in use | `node tools/brain-client.mjs search "<need>" "<second need>"` |
| the tools `recall` and `read_memory` are in your tool list | call `recall` with your question |
| neither | search the `memory/` folder for a word (`grep -ril "<word>" memory/`), or read the lists in `index/<type>.md` |

Ask one full plain-English question per separate need, with names spelled out and "it" replaced by what it refers to. Add `--learned "<one sentence>"` for anything learned or corrected since the last message: the answer lists the closest existing memories, so you update one instead of writing a duplicate. Open a result with `node tools/brain-client.mjs read <memory-name>` or your file tool.

A single-machine install has no brain server, so `search` ends with "the brain server did not answer". The owner can run `node tools/setup-agents.mjs --check` to see how the `recall` tool would be added.

## When recall or the server is unavailable

Say so in your first sentence, before the answer. An answer from degraded memory that sounds sure is worse than none. The signs:

- no `BRAIN RECALL` block where one is expected: the hook is not wired, or the session was not restarted after wiring. `node tools/install-hook.mjs --check` reports whether it is wired and changes nothing.
- a line starting `NOTE: semantic recall missed this turn`: keyword matching only, so a paraphrase may be missed.
- "the brain server did not answer" or "NO TOKEN on this machine": the server is down, or this machine has no token for it.

`node tools/brain-client.mjs status` prints a "recall right now" line, SEMANTIC or KEYWORD ONLY. On a single-machine install, "brain server: NOT reachable" is normal. A failed git pull or push concerns only the backup copy: test the brain itself with a search or a read before calling it down.

## Save what you learn

Write a decision, a correction or a fact about a system in the turn it becomes true: one fact per memory, a description in the owner's words, a link to a related memory. Then run `node tools/build-index.mjs` so recall can find it. With a brain server, use `node tools/brain-client.mjs write <memory-name> --file <path>` instead; it refuses a bad file with the reason and writes nothing. Format and duplicate check: [[reference_how_to_save_a_memory]]. Keep the fact in the brain only, not also in the assistant's built-in memory, because two stores drift apart.

## Memory is a snapshot

A memory records what was true on the date in its header. Before acting on a file, function, setting, price or status that a memory names, check it in the present: open the file, run the command, read the setting. If it no longer matches, tell the owner and replace the memory, so two versions never disagree.

## Mistakes to avoid

- Answering from the one-line description instead of the file.
- Skipping the search because the message looked simple.
- Calling recall healthy without having seen the block.

## Related
[[reference_how_to_save_a_memory]] [[reference_how_to_research_with_sources]] [[feedback_open_the_memory_not_the_description]] [[feedback_say_when_the_brain_is_down]] [[feedback_write_it_the_moment_you_learn_it]] [[feedback_verify_before_claiming]]
