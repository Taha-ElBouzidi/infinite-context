---
name: How to use the shared contexts
description: Global context, machine context, group context, layers, shared instructions, pin a fact, context_keep: how the levels reach an agent, where each one lives, when a change takes effect, who may change which level, and how an agent pins a fact. Read before changing a shared context or when an agent does not see a change.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: 2366e753685819cf
---

# How to use the shared contexts

Four levels of text sit at the start of every request an agent makes: global, machine, group, then the agent's own, from the one that changes least to the one that changes most. Because of that order, a change at one level makes only that level and the text after it be read again. How to write each level is in [[reference_how_to_write_a_context]].

## Check what this install has

The levels come from a Claude Code mod that is not part of the public engine yet. An install has it when the tools context_map, context_archive, context_restore and context_keep appear in the agent's tool list (a prefix may come before each name); the levels are then put into the system prompt. Without them, a written context (CLAUDE.md, AGENTS.md or a system prompt file) does the same job with fewer features; see the last section.

## Where each level lives

| Level | Reaches | Lives |
|---|---|---|
| Global | every agent on every machine | `global.md` in the layers folder of the brain |
| Machine | every agent on that machine | `machine/<machine name>.md` in that folder, the name in capitals |
| Group | every agent whose settings list the group | `group/<group name>.md` in that folder |
| Agent | that agent only | a file on the agent's own machine, outside the brain |

The shared files travel with the brain's sync, so every machine reads the same files, and the mod reads them before every prompt. A file over 20,000 characters, or one that is not text, is not loaded.

## When a change takes effect

A change to a shared level waits for the agent's next clean-up (see [[reference_how_to_clean_up_the_context]]): editing the start of the context makes the agent read everything again at a much higher price, and a clean-up already pays that once. Two cases take effect on the next request: the cache has already expired (no request for about an hour), or the first line of the file is an HTML comment holding only the word urgent, which is for security and safety rules only. Until then the map and the status line say that a newer layer is waiting, and the agent keeps seeing the version in force, which can be older than the file.

## Pin a fact with context_keep

context_keep pins one fact, in one or two lines, to the agent's own level. It is added when the current turn ends, as part of the next clean-up, and every change makes the whole context be read again once, so keep it rare and short.

- Pin what this agent needs on every step, cannot find quickly and gets wrong without, such as its working folder or a standing decision.
- Leave out what recall finds when needed, anything a shared level already says, secrets and dated status.
- When a pinned fact stops being true, edit it out of the agent's own file.

## Who may change which level

- Agent: the agent itself.
- Group: the group's owner; its members propose.
- Machine: the person or lead agent responsible for the machine; the agents on it propose.
- Global: the owner of the install, through the main assistant; every agent proposes.

To propose a change, send the owner of that level the line and the reason (see [[reference_how_to_message_another_agent]]). The owner approves the rendered text of every shared level before it is saved, because every agent that reads it pays for it on every step.

Mistakes that show up: an ordinary edit marked urgent, a fact pinned every few turns, and a shared level edited without its owner.

## Without the mod

Use written files as the levels. If the tool lets one written context import another file (Claude Code does, with an at sign before the path), have each machine's written context import the global file and that machine's file, and each project's import its group file; otherwise copy the text. The agent keeps its own facts in a section at the end of its own written context. A change reaches an agent at the start of its next session. The rules in [[reference_how_to_write_a_context]] still apply.

## Related
[[reference_how_to_write_a_context]] [[reference_how_to_clean_up_the_context]] [[reference_how_to_message_another_agent]]
