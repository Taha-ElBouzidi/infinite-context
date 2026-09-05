<h1 align="center">Infinite Context</h1>

<p align="center"><strong>Infinite context for your AI model.</strong><br>
Unlimited memory for coding agents, without putting it in the context window.</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-2563eb"></a>
  <img alt="Node 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-6b7280">
  <img alt="Runs locally" src="https://img.shields.io/badge/runs-100%25%20local-6b7280">
  <img alt="Tested on Windows" src="https://img.shields.io/badge/tested-Windows-6b7280">
  <a href="CLA.md"><img alt="CLA required" src="https://img.shields.io/badge/contributions-CLA%20required-6b7280"></a>
</p>

<p align="center"><img src="docs/recall.svg" alt="Your prompt goes to a hook, which matches by keyword and meaning and returns five pointers, each a slug, a one-line description and a path. The agent opens the one or two it needs and answers with the fact." width="900"></p>

An agent using Infinite Context never loses a fact, and loads almost nothing on any given turn.
Every prompt gets **five pointers**, a slug and a one-line description each, and the agent opens only
the one or two memories the question actually needs. The memory can grow to thousands of facts.
The prompt stays the same size.

It runs entirely on your machine. No account, no cloud, no data leaving the building.

## Quick start

Requires Node 18 or newer. Nothing else.

```sh
git clone https://github.com/Taha-ElBouzidi/infinite-context
cd infinite-context
node tools/init.mjs            # seeds five rules, installs the embedding runtime, builds the index
node tools/install-hook.mjs    # wires Claude Code to it. Restart your session after.
```

That is the whole install. Recall works on the next prompt, by keyword **and by meaning**: a
question with no word in common with a memory still finds it. The first `init` downloads the
embedding model, about 280MB, once. The hook starts the local embedder itself whenever it is
not running, so there is nothing to keep alive by hand.

To skip semantic recall and stay keyword-only, `node tools/init.mjs --no-semantic`.

### Let your agent install it for you

Paste this to Claude Code, or any agent that can run commands:

> Clone https://github.com/Taha-ElBouzidi/infinite-context, then read its `AGENTS.md` and follow it.

`AGENTS.md` is written for the agent, every step is verifiable, and it will not report success
until the last check passes.

## What you get

Measured on the authors' own 41-query set, on a brain of about 270 memories:

| | |
|---|---|
| recall@5 | **97.6%**, identical on a laptop reaching the brain over a private network |
| cost per prompt | about **200ms** on the host, about 600ms over the network |
| context added | about **1.7k tokens**, whatever the size of the memory |
| returned nothing | **0** of 41 |

Your numbers will differ. Measure them: `node tools/eval-recall.mjs` and `node tools/bench-recall.mjs`.

## How it works

**Memories are markdown files**, one fact per file, under `memory/`. Plain text, yours, diffable,
grep-able. Nothing is hidden in a database.

**Only the description is indexed.** Each memory has a one-line `description`, written in the words
a person would type when looking for it. That line, and the slug, are the entire retrieval surface.
A memory with a vague description exists and cannot be found, which is by design: it forces the
author to say what the memory is *for*.

**Recall returns pointers, not text.** Injecting five whole memories into every prompt to save one
file read is the wrong trade. The agent reads what it needs, and reads it fresh.

**Two channels, fused.** Keyword matching always works and catches exact names. Semantic matching,
when the local embedder runs, catches paraphrases keyword cannot. Both are on your machine.

**Behaviour rules are memories too.** Any memory carrying a `rule:` line is injected on every turn.
Five generic ones ship. Add your own by writing a memory. Change one by editing a file.

**It degrades loudly.** If the index is missing, the embedder is down, or a file cannot be opened,
the agent is told so in its context, in words, rather than silently answering from less.

## Why not a bigger context window

A bigger window is a bigger bill on every single prompt, and past a point more context makes a model
worse, not better. A memory that lives outside the window costs the same whether it holds fifty
facts or fifty thousand. This is the difference between remembering and re-reading.

## Check it is working

```sh
node tools/verify.mjs          # the whole install, exits non-zero on any failure
node tools/eval-recall.mjs     # accuracy against a fixed query set
node tools/bench-recall.mjs    # latency of the real hook, end to end
node tools/analytics.mjs       # results sheet from every logged call, with alerts
```

## Multi-machine mode

A second mode exists where one host runs `tools/brain-server.mjs` and other machines reach it over a
private network with scoped tokens and per-machine encrypted secrets. It is how the authors run it,
across three machines, one of which cannot reach the internet. It is not documented for outside use
yet. This release is **local only**.

## Platform

Tested on Windows. The engine is plain Node and should run wherever Node does. The scheduling
helpers under `tools/*.ps1` are Windows-only and are not needed for local mode.

## Contributing, security, licence

Contributions are welcome and require a signed [CLA](CLA.md), checked automatically on every pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md). Licensed under [AGPL-3.0](LICENSE); commercial licences are available
from the author.
