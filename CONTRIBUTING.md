# Contributing

Contributions are welcome, and one condition applies to every one of them.

## You must sign the Contributor Licence Agreement

This project is AGPL-3.0 and is also offered under commercial licences by its author. That is only
possible if the author holds the right to relicense every line in the repository. So before a pull
request can be merged, you must agree to the CLA, which grants the author a perpetual licence to
use, modify and relicense your contribution while you keep your own copyright.

The agreement is short and is checked automatically on each pull request. A contribution without it
cannot be merged, however good it is. This is not a judgement on the code; it is the one rule that
keeps the project both open and sustainable.

## What makes a contribution mergeable

- `node tools/verify.mjs` passes. It is the gate for every commit and it is not bypassed.
- The change explains **why** in its comments, not what. The code says what.
- Anything measured is measured, not estimated. Latency claims come with the command that produced them.
- No personal data, machine names, addresses or credentials, yours or anyone else's, anywhere in the diff.

## Reporting a problem

Say what you ran, what it printed, and what you expected instead. A report with those three things
gets fixed. A report without them gets a question back.

## Workflow

Branching, commit convention and the release gate are in `.project/WORKFLOW.md`. Read it before
opening a pull request; the one rule that matters most is that `main` must stay installable from a
fresh clone with no environment variables set.
