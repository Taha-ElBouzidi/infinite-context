# Changelog

Infinite Context, infinite context for your AI model.

## 0.4.80

Privacy and safety review before publishing. Nothing here touches your memories.

- **Your memories are never pushed to this repository.** In an install, saving pushes only to a backup remote you name in `brain.json` (`"backupRemote"`, a private repository of your own), never to `origin` by default, so a clone of this repository or a public fork never receives them. Without one, the save commits locally and says so in one line.
- **Saving memories no longer blocks updates.** Commits that only hold memories are merged with the release; a commit that changes engine files still holds the update and says how to merge by hand.
- **Session start no longer changes other settings.** In an install it never merges permission settings into `~/.claude/settings.json`, never edits another tool's configuration (`~/.gemini`), and arms the git gate only where `hooks/git` exists.
- **No mod, no mod files.** Without the optional Claude Code mod, the hooks write nothing under `~/.claude/havok-mod` and start no sender.
- **Memory writes are recognised in any folder name**, so a clone named `infinite-context` settles its learned items like any other.
- **Prompt collection stays off.** The `/usage` route and the client that feeds it record only inside a window set in `usage-collection.json`, which no install has; without that file nothing is collected.
- **Plainer texts.** Runtime messages and comments no longer name the maintainers' machines, agents or tools.

## 0.4.79

This release brings automatic updates. It is the last one you install by hand: `git pull`, then
`node tools/kit.mjs refresh` and `node tools/verify.mjs`. Nothing here touches your memories.

- **Updates install themselves.** While you use your assistant, the recall hook checks at most once a day, in the background, for a newer release (a tag on `main`, never another branch), installs it, runs verify and goes back on its own if the update brought a failure. You are told once, in one line, what changed. It refuses any release that would put a file in `memory/` or overwrite a file of yours, and waits when you changed an engine file the release also changes. `node tools/update.mjs --off` turns it off, `--notify` makes it tell without installing, `--status` shows the last result. The check is one `git ls-remote` a day, so GitHub's API limits never apply.
- **Kit methods stay current.** Every how-to memory in the kit carries a version and a content hash. An update refreshes the copies you never changed; for one you changed, yours stays as it is and the new version waits in `kit-updates/` (`node tools/kit.mjs accept <name>` takes it and keeps yours). A kit method you deleted is not brought back. `node tools/kit.mjs status` shows each one. Copies made by earlier installs are recognised too.
- **Twelve new how-to memories.** Email in your own format, a first message to someone new, chat messages, video presentations, voice audio, writing a context for your agents, and how to use the system itself: recall, the vault, a shared git server, messages between agents, the shared contexts and their levels, and cleaning up the context. 26 in all.
- **Context templates.** `kit/files/context-templates/` has a starting structure for a global, machine, group and agent context, with placeholders, following the new method for writing one.
- **init no longer overwrites a kit method you changed**, even with `--force`, and dates the methods it installs with the install day.

## 0.4.52

This release catches the public repository up with a long run of changes. Nothing here touches your memories.

- **Helpers share the brain.** Every helper agent now starts with a short block that tells it the brain exists and how to search it, and recall is added to each message you send to a helper that is already running, so helpers stop working from nothing.
- **Writing slips become a note, not a rewrite.** When the assistant breaks one of your writing rules (for example a banned punctuation mark), it no longer gets forced to redo the whole reply. The slip is noted and shown to it on the next message.
- **The recall gate lets a messaging relay through.** Messages that arrive through an automated relay are no longer blocked while recall is being checked.
- **Early compaction and agent-written recall are rolled back.** Both added surprises without helping, so compaction and recall are back to the earlier, simpler behaviour.
- **Antigravity (agy) gets the brain.** Setting up agents now gives Antigravity the brain tool and the automatic recall hook, on every machine. If you connect several agents to one brain, they all get it.
- **Plugin and repository share one version number**, so you can see at a glance that they match.

## 0.4.15

