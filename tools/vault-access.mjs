// Which vault routes a caller may use. Kept apart from brain-server.mjs so the rule is tested on its own
// (tools/vault-access.test.mjs).
//
// full    every vault route.
// recall  no vault route, unless its entry in havok-tokens.json also says "store": true. Then it may ADD a new secret
//         (POST /vault/set/<name>, never replacing one) and list the names it added itself; it can never read a value.
//
// Why the store permission exists (The owner, 2026-10-31): a machine the owner does not control (a work laptop he cannot
// wipe) keeps a recall token but sometimes must save a key it obtained. Store access adds it without that machine ever
// being able to read the other secrets.

export function vaultAccess(caller, method, path) {
  if (!path.startsWith('/vault/')) return 'allow';
  if (caller.scope === 'full') return 'allow';
  if (caller.store === true) {
    if (method === 'POST' && path.startsWith('/vault/set/')) return 'store';
    if (method === 'GET' && path === '/vault/list') return 'own-list';
  }
  return 'deny';
}

export function mayReplace(caller, body) {
  return caller.scope === 'full' && body.replace === true;
}

// The set route appends "(stored by <caller name> <date>)" to every note it writes.
export function ownEntries(entries, callerName) {
  const mark = '(stored by ' + callerName + ' ';
  return entries.filter((e) => String(e.note || '').includes(mark));
}
