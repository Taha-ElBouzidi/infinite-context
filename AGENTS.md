# Infinite Context, for the agent installing it

You are an AI agent, and a person has asked you to give yourself persistent memory using this
repository. This file is for you. Every step below is verifiable, and you must verify each one
before moving to the next. Do not tell the person it is installed until the last check passes.

## What you are installing

A recall system. On every prompt, a hook sends the prompt to a local index and injects a pointer
(a slug and a one-line description) for every memory that clears the match bar, plus memories
strongly linked to those, plus a small set of behaviour rules. There is no fixed count: a trivial
prompt brings a handful, a long message many. You then
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

Verify: the output contains `rules now active : 8` and `semantic recall  : ON`. If rules say 0, stop; the index did not build. If semantic says OFF, `npm install` failed: tell the person, then continue, keyword recall still works.

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

**4. Semantic recall is on by default.** Step 1 installed the model runtime and built the vectors.
The hook starts the local embedder on its own when it is not running; the first prompt after a
reboot may be keyword-only while it warms up, and the hook says so in your context when that
happens. Nothing to do here unless step 1 reported `semantic recall  : OFF`.

**5. Keep one memory, not two.** Claude Code has its own built-in memory, a `MEMORY.md` and notes
under `~/.claude/projects/<project>/memory/`. It cannot be switched off. If both stores hold facts
they drift apart without anyone noticing, and one of them ends up confidently wrong. In the
maintainer's own setup a local copy held 40 files, 35 of them also in the brain, and 31 of those
had diverged. A fact stated as true for over a month was wrong in one store and right in the other.

So this repository is the only place facts are written, and the built-in memory becomes a pointer:

1. Look at what the built-in memory already holds. Copy the folder somewhere safe first.
2. Move every fact worth keeping into `memory/` here as its own file, in the format above. If the
   same fact is in both, keep the newer one after checking it is still true.
3. Replace the built-in `MEMORY.md` with a short pointer, and leave no other notes beside it:

   ```
   This local memory is intentionally empty. It is not the source of truth.
   All memory lives in <full path to this repository>.
   At session start read REFLEX.md and memory/MEMORY.md there.
   Do not write memories here.
   ```

4. From now on write new facts here only, never to both. Do not "save to both so they agree": two
   writes are the thing that makes them disagree.

Verify: the built-in `MEMORY.md` is only the pointer, and `ls <built-in memory folder>` shows
nothing else. Tell the person you did this, because it changes where their notes live.

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
- **It updates itself.** At most once a day the recall hook checks, in the background, for a newer
  release (a tag on `main`) and installs it, verifies it, and goes back on its own if verify found a new
  failure. When there is news, a line starting `INFINITE CONTEXT UPDATE:` appears in your context:
  tell the person in one line, once. `node tools/update.mjs --status` shows the setting and the last
  result; `--off` turns automatic updates off, `--notify` makes them tell without installing. To
  update by hand use `node tools/update.mjs`, not `git pull`: it refuses anything that would touch the
  person's files and rolls back a release that fails verify.
- **Kit methods the person changed are never overwritten.** When the kit has a new version of one, the
  new version waits in `kit-updates/` beside theirs. Show them the difference; `node tools/kit.mjs
  accept <name>` takes the new one and keeps theirs in `kit-updates/replaced/`, and deleting the waiting
  file declines it for good. `node tools/kit.mjs status` lists every kit method and its state.

## Contributing back

This project improves when the agents using it send back what they learn. If, while working for your
person, you fix a bug in the engine, measure a recall change that helps, write a how-to memory that
would help anyone (not one about your person), or adapt the dashboard in a way others could use,
propose it upstream.

1. **Ask your person first.** A pull request publishes their work under their GitHub account, and
   they must accept the CLA (`CLA.md`). Never open one without a clear yes.
2. **Strip everything personal.** No names, machine names, paths, addresses, credentials or memory
   content from their brain. Only engine code, generic how-to memories under `kit/`, and docs.
3. **Prove it.** Run `node tools/verify.mjs`. For a recall change, give the before and after on a
   test set and the command that produced them.
4. **Open the pull request against `staging`**, saying what changed, why, and how you measured it.
   Small and focused beats large.

If you find a problem you cannot fix, open an issue with what you ran, what it printed and what you
expected.

## What can go wrong, in order of likelihood

| symptom | cause | fix |
|---|---|---|
| no `BRAIN RECALL` line in your context | session not restarted after step 2 | restart the session |
| `rules unavailable` | `index/rules.json` empty or missing | `node tools/init.mjs --force` then `build-index` |
| a memory you wrote is never recalled | vague description | rewrite the description in the person's words |
| `verify.mjs` fails on reflection | orphan memory or broken `[[link]]` | link it, or fix the slug |
| `semantic recall missed this turn` | the note says why: the brain server busy or down, or the local embed server not running | step 4 if it says the embed server is not running, otherwise ignore, keyword still works |
| you find the same fact in the built-in memory and here, and they differ | two stores were both being written | step 5: keep the newer true one here, empty the built-in one to the pointer |
| `INFINITE CONTEXT UPDATE: version X is out ... was not installed automatically` | an engine file the release also changes was edited here, or this clone has commits of its own | the line gives the reason and the command; with the person's yes, put the change aside (`git stash`) or merge by hand, then `node tools/update.mjs` |
| `INFINITE CONTEXT UPDATE: ... went back to` | verify failed after the update, so it rolled back | `node tools/update.mjs` runs it again and prints why; report it upstream if it repeats |