- **One memory, not two.** `AGENTS.md` has a new install step 5 and `CLAUDE.md` a short section: Claude Code's
  built-in memory cannot be turned off, so it becomes a pointer to this repository and facts are written in one
  place only. Two written stores drift apart silently; in the maintainer's own setup 31 of 35 shared files had
  diverged. Found when a person installed this on their own account and their agent asked whether to save to both.

## 0.4.14

- **Agents search in their own words.** `node tools/brain-client.mjs recall <what you are about to do>` sends the
  agent's own description of the task to the brain, and the recall rule tells agents to do it before a task.
  The hook matches the person's raw words, which often do not name the task ("shoot the courier a note" never says
  email). Measured on 8 how-to memories: casual requests found the method 3 of 8 times, the agent's intent
  query 8 of 8, all first.

## 0.4.13

- **Email draft checker.** `tools/email-check.mjs draft.txt [--first]` fails a draft on length (50 to 125
  words on a first contact), more than two questions, any numbered or bulleted list, a sentence over 30
  words, common AI phrases, signs of price shopping in supplier mail, a long subject, and French without
  accents. Length and question figures come from the Boomerang study of 40 million emails.
- **Saves no longer slow the server.** Embeddings are rebuilt only for memories whose text changed, and the
  save runs below normal priority.

## 0.4.12

- **One timeout per turn, not two, when the server is down.** A rules call that cannot reach the server now
  marks it down, so recall on the same turn goes straight to its fallback. Measured on a laptop with the
  server unreachable: 12.2 s for that turn before the change.

## 0.4.11

- **Rules survive a missed server call.** A machine that keeps no memories gets its behaviour rules from the
  server; the hook now keeps the last set it received and uses it, saying so, when the server does not
  answer. One timeout right after a restart used to leave that turn with no rules at all.

## 0.4.10

- **A secret read no longer holds up the server.** The vault decrypt runs as an async child process, so
  recall keeps answering while it runs; a decrypt over 15 s answers 503 (busy) instead of 404 (missing),
  and the client retries once after 3 s.
- **No reminders list at session start.** Session start no longer reads a REMINDERS.md. Dated reminders
  belong in a calendar and undated ones in the memory of their subject, where recall surfaces them when
  the subject comes up.

## 0.4.8

- **Agents are invited to contribute back.** `AGENTS.md` has a Contributing back section: an agent that fixes
  the engine, measures a recall gain, writes a generic how-to memory or adapts the dashboard proposes it
  upstream, after its person agrees and accepts the CLA, with nothing personal in the diff, verify passing
  and the measurement shown, as a pull request to `staging`. `CONTRIBUTING.md` points to it.
- **Docs describe recall as it works.** README, AGENTS.md and CLAUDE.md said every prompt brings five
  pointers; recall has used a match bar plus linked memories, with no fixed count, since 0.4.0.

## 0.4.7

- **Dashboard: group names in their own colour.** Each group name on the sphere is drawn in its group's
  colour, in the mono font of the status line, so it is clear which dots it names. A group with no
  memories gets no name.
- **Dashboard search keeps its groups visible.** While searching, or with a memory selected, the names of
  the groups that hold a match stay coloured and the rest go grey with their dots.
- **Dashboard light mode for slow devices.** When the page is still too slow at its lowest resolution, it
  stops drawing the glow behind ordinary dots (bright and recalled ones keep it) until the screen size
  changes. Measured on one desktop: 4.2 to 3.2 ms a frame with 638 memories.

## 0.4.6

- **A long message is recalled as several small ones.** Each part of a message of 400 characters or more
  gets the full recall a message of its own would get, bar and linked memories included
  (`RECALL_SPLIT_MIN`, 0 turns it off). Measured on one user's 46 real long messages: fully answered
  went from 21 to 32, with no change on shorter questions. A small local model (Qwen2.5 1.5B) as the
  splitter reached 33 of 46 for 0.8 s a message, so it is not used.
- **Each part of a message also brings its best keyword matches**, and a message that names a person
  brings that person's contact memory when exactly one contact has that first name
  (`RECALL_ENTITY=0` turns it off). Long messages 17 to 21 of 46 before the split above.
