---
name: How to clean up the context
description: Clean up the context, compact, context too big, archive the conversation, context_map, context_archive, context_restore: how to archive finished parts with a note you could work from alone, bring back only what is needed, and what to do when the tools are absent. Read before cleaning up or when the context grows large.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: 41854efa94146c4a
---

# How to clean up the context

Everything in the conversation is read again on every step, so a shorter context answers better and costs less. A clean-up replaces finished parts of the conversation with notes the agent writes. The full text stays in an archive, so nothing is lost.

## Check the tools

The tools context_map, context_archive, context_restore and context_keep come from a Claude Code mod that is not part of the public engine yet. An install has them when they appear in the agent's tool list (a prefix may come before each name). When they are absent, use the last section.

## When to clean up

- At a natural break: a task is finished and its result is saved in the brain or in git, or before a long pause. The cache will have expired by the time work resumes, so the re-read is paid anyway.
- Before the tool compacts the conversation by itself, so that the agent chooses what is kept. A reminder or an idle question from the install is the moment to decide.
- Not in the middle of a task, and not just before work that needs everything the conversation has gathered.

Each clean-up makes everything after the first archived part be read again once, so weigh the saving the map shows against that.

## Steps

1. Save what is lasting first, in memories, files and commits. A clean-up shortens the conversation; it does not replace saving.
2. Call context_map. Each part shows its kind, size in tokens, age in turns and a label.
3. Choose what to archive: old tool outputs and finished work whose result is saved. In one long session tool calls and their outputs were about 80 percent of the size. Keep the work in progress and the last report to the owner, where the end state is recorded.
4. Write one archive per finished topic, with a note you could work from alone: what it was, the outcome, what is still open, and the values that matter (ids, numbers, paths, status codes, the owner's instructions with their dates and the question each answered). The tool adds exact values, errors and a restore pointer, but those are short, so copy into the note any fact that exists only in a raw output. A big archive needs a long note.
5. Archive rarely and in one batch: call context_archive once, with every archive as parts (such as `12-20, 25`) and its note. It takes effect when the turn ends. Each batch costs one re-read of everything after its first archived part.
6. Ask yourself a few questions the work depends on and answer them from the notes. Bring back only what a note cannot answer.

## What cannot be archived

The turn in progress, a call still waiting for its result, and the first message of the conversation. A call goes with its result. An install may lock more; a refused batch names the allowed ranges, so send it again with those.

## Bring back

context_restore with an archive id (such as A3) returns the text at the end of the conversation. Add `search` (a word or phrase) or `lines` (such as `120-180`) to return only that piece, which costs only what it returns. If an archive is needed twice, keep that topic in the conversation next time or write a fuller note.

## When the tools are absent

Use the tool's own compaction (in Claude Code, the compact command) after writing a brief with the file-writing tool, so that its text is in the conversation the summary is made from. Merge into an existing brief; replacing it with only the newest items loses the rest. The brief holds:

- the goal, the owner's instructions and decisions in the owner's words with their dates and the question each answered, and the owner's last five messages word for word
- what is done and where it is saved, what is in progress, failed approaches in one line each, open questions, and every exact path, id, version, amount and measured number with what it measured
- what can be dropped: raw tool output, file contents, logs and finished reasoning

Add one line to a section of the written context titled Compact Instructions (Claude Code reads it): follow the latest compaction brief. Afterwards, check the summary against the brief. In a blind test, a brief the agent wrote kept more answers than a fixed template or the plain compaction.

## Related
[[reference_how_to_write_a_context]] [[reference_how_to_use_shared_contexts]] [[reference_how_to_save_a_memory]] [[feedback_write_it_the_moment_you_learn_it]]
