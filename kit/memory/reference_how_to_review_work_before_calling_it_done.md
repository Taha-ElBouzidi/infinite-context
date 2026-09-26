---
name: How to review work before calling it done
description: Is it finished, is it right, are you sure, can I send it, before I tell the team: how to check work before calling it done, with an independent reviewer and questions for the user to verify.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to review work before calling it done

The person who did the work is its worst judge, because they see what they meant to make rather than what actually got made. So before anything gets called done, someone who did not do the work checks it.

## Run the original check first

Before any review, the check named at the start of the task actually gets run: the test, the build, the rendered page, the number checked against its source, following [[reference_how_to_plan_test_and_verify]]. A review is never a substitute for actually running that check.

## Get an independent reviewer

A sub-agent with a genuinely fresh context, following [[reference_how_to_brief_sub_agents_and_pick_models]], reviews the work with a brief that gives it exactly this:

- The goal: find what is wrong or missing. Not to praise the work, and not to rewrite it.
- The criteria: what was actually asked for, in the requester's own words, plus the check that proves it done. Nothing beyond that; a reviewer does not get to invent new requirements.
- The work itself: exact file paths, or the actual text, never a summary of why it is already correct, which would just steer the reviewer toward agreement.
- The output: a list of problems, each with where it is, why it is a problem, and how confident the reviewer is (certain, likely, or possible). "No problems found" is a legitimate answer.
- The limits: read-only, changing nothing.

A balanced-tier model fits most reviews; the strongest tier fits security, money, legal matters, or anything that cannot be undone. When no separate reviewer is available, the same review still happens as its own step: reread the request, then reread the work, and look only for gaps, rather than skipping straight to reporting success.

## Act on what comes back

Whatever is certain or likely gets fixed, then the original check runs again. For anything left unfixed, the reason gets stated plainly. The point of a reviewer's findings is evidence, not a debate to win; disagreement gets settled with evidence, not by outlasting the reviewer.

## Hand over with real questions

The handover ends with two or three short questions that help the requester check what matters most themselves, for example whether a total assumes a specific set of figures are final, whether the testing only covered a simple case and a harder one exists, or whether a number depends on a rate that should be reconfirmed. Those questions come from the actual assumptions made and the parts that could not be verified, never from something that could just as easily have been checked directly instead of asked about.

## Related
[[reference_how_to_plan_test_and_verify]] [[reference_how_to_brief_sub_agents_and_pick_models]] [[feedback_verify_before_claiming]]