- **Rate limit per known token, not per address**, so several sessions on one machine no longer starve
  each other; unknown callers keep the tight per-address limit. The hook says "rate limited" instead of
  reporting the embed server down.
- **Machines without a local copy of the memories** are recognised at session start and by the recall
  hook: no failed pull warning, no local index rebuild, and the recall header says the memories are on
  the server. `brain-client status` no longer claims a local copy that is not there.
- **A failed secret read says why.** The server used to answer every failure as "no such secret"; it now
  logs the real reason (a timeout, for example).
- **No assistant attribution in commits.** With `noClaudeAttribution: true` in `brain.json`, session
  start sets Claude Code's attribution setting so commits and pull requests carry no generated-by lines.

## 0.4.1

- **Branches: staging, main, prod.** `staging` replaces `develop` and is where pull requests land, `main`
  is the release candidate, `prod` holds released versions and is now the default branch you clone. The
  contributing guide, workflow and pull request template say so. No code changes.

## 0.4.0

- **Recall without a fixed count, on every install.** Every memory that clears its own bar comes back,
  plus memories linked to them that clear a lower bar, and the meaning index covers the start of each
  memory's text, not only its description. The same code (`tools/recall-core.mjs`) now runs in the
  brain server and in a local install, where `tools/embed-server.mjs` answers `/recall`; before this a
  local install ranked with a plain top 5. Measured on one user's real questions: questions needing
  two memories fully answered went from 31 to 75 of 115 against the old top 5, and single questions
  from 126 to 145 of 167. A linked memory must also reach 1.2 times an even share of activation, so a new
  22-memory brain returns about 6 memories for a trivial question instead of 15, with no change on a
  632-memory brain.
- **Methods are memories.** `kit/memory` holds 14 how-to memories (decks, printable documents,
  writing, research with sources, sub-agent briefs and model choice, saving a memory, plan and verify,
  systematic debugging adapted from obra/superpowers under MIT, review before done, goals, meetings and
  follow-ups, new projects, assistant setup, turning a repeated task into a method), seeded by
  `tools/init.mjs`, with templates in `kit/files`. Benchmarked against the same content as native
  skills (36 requests, blind grading): the right method was used 26 of 28 times against 24, quality tied.
- **Eight starting rules**, each with a one-line short form used between full reminders: model choice,
  sub-agent briefs and one fact per memory join the first five.
- **Any assistant.** `tools/setup-agents.mjs` registers the memory as an MCP server (`recall`,
  `read_memory`) in Claude Code, Claude Desktop, Codex (CLI, IDE, app), Gemini CLI, Antigravity, Cursor,
  VS Code Copilot, Cline, Windsurf, LM Studio and Continue, writes the instruction where each reads it,
  and wires automatic recall where the assistant has a hook (`tools/hook-adapter.mjs` translates Gemini
  CLI, Antigravity, Cursor and Cline formats).
- **The Codex desktop app** gets recall through the MCP server when it does not run hooks
  (`tools/recall-mcp.mjs`, registered by `tools/setup-codex.mjs`).
- **Memory hygiene.** `tools/neuron-check.mjs` checks a draft for duplicates and suggests links, with a
  local model when no server runs; `tools/replace-memory.mjs` retires an outdated memory into
  `deleted/` on a local install; `reflect.mjs` now flags links written by display name, which recall
  cannot follow.
- `tools/build-topics.mjs` groups memories into named topics from their links and meaning, rebuilt with
  the index into `index/topics.json`.
## 0.3.0

- **Codex.** `tools/setup-codex.mjs` connects OpenAI Codex (CLI and IDE extension) to the same memory.
  Codex runs the same `UserPromptSubmit` and `SessionStart` hooks with the same output shape, so
  `hooks/pre-turn.mjs` works unchanged. The script writes `hooks.json` (keeping existing hooks),
  turns Codex's own memories off in `config.toml` without duplicating a table, adds a short block to
  `AGENTS.md`, backs each file up, and runs every hook with Codex's input before saying it passed.
  The one manual step is trusting the hooks with `/hooks` in Codex. See "Using it with Codex" in the
  README.
