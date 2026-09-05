# Changelog

Infinite Context, infinite context for your AI model.

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
