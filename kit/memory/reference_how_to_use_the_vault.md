---
name: How to use the vault for secrets
description: Password, API key, token, secret, credentials, login, where is the key: how to read a secret from the vault, store a new one, and keep it out of chats, files and commits. Read before using, asking for or saving any credential, and when a secret is missing or this machine is refused access.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: 8453e2d3070a17a8
---

# How to use the vault for secrets

The vault is the brain's keychain: each secret is stored encrypted for the machines the owner allows to read it. A secret lives there and nowhere else: not in a memory, a chat message, a tracked file, a commit message or a log. A memory about a service names the vault entry (`<secret-name>`) and what it is for, never the value.

## What good looks like

- Check the vault before asking the owner for a credential. Ask only when it is truly not there, then store what you are given.
- Use a value inside the command that needs it, never on screen.

## Read a secret

| | This machine holds a vault key | A brain server decrypts for it |
|---|---|---|
| names | `node tools/vault.mjs list` | `node tools/brain-client.mjs list` |
| value | `node tools/vault.mjs get <secret-name>` | `node tools/brain-client.mjs secret <secret-name>` |

`list` shows names and dates, never values. Run `get` or `secret` only inside the command that uses the value: on its own it prints the value into the conversation. Pipe it to a tool that reads standard input, or set it as an environment variable for that one command, rather than passing it as an argument, which other programs can see and some tools echo when they fail.

## Store a secret

```
<command that prints the value> | node tools/vault.mjs set <secret-name> --note "what it is for"
<command that prints the value> | node tools/brain-client.mjs store-secret <secret-name> --note "what it is for"
```

The value arrives on standard input, never as an argument. Use lowercase letters, digits and underscores in the name, such as `<service>_api_key`. Name and note are not encrypted, so neither may hold the value. `vault.mjs set` replaces an entry of the same name: read `list` first, or add `--new` to refuse. Add `--to <MACHINE>,<MACHINE>` to let only those machines read it. `store-secret` refuses an existing name unless `--replace` is given, and only when the owner asked for the replacement. If the owner pastes a secret into the chat, store it and use it, and do not repeat the value.

## First time on a machine

The vault needs the `age` program (ask the owner before installing it). Then:

```
node tools/vault.mjs machine-init
node tools/vault.mjs machine-add <MACHINE-NAME> <public key machine-init printed>
```

`machine-init` creates this machine's key, keeps the private half outside the brain folder and never prints it. `machine-add` registers the public half so secrets can be stored. `node tools/vault.mjs` alone says whether this machine has a key.

## Access is per machine

When the owner asks, a machine that can already read a secret gives access to a registered machine: `node tools/vault.mjs grant <secret-name> --to <MACHINE>`. A new machine registers first with `machine-add` and its own public key. Removing access later does not undo what a machine already read, so replace the real credential at its provider if that machine is not trusted.

## When a secret is missing or access is refused

- "No secret named" or "no such secret" (404): run `list` for a similar name. If it is truly absent, ask the owner, then store it.
- "not a recipient", `[NOT readable here]` or "forbidden" (403): the owner chose not to give this machine that secret. Tell the owner which secret and which machine, and wait. Do not retry or look for another route.
- "no age key": follow "First time on a machine".
- "unauthorized" (401) or "NO TOKEN": the brain server does not accept this machine's token, or this machine has none. Tell the owner.
- "vault busy" (503) or no answer: retry once after a few seconds, then say the server is unreachable rather than asking the owner for the key.

When a value is missing, ask the owner; never guess one, borrow one from another service or hardcode one. If a value reaches the conversation through your own doing, tell the owner at once and treat it as exposed: replace the real credential at its provider.

## Related
[[reference_how_to_use_the_brain]] [[reference_how_to_use_the_git_server]] [[reference_how_to_save_a_memory]] [[reference_how_to_message_another_agent]] [[feedback_reversible_act_irreversible_ask]] [[feedback_say_when_the_brain_is_down]]
