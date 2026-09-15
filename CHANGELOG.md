# Changelog

Infinite Context, infinite context for your AI model.

## 0.2.0

- The dashboard: your memories as a live picture, zero dependencies, fully themeable

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
