# Infinite Context, for the agent installing it

You are an AI agent, and a person has asked you to give yourself persistent memory using this
repository. This file is for you. Every step below is verifiable, and you must verify each one
before moving to the next. Do not tell the person it is installed until the last check passes.

## What you are installing

A recall system. On every prompt, a hook sends the prompt to a local index and injects up to five
pointers (a slug and a one-line description each) plus a small set of behaviour rules. You then
open the memory files that matter. Memories are markdown files you will write yourself as you learn
things. Nothing leaves this machine.

## Preconditions

```
node --version        must print v18 or newer
```

If Node is missing, stop and tell the person. Do not install it without asking.

## Steps

**1. Initialise the brain.** From the repository root:

```
node tools/init.mjs
```

Verify: the output ends with `rules now active : 5`. If it says 0, stop; the index did not build.

**2. Wire it into Claude Code.**

```
node tools/install-hook.mjs
```

Verify: the output contains `registered UserPromptSubmit` or `wired : YES`. This edits
`~/.claude/settings.json` and backs it up first. Tell the person a session restart is required.

**3. Prove recall works, before claiming it does.**

```
node tools/verify.mjs
```

Verify: the last line is `BRAIN VERIFY PASSED`. If it fails, read which check failed and fix that.
Do not report success on a failing verify.

**4. Optional, semantic matching.** Only if the person wants paraphrases to match:

```
npm install
node tools/embed-server.mjs
```

Verify: `curl http://127.0.0.1:8477/health` returns `{"ok":true,...}`.

## How to use it once installed

- **Recall is automatic.** You will see `BRAIN RECALL: N memories match this prompt` in your
  context, followed by pointers. **Open the files it names. Never answer from the one-line
  description.** The description tells you whether a file is worth opening, not what it says.
- **Write memories as you learn.** The moment something becomes durably true, a decision and its
  reason, a fact about a system, a correction from the person, write it:

  ```
  memory/<type>_<slug>.md
  ```

  where type is one of `user`, `contact`, `project`, `feedback`, `reference`, and the file starts
  with frontmatter:

  ```
  ---
  name: <short title>
  description: <one line, in the words the person would type when looking for this>
  type: <same as the filename prefix>
  metadata:
    type: <same again>
    asserted: YYYY-MM-DD
  ---
  ```

  Then run `node tools/build-index.mjs`. The description is the only thing indexed.
- **A rule is a memory with a `rule:` line** in its frontmatter. It is injected on every turn.
- **Link memories** with `[[slug]]`. A memory with no links in or out fails `verify.mjs`.
- **If recall is unavailable, say so** in your first sentence. Degraded memory that announces
  itself is recoverable. Silent degradation is answering from nothing while sounding sure.

## What can go wrong, in order of likelihood

| symptom | cause | fix |
|---|---|---|
| no `BRAIN RECALL` line in your context | session not restarted after step 2 | restart the session |
| `rules unavailable` | `index/rules.json` empty or missing | `node tools/init.mjs --force` then `build-index` |
| a memory you wrote is never recalled | vague description | rewrite the description in the person's words |
| `verify.mjs` fails on reflection | orphan memory or broken `[[link]]` | link it, or fix the slug |
| `semantic recall is OFF` | embed server not running | step 4, or ignore, keyword still works |