- Carried over from the host brain since 0.2.9, covered by the clean-install test of this release
  (init, hook, `verify.mjs` 59 passed) but not each re-tested on its own:
  - session start injects a short hot list (`index/HOT.md`) instead of the whole manifest, which had
    grown past its cap and was being cut in half;
  - a memory can also be found by the questions it answers (`index/question-embeddings.json`), scored
    beside its description;
  - a memory can be deleted without unlinking it by hand, into a sealed graveyard it can be restored from;
  - the prompt hook reads only the end of the transcript, after a 529 MB transcript made it slow;
  - multi-machine mode: recall can carry the memory body to a machine that holds no copy, and a
    3 minute cooldown with one retry when a relayed connection is slow to open.

## 0.2.9

- **Dashboard: the `hidden` attribute never worked on the example banner.** `.demo` sets
  `display: flex`, and any author rule that sets display beats the browser's own
  `[hidden] { display: none }`. So the banner kept telling people their `memory/` folder was empty
  while their own memories were drawn behind it, in every release from 0.2.0. One `[hidden]` rule
  fixes it, and every other element toggled with `el.hidden` on that page depended on it too.
- README: the dashboard screenshots are of a populated brain rather than the empty-folder state,
  with captions, a side-by-side of the two views, and the phone shot beside the text instead of
  dropped between paragraphs.

## 0.2.8

- README: the dashboard now has its own section with screenshots, placed right after the quick
  start. It was four paragraphs of prose buried below the benchmarks, with no picture anywhere in
  the repository. A visual tool that nobody can see is a visual tool nobody installs.
- README: the whole `dashboard/config.json` surface is shown inline, with a table of what each key
  changes, so the theming is visible without opening a second file.
- Dashboard: the example constellation no longer emits duplicate edges. Preferential attachment
  could draw the same partner twice for one node, and the detail panel then listed that memory
  twice under CONNECTED. The real graph already deduplicated; only the generated example did not.

## 0.2.7

- README: the tour still told people to right click for a 4K image, which 0.2.6 removed. A shipped
  instruction for a feature that is gone is worse than no instruction.

## 0.2.6

- Dashboard: the page is now a document taller than the viewport, not a fixed layer overdrawn past
  it. The 0.2.4 overdraw did nothing, because a fixed element is laid out against the viewport rect
  and clipped by it, and on iPadOS that rect is the number that is wrong. The body carries
  `min-height: calc(var(--app-h) + 160px)` and the ground is absolute inside it, so it paints in
  document coordinates the way an ordinary scrolling page does.
- Dashboard: `overflow: hidden` comes OFF the root, since the root's overflow propagates to that
  same broken viewport rect and clips the ground straight back. The page is genuinely scrollable
  and the scroll is locked in JavaScript instead, so it looks scrollable and never moves. Panels
  that scroll internally carry `overscroll-behavior: contain`, and the root hides its scrollbar.
- Dashboard: safe-area insets are now per element and per device class rather than one rule for the
  whole app. The detail panel gained `env(safe-area-inset-top)`, which it never had because it is
  `position: fixed` and body padding does not reach a fixed element. On a tablet the bottom controls
  no longer reserve `env(safe-area-inset-bottom)`. On a phone the icon bar has
  `clamp(12px, env(safe-area-inset-bottom), 34px)` for rounded corners and the home indicator, and
  everything that clears that bar grows by the same clamp.
- Dashboard: the detail panel title moved off the display serif, which was unreadable at 27px on a
  retina tablet.
- Dashboard: the 4K image export is removed, with the right click binding on the canvas and its
  rail row. The Names toggle stays.

## 0.2.5

- The publisher refuses a release whose version has no section in this file. 0.2.3 and 0.2.4 both
  shipped while this changelog still stopped at 0.2.2, because nothing checked.
