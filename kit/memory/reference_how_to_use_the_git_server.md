---
name: How to use the shared git server
description: Git server, clone a repo, pull, push, where is the code, git asks for a password: how to get and share code through a shared git server, when the owner runs one for every machine and agent, with the token from the vault and never in a remote address, a memory or a log. Read before cloning, pulling or pushing a shared repository.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 2
  kit_hash: 6a12478570be4fa9
---

# How to use the shared git server

Some owners run one git server (Gitea is one kind) that every machine and agent uses. Code written on one machine then reaches the others without a public code host. Whether this install has one is a fact to look up, never to assume.

## What good looks like

- The address comes from the owner's instructions or a memory, never from a guess.
- The token comes from the vault at the moment git asks, and is written nowhere else.
- Every push is deliberate: the diff was read first and the result is checked afterwards.

## Find out whether there is one

Look for the address in the global instructions, or recall it: search the brain for "git server". If neither names one, this install has none. Say so plainly and use what the owner set up instead (a hosted account, a shared folder, a bundle file); starting a server is a lasting change that needs the owner's yes. When the owner gives you the address, save it as a memory: the address, the vault entry holding the token and the repositories that matter, never the token ([[reference_how_to_save_a_memory]]).

The engine ships no client for such a server, and plain git works everywhere. If `node tools/brain-client.mjs help` lists a `repo` command, this install added one and you may use it.

## Keep the token private

The token is in the vault under the name the memory about the server gives; [[reference_how_to_use_the_vault]] shows how to list and read it. A machine that may not read the vault gets its own account and token from the owner, with only the repositories it needs. Ask for that rather than borrowing another machine's.

Keep the token out of the remote address: that address is saved in `.git/config`, shown by `git remote -v` and copied into logs. Let git ask a helper for the token instead, for example a script kept outside every repository:

```
#!/bin/sh
case "$1" in
  Username*) echo "<git user name>" ;;
  *) node <brain folder>/tools/vault.mjs get <secret-name> ;;
esac
```

Name it with `GIT_ASKPASS` for one command, or `git config core.askPass <script path>` for one clone. Where a brain server decrypts secrets, call `brain-client.mjs secret <secret-name>` in the script instead. Set `GIT_TERMINAL_PROMPT=0` so a missing credential makes git fail with a message instead of waiting for input, and test with `git ls-remote <git server address>/<owner>/<repo>.git`, reading only the result.

## Clone, pull, push

```
git clone <git server address>/<owner>/<repo>.git
git pull
git push
```

- Pull before you start and before you push. Read `git status` and `git diff` before each commit and stage files by name, so no secret or personal file goes in.
- Push the branch the owner expects. Force-push or rewrite pushed history only when the owner asks, because every other machine pulls from it.
- Say a push worked only after git's output shows it. Check that `git remote -v` and `.git/config` hold no token, and read git output for a token before pasting it into a message, a memory or a log.
- A 401, 403 or 404 is a refusal, not a network fault: give the owner the address and the code. No answer at all is a network or server problem, and you say so.

## Commit identity and messages

Commit under the identity the owner chose for this server, the owner's own or one made for agents. Check `git config user.name` and `git config user.email` in the repository. If they are empty or belong to someone else, ask which to use rather than inventing a name or an email, and set them without `--global`, so another project's identity is never used by accident. A message says in one plain line what changed and why, and holds no secret, personal data or pasted log. Follow any rule the owner has given for commit messages.

## Related
[[reference_how_to_use_the_vault]] [[reference_how_to_save_a_memory]] [[reference_how_to_review_work_before_calling_it_done]] [[feedback_reversible_act_irreversible_ask]] [[feedback_verify_before_claiming]]
