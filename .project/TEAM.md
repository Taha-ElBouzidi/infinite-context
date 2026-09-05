# TEAM.md, Roles, Hierarchy, Delegation

*Living document. Update when team structure or model availability changes.*

## Hierarchy

```
Owner (repository owner)
  |  Direction, priorities, licensing, releases
  |  Approves every merge to main
  |
  +-- Lead Engineer (Claude Code, Opus-class model)
        |  Code, architecture, testing, git, measurement
        |  Updates .project/ after any structural change
        |  Delegates search and routine work to sub-agents
        |
        +-- Sub-agent: Haiku-class
        |     File search, grep, glob, fast lookups
        |
        +-- Sub-agent: Sonnet-class
        |     Routine edits, test writing, boilerplate, refactors
        |
        +-- Outside contributors
              Pull requests under the CLA, reviewed by the owner
```

## Model Selection

| Task | Model | Why |
|---|---|---|
| Architecture, security review, cross-file debugging | Opus-class | Deep reasoning across files |
| Routine edits, test writing, refactors | Sonnet-class | Faster, cheaper, sufficient |
| File search, grep, codebase exploration | Haiku-class | Lookup only, no reasoning needed |

## Delegation Protocol

When delegating to a sub-agent:
1. Write a self-contained prompt. The sub-agent has no session history.
2. Set the model explicitly from the table above.
3. Review the output critically before applying it. Never blind-apply.
4. Log the change in `.project/CHANGELOG.md`.

## Implementation Cycle (mandatory for every task)

1. **PLAN:** Align on the approach. Name the design choices and their tradeoffs.
2. **TEST:** Validate the idea in isolation before touching production code.
3. **IMPLEMENT:** Write the code, update CHANGELOG, update STRUCTURE if files changed.
4. **VERIFY:** Run it. Read the output. Mark complete only after `tools/verify.mjs` passes.

## One rule that applies to every role

Never claim something works because the code says it should. Say what you ran and what it printed.
This project's own history is a list of defects that reading could not find and running found in
minutes.
