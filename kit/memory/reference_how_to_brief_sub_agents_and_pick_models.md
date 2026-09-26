---
name: How to brief sub-agents and pick the right model
description: Parallel agents, helpers, sub agents, delegate, split the work, which model to use: how to split work, how much to spend, the six part brief a sub-agent needs, and the small, balanced or strongest model choice.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to brief sub-agents and pick the right model

A sub-agent is worth starting only when a task splits into parts that do not depend on each other: researching several options, checking several files, writing tests while another agent reads documentation. Those parts run in parallel and in the background, so the main conversation is never blocked waiting on them. A task whose steps each need the previous step's result should not be split; that work gets done directly, in order, by whoever is already holding the context.

## How much delegation a question deserves

Scale the effort to the question rather than defaulting to a fixed number of agents. A single fact needs no sub-agent, or at most one doing a few searches. A comparison of options fits two to four sub-agents, one per option or angle. A genuinely wide research question can take more, each with a narrow slice. Ten agents dispatched on a simple question waste time and money and mostly return duplicate work; the judgment call is matching the split to how independent and how large the task really is.

## What a workable brief contains

A sub-agent does not see the conversation that spawned it and has no memory recall of its own. It knows only what the brief tells it, so the brief has to stand on its own:

1. The goal, in one sentence, and what "done" looks like.
2. The facts it needs, including any relevant memory copied in directly rather than referenced as "as discussed".
3. Exact places to look: file paths, URLs, names, never "search the whole disk".
4. Limits: what it must not do, such as edit files, send anything, install, or delete, plus a size or time limit.
5. The exact output format wanted back, with a length limit.
6. How it should check its own result before returning it.

The agent holding the conversation is the one that recalls memory; a sub-agent only ever gets what its brief hands it.

## Choosing the model

Name the model and the reason in one line whenever a sub-agent or a large task is started.

| Task | Tier | Examples |
|---|---|---|
| Finding files, searching, simple lookups, reading and listing | Small and fast | a lightweight or mini-class model |
| Summarizing, writing and editing documents, routine code, tests, refactors | Balanced | a mid-tier general model |
| Planning, architecture, hard debugging, security, decisions with real consequences | Strongest | the strongest reasoning model available |

Judgment never goes to the small tier, even when it would be cheaper. If the model actually running a session is weaker than the task in front of it needs, that gets said before starting, along with which model to switch to. Available models depend on the account in use; on a plan with tight limits, the strongest tier is reserved for the jobs that actually need it.

## After a sub-agent returns

What a sub-agent returns is checked before it is relied on or reported onward. Its "done" is a claim, not a result, so the file gets opened, the test gets run, and the source gets read, the same as with any other claim of completion; see [[reference_how_to_review_work_before_calling_it_done]].

## Related
[[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_research_with_sources]] [[feedback_sub_agents_get_a_ready_brief]] [[feedback_best_model_for_each_task]]
