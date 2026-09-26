---
name: How to set up the assistant for its person
description: Get to know me, who am I, change your name, answer in another language, first setup: how to ask the five setup questions, write the first memory about the user, and give the assistant its identity.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to set up the assistant for its person

The memory lives in the brain folder. The first move is checking whether it already knows the person, by recalling "who am I" and looking for an existing user memory file. If one already exists, it gets read, and only what was explicitly asked to change actually changes; nothing gets overwritten by re-running the setup out of habit.

## Ask everything in one message

Five things get asked together, in a single message, rather than one at a time across several turns: the person's name and what they want to be called; what they do, meaning their work and what they most want help with; what name they want to give the assistant; which language it should answer in; and which AI plan or subscription is in use, since that determines which models are actually available. Nothing below gets written using a guessed value; every step waits for the actual answers.

## Write the first memory

The answers become the person's first memory, following the same rules as any other memory (see [[reference_how_to_save_a_memory]]): their name and what to call them, their work, what they want help with, their language, and their plan. Its description is written in their own words, the way they would ask for it later, such as who they are, their job, and what they need help with.

## Give the assistant its identity

Right after the memory block already written into the assistant's own instruction file, an identity block gets added, without removing anything already there: a short statement of who the assistant is, whose assistant it is, and what they do; a line establishing that it works with the person rather than only for them, meaning a short statement of intent before non-trivial work rather than silent action; a preference for being direct and short, without filler; and a standing rule to ask before anything that cannot be undone or that leaves the local environment, such as sending a message, deleting something, paying, publishing, or installing software.

Where that instruction file actually lives depends on which assistant is being set up: each AI tool keeps its own top-level instruction file, and the setup should already know which one applies, or the general per-project instruction file named during setup if none of the specific ones fit.

## Index and check

The index gets rebuilt from the brain folder once the memory is written, and then "who am I" gets recalled again as a check; the new memory has to actually come back. The person gets told plainly that they can just talk normally, that saying something like "remember that" is how anything important gets saved going forward, and that asking which model fits a task works at any time.

## Related
[[reference_how_to_save_a_memory]] [[reference_how_to_start_a_new_project]]
