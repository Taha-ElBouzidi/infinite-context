# CHANGELOG.md, Infinite Context

Append-only. Never edit or delete past entries. Never rewrite history.
Full entries for features and breaking changes. Brief one-liners for small fixes.

---

## Full Entry Format

### [YYYY-MM-DD] Title

**Type:** feat | fix | refactor | docs | test | chore
**Scope:** [module or area]
**Summary:** [what changed and why, 2-4 sentences]
**Files:** [key files changed]

---

## Brief Entry Format

- [YYYY-MM-DD] [type]([scope]): [one-line description], [key files]

---

## Log

- [2026-09-05] docs(options): OPTIONS, BENCHMARKS, GLOSSARY and four diagrams; keyword-only vs fused measured on 274 memories, 41 questions, 92.7% vs 97.6%, 91ms vs 187ms median, docs/*

### [2026-09-05] First release, 0.1.0, local-only mode

**Type:** feat
**Scope:** engine
**Summary:** The engine was separated from the authors' own instance and published. Recall is
pointer-based: five slugs and descriptions per prompt, the agent opens what it needs. Behaviour
rules are memories carrying a `rule:` line, injected every turn, with five generic seeds.
`tools/init.mjs` sets up an empty brain in one command. `tools/install-hook.mjs` wires Claude
Code and backs up settings first. `tools/verify.mjs` is the gate. Everything instance-specific
lives in `brain.json`, which is never committed upstream.
**Files:** tools/init.mjs, tools/install-hook.mjs, tools/verify.mjs, hooks/pre-turn.mjs, README.md, AGENTS.md

### [2026-09-05] Project governance scaffolded

**Type:** chore
**Scope:** project
**Summary:** Added CLAUDE.md, AGENTS.md, CONTRIBUTING.md, CLA.md, SECURITY.md, the `.project/`
documents and the `.github/` templates, including a workflow that requires a signed CLA on every
pull request.
**Files:** CLAUDE.md, AGENTS.md, CONTRIBUTING.md, CLA.md, SECURITY.md, .project/*, .github/*
