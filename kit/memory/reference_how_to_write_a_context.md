---
name: How to write a context for agents
description: Write a context, system prompt, CLAUDE.md, AGENTS.md, global context, machine context: how to choose what goes in the text read on every step and what stays in the brain, how to word it, its size and order, and the check before it goes live. Read before writing or changing any context.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: 4022a626f061e496
---

# How to write a context for agents

A context is the text an agent has in front of it on every step: a system prompt, a CLAUDE.md or AGENTS.md file, or a shared level ([[reference_how_to_use_shared_contexts]]). Every line is read and paid for on every step. The method is the same for each form, with or without the shared levels. The assistant drafts it from the templates in kit/files/context-templates/ in the brain folder, one per level; the owner approves it.

## What a context is for

It holds only what every agent it reaches needs in front of it on every step. Anything recall finds on its own stays in the brain: who the owner is, history, decisions, the details of a method. A way of working that only some tasks need is a saved method (see [[reference_how_to_turn_a_repeated_task_into_a_method]]), not a context line. A context that repeats the brain is paid for twice.

A line earns its place when the agent needs it often, cannot easily look it up, or gets it wrong without it. Count rather than guess: the memories agents open again and again show in their session transcripts.

## The levels and their headings

Each level says only what the level above does not. The templates carry these headings in this order, with one or two lines under each saying what goes there.

- Global, for every agent on every machine: Who you are; The brain is your memory; Where things live; How to talk to the owner; How to write; How to work; Your conversation.
- Machine, for every agent on one machine: The machine; Disks and folders; Addresses; Shells and admin; Restarts and start-up.
- Group, for a set of agents or machines: The group; What the group shares; How the group works together; Where its things live.
- Agent, for one agent: What this agent is for; Kept facts.

The global context also holds the memory format and save command, and one writing style for everything the agents write. End a list that grows (machines, agents) with a line saying to add each new entry.

## Wording

- Say what to do, not what to avoid. Studies report that in long sessions prohibitions fade while requirements hold: write "check before you state", not "never guess".
- Use short lists under headings, one rule per line, with the reason in a few words when it is not obvious.
- Keep the rules few. Studies report that instruction following breaks down beyond about 5 to 6 rules applied at once, so write a short set of habits, not a rulebook.
- Put a hard prohibition that code can check (a secret, a forbidden character, a window that must not open) in a hook that refuses the action. The context says what to do instead.
- Say each rule once. Repeating rules on every turn fills the context with copies; if a test shows a rule being ignored late in a long session, reword it or enforce it in code.

## Size and order

- Small: a global context of about 2,000 tokens with a ceiling of about 2,500, a machine context of about 900, and a group or agent context shorter still.
- At the very start of the request, in the system prompt, the strongest place.
- Stable. The prompt cache matches from the start, so an edit makes every agent write its whole conversation to the cache again at a much higher price. A change waits for the next clean-up unless it is urgent.
- Anything that changes on each turn (the time, a status, the latest messages) goes at the end of the conversation, never in the context.

## Owner and hosting

Each context has one owner, who writes it, keeps its master copy in one place (for a shared level, a file in the layers folder of the brain) and refreshes the copies agents hold. Others propose changes to the owner. The title line names the level, whom it reaches and the owner.

## Before it goes live

Each check catches a mistake that shows up often.

1. Count the tokens with the model provider's counter and compare with the sizes above.
2. Check that nothing repeats what is already loaded: other written context files, startup text, the levels above.
3. Check there is no secret, no dated status such as "this week we are doing X", and no prohibition a hook could enforce.
4. Replace every placeholder and delete every guidance line, so that no angle bracket remains.
5. Show the owner the rendered text, as the agent will see it, and wait for approval.

## Related
[[reference_how_to_use_shared_contexts]] [[reference_how_to_clean_up_the_context]] [[reference_how_to_save_a_memory]] [[reference_how_to_turn_a_repeated_task_into_a_method]] [[reference_how_to_use_the_brain]]
