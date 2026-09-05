# Security, Infinite Context

This software runs entirely on your own machine and, in multi-machine mode, on your own private
network. It stores memory as plain markdown files you control. It makes no outbound connections
in local mode.

## Reporting a vulnerability

Do not open a public issue for a security problem. Open a private security advisory on the
repository (Security tab, "Report a vulnerability"), or contact the maintainer directly through
the profile listed on the repository.

Include what you ran, what you observed, and what you expected. A report with those three things
gets acted on quickly.

## What is and is not in scope

In scope: anything that lets a memory, a credential or a hook execute or leak in a way the owner
did not intend; anything that lets one machine on a shared brain read what it was not scoped to.

Out of scope: the contents of your own memories. You wrote them, you control them, and the tool
will faithfully index whatever you put in them.

## Design notes worth knowing before you audit

- The recall hook injects text into the agent's context on every prompt. Anything that can write
  to `memory/` can therefore influence the agent. Treat write access to that directory as you
  would treat write access to the agent's instructions.
- The multi-machine server binds only to loopback and its private-network address, never to
  `0.0.0.0`, and pins a self-signed certificate. `tools/deep-test.mjs` verifies both.
- Tokens are scoped. A recall-scoped token is refused on the credential vault with a 403 and the
  refusal names what to do. `tools/remote-test.mjs` verifies this from a remote machine.