- Backfilled the 0.2.3 and 0.2.4 entries.

## 0.2.4

- Dashboard: the page ground overdraws 120px past the bottom of the reported viewport. On iPadOS a
  standalone app can report a viewport shorter than the screen, and a layout made entirely of
  viewport-sized fixed elements then leaves an unpainted strip. A scrolling page never shows this,
  which is the tell: its background covers the whole content flow.

## 0.2.3

- Dashboard: the canvas takes its size from `window.visualViewport` rather than any CSS viewport
  unit. In a standalone app iPadOS miscalculates the bottom for viewport-sized fixed containers,
  and `100vh`, `100dvh` and `inset:0` all inherit the same wrong number.
- Dashboard: `overflow: hidden` on html and body, because that phantom gap is also scrollable.

## 0.2.2

- Dashboard: safe-area insets moved into the base layout. A 13 inch iPad in landscape is 1288pt
  wide, above the tablet breakpoint, so it landed on the desktop rules, which reserved nothing:
  the title printed under the status bar and the controls sat in the home indicator.
- Dashboard: the canvas is pinned to the viewport with `inset:0` instead of `100vh`, which is not
  the visual viewport on iPadOS and left a black strip along the bottom where the body showed
  through.

## 0.2.1

- `MINDMAP_NODES.md` now ships. `reflect.mjs` and `fix-mindmap-type.mjs` both cite it by name, and
  since the dashboard landed it is the document that says what becomes a node, so a reader who
  followed the citation previously found nothing.
- The exporter checks whether a file BELONGS here, not only whether it names anybody: absolute
  paths, code reaching above the repo root, and citations of documents the export does not
  contain. Three real problems had passed a clean identity scan.
- Removed an absolute path from `status.mjs` and `deep-test.mjs`: both printed or probed one
  machine's directory layout.

## 0.2.0

- **The dashboard.** `node tools/dashboard.mjs --open` draws your memories as a live picture: a node
  per memory, an edge per wikilink, and a current from the machine to the memory on every recall.
  Zero dependencies, no build step; it reads `memory/` directly so it works on a fresh clone.
- With an empty `memory/` it generates an example constellation rather than showing a black screen,
  labelled as an example and replaced by your own the moment you write a memory.
- Two layouts: Sphere groups by kind and bundles links through each band, Constellation positions
  by link structure, computed on the client with no embeddings required.
- Everything about the look is `dashboard/config.json`: name, tagline, regions and which memory
  types fall in each, the whole palette, your own links in the rail, machines on or off.
- Right click saves the view as a PNG with the long edge at 3840. Works on a phone, and can be
  added to a home screen.

## 0.1.2

- Documentation: docs/OPTIONS.md with a diagram per option, docs/BENCHMARKS.md with every measured number and its method, docs/GLOSSARY.md. Keyword-only against fused recall measured on the same corpus.

## 0.1.1

- Semantic recall on by default: `init.mjs` installs the runtime and builds vectors, the hook starts the embedder itself when it is down. `--no-semantic` to opt out.
- Branch model: `main` stable, `develop` for pull requests, releases as tags.

## 0.1.0

First release. Local-only mode.

- Pointer-based recall: five slugs and descriptions per prompt, the agent opens what it needs.
- Two retrieval channels, keyword and semantic, fused. Both on by default, both local. The hook starts the embedder itself.
- Behaviour rules are memories with a `rule:` line, injected every turn. Five generic seeds.
- `tools/init.mjs` sets up an empty brain in one command and verifies itself.
- `tools/install-hook.mjs` wires Claude Code, backs up settings first, never clobbers.
- `tools/verify.mjs` is the gate: parses every tool and hook, checks index sync and reflection.
- `tools/eval-recall.mjs`, `tools/bench-recall.mjs`, `tools/analytics.mjs` measure it.
- Windows tested. Engine is plain Node; scheduling helpers are Windows-only and optional.

Multi-machine mode exists and is used by the authors. It is not documented for outside use yet.
