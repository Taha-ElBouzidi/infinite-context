# ONBOARDING.md, New Developer and AI Agent Setup

## For AI Agents (30 seconds)

If you are installing this for a person, read `AGENTS.md` and follow it. It is written for you.

If you are contributing code, read these before doing anything else:

1. `CLAUDE.md`, how recall reaches you and how to write a memory
2. `.project/STRUCTURE.md`, file layout and data flow
3. `.project/CHANGELOG.md`, last entries, what changed recently
4. `.project/DECISIONS.md`, why it is built this way, so you do not re-argue it

Never start work without reading these. Never assume the structure from memory without verifying.

---

## For Human Developers (30 minutes)

### Prerequisites

- [ ] Node 18 or newer
- [ ] git
- [ ] Claude Code, if you want to see the hook run for real

### Setup

```sh
# 1. Clone
git clone https://github.com/Taha-ElBouzidi/infinite-context
cd infinite-context

# 2. Initialise an empty brain and build its index
node tools/init.mjs

# 3. Wire Claude Code (optional for development, required to see recall in a session)
node tools/install-hook.mjs

# 4. Verify
node tools/verify.mjs

# 5. Optional: semantic recall
npm install
node tools/embed-server.mjs
```

### First day checklist

- [ ] `node tools/verify.mjs` prints `BRAIN VERIFY PASSED`
- [ ] Write one memory by hand, rebuild the index, and see it come back in a prompt
- [ ] Read `.project/WORKFLOW.md`, branching and commit convention
- [ ] Read `.project/DECISIONS.md`, the decisions you will otherwise want to re-make
- [ ] Sign the CLA on your first pull request when the bot asks

### Where things live

| What | Where |
|---|---|
| the memories | `memory/` |
| the generated index | `index/`, never edit |
| the hook | `hooks/pre-turn.mjs` |
| the gate | `tools/verify.mjs` |
| your own instance config | `brain.json`, not committed upstream |
