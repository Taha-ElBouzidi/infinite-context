---
name: How to debug systematically
description: Crash, error, bug, broken, wrong numbers, test failing, it stopped working: how to find the root cause before any fix (reproduce, compare, one hypothesis at a time, failing test first). Read before fixing anything.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to debug systematically

Random fixes waste time and quietly create new bugs; a quick patch masks the underlying issue instead of removing it. The rule that holds up is simple and near-absolute: no fix gets proposed before the root cause is actually understood. This matters most exactly when it feels least necessary: under time pressure, when "just one quick fix" seems obvious, after several fixes have already failed, or when the issue is not yet fully understood. A bug that looks simple still has a root cause, and going slow to find it is faster than guessing and reworking.

## Phase 1: find the root cause before touching anything

Read every error message and stack trace completely rather than skimming past them; they usually contain the real answer, including the exact line, file, and error code. Reproduce the problem reliably: know the exact steps, and whether it happens every time; if it cannot be reproduced yet, gather more data rather than guessing at a cause. Check what actually changed recently: a diff, a recent commit, a new dependency, a config or environment difference.

In a system with multiple components, such as a pipeline that runs through several stages before failing, add diagnostic logging at each boundary before proposing any fix: log what enters and leaves each component, verify that configuration and environment actually propagate, and check state at each layer. Running that once shows exactly where the failure happens, and only then does it make sense to dig into that specific component. When the error surfaces deep in a call stack, trace the bad value backward: find what called this with the bad value, then what called that, continuing up until the actual source is found, and fix it there rather than where the symptom appeared. The full backward-tracing technique lives at kit/files/systematic-debugging/root-cause-tracing.md in the brain folder.

## Phase 2: find the pattern before fixing

Look for a working example of something similar already in the codebase. When following an existing pattern, read the reference implementation completely, not skimmed, and understand it fully before applying it. List every difference between the working case and the broken one, including ones that look too small to matter, and note every dependency, setting, or assumption the broken code relies on.

## Phase 3: hypothesis and testing, one at a time

State a single hypothesis clearly and specifically: this is thought to be the cause, and here is why. Make the smallest possible change to test it, one variable at a time, never several fixes bundled together, because bundling makes it impossible to tell which change actually worked. If it worked, move to Phase 4. If not, form a new hypothesis rather than stacking another fix on top of the failed one. When something is genuinely not understood, saying so and researching further beats pretending to know.

## Phase 4: implement the fix at the root

Create a failing test case first, as simple a reproduction as possible, automated where a framework supports it; this has to exist before the fix does. Make one change addressing the identified root cause, nothing bundled in "while here", no incidental refactoring. Then verify: does the test pass now, are other tests still passing, is the issue actually gone.

If a fix does not work, that gets counted. Under three failed attempts, the right move is back to Phase 1 with whatever was just learned. At three or more failed fixes, this is no longer a debugging problem, it is an architectural one: each fix revealing a new piece of coupling or shared state somewhere else, each fix needing a bigger refactor than the last, or each fix creating a new symptom elsewhere are all signs of a pattern that is not sound rather than a hypothesis that needs one more try. That calls for a conversation about the architecture before any further fix attempt, not a fourth patch.

## Signs to stop and go back to Phase 1

"Quick fix for now, investigate later." "Just try changing this and see." "Skip the test, verify by hand." "It's probably this, let me just fix that." "I don't fully understand this, but it might work." Proposing a fix before tracing the data flow. Attempting one more fix after two have already failed. Each of these is a sign the process has been skipped, and the answer is the same every time: stop, and return to Phase 1.

## Rationalizations and why they do not hold up

| What gets said | Why it is wrong |
|---|---|
| The issue is simple, no need for the process | Simple issues have root causes too; the process is fast for a simple bug. |
| This is an emergency, no time for process | Guessing and re-checking is slower than being systematic once. |
| Try this first, investigate if it fails | The first fix sets the pattern for every fix after it. |
| Write the test after confirming the fix works | A fix without a test written first rarely stays fixed. |
| Several fixes at once saves time | It becomes impossible to tell what actually worked, and it creates new bugs. |
| The reference is long, so the pattern gets adapted instead of read | Partial understanding of a pattern reliably produces new bugs. |
| The problem is visible, so it can just be fixed | Seeing the symptom is not the same as understanding its cause. |

## If the process genuinely finds no root cause

Occasionally, a full investigation shows the issue really is environmental, timing dependent, or external. That is only a legitimate conclusion once the process above has actually been completed: what was investigated gets documented, an appropriate handling gets implemented such as a retry, a timeout, or a clear error message, and monitoring gets added for the future. Most claims of "no root cause" turn out, on inspection, to be an incomplete investigation rather than a genuinely rootless bug.

## Further techniques

Two more techniques support this method and live in the brain folder rather than here: adding validation at multiple layers once a root cause is found, at kit/files/systematic-debugging/defense-in-depth.md, and replacing an arbitrary timeout with polling for an actual condition, at kit/files/systematic-debugging/condition-based-waiting.md.

This sits inside the same working method as [[reference_how_to_plan_test_and_verify]], including writing the failing test first, and an independent check after the fix follows [[reference_how_to_review_work_before_calling_it_done]].

Adapted from obra/superpowers (https://github.com/obra/superpowers), MIT License, Copyright (c) 2025 Jesse Vincent; licence in kit/files/systematic-debugging/LICENSE.

## Related
[[reference_how_to_plan_test_and_verify]] [[reference_how_to_review_work_before_calling_it_done]] [[feedback_verify_before_claiming]]
