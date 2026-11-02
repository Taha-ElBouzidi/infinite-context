// node --test tools/kit.test.mjs
// The starter kit after install (the owner, 2026-11-02): a kit method the user has not changed is refreshed when the
// kit moves on; one the user changed is never overwritten, the new version waits in kit-updates/ and is offered once;
// the user's own memories are never touched. Every case runs on a temporary brain; the real memory/ is never used.
// The last tests check the real kit/memory: each method stamped with a current version and hash, findable by the
// words a person types, linked to another kit method, and free of the owner's private terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonical, kitHash, readKitFields, stampKit, refreshKit, acceptKit, kitStatus } from './kit.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-02';

const method = (title, body, extra = '') => [
  '---',
  'name: How to ' + title,
  'description: ' + title + ', the words a person types: how to do it properly. Read before doing it.',
  'type: reference',
  'metadata:',
  '  type: reference',
  '  asserted: 2026-09-26',
  '  updated: 2026-09-26',
  ...(extra ? [extra] : []),
  '---',
  '',
  '# How to ' + title,
  '',
  body,
  '',
  '## Related',
  '[[reference_how_to_other]]',
  '',
].join('\n');

function tempBrain(kit = {}, memory = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kit-'));
  mkdirSync(join(root, 'kit', 'memory'), { recursive: true });
  mkdirSync(join(root, 'memory'), { recursive: true });
  for (const [n, t] of Object.entries(kit)) writeFileSync(join(root, 'kit', 'memory', n), t);
  for (const [n, t] of Object.entries(memory)) writeFileSync(join(root, 'memory', n), t);
  return root;
}
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const done = (root) => rmSync(root, { recursive: true, force: true });
// Publishes a new version of a kit method the way the maintainer does: edit kit/memory, then stamp.
function newKitVersion(root, name, body) {
  const p = join(root, 'kit', 'memory', name);
  const old = readFileSync(p, 'utf8');
  writeFileSync(p, old.replace(/\n# How to ([^\n]+)\n\n[\s\S]*?\n\n## Related/, (m, t) => '\n# How to ' + t + '\n\n' + body + '\n\n## Related'));
  stampKit(join(root, 'kit'), { today: TODAY });
}

test('the content hash ignores dates, kit fields, line endings and trailing spaces, and nothing else', () => {
  const a = method('write a thing', 'Do it well.');
  const b = a.replace('asserted: 2026-09-26', 'asserted: 2027-01-05').replace('updated: 2026-09-26', 'updated: 2027-02-01')
    .replace('  updated:', '  kit_version: 4\n  kit_hash: 0123456789abcdef\n  updated:').split('\n').join('\r\n').replace('Do it well.', 'Do it well.   ');
  assert.equal(kitHash(a), kitHash(b));
  assert.equal(canonical(a), canonical(b));
  assert.notEqual(kitHash(a), kitHash(a.replace('Do it well.', 'Do it better.')));
  assert.notEqual(kitHash(a), kitHash(a.replace('words a person types', 'words people type')));
  assert.match(kitHash(a), /^[0-9a-f]{16}$/);
});

test('stamp gives each method version 1 and its hash, is idempotent, and a content change bumps the version and keeps the old hash', () => {
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'First.') });
  try {
    const kit = join(root, 'kit');
    stampKit(kit, { today: TODAY });
    const v1 = read(root, 'kit/memory/reference_how_to_a.md');
    assert.deepEqual(readKitFields(v1), { kit_version: 1, kit_hash: kitHash(v1) });
    const again = stampKit(kit, { today: TODAY });
    assert.equal(read(root, 'kit/memory/reference_how_to_a.md'), v1, 'a second stamp with no change rewrites nothing');
    assert.equal(again.changed.length, 0);
    newKitVersion(root, 'reference_how_to_a.md', 'Second, better.');
    const v2 = read(root, 'kit/memory/reference_how_to_a.md');
    assert.deepEqual(readKitFields(v2), { kit_version: 2, kit_hash: kitHash(v2) });
    assert.match(v2, /\n  updated: 2026-11-02\n/);
    const history = JSON.parse(read(root, 'kit/history.json'));
    assert.deepEqual(history['reference_how_to_a.md'], [kitHash(v1)]);
    assert.equal(stampKit(kit, { today: TODAY, check: true }).stale.length, 0);
    writeFileSync(join(kit, 'memory', 'reference_how_to_a.md'), v2.replace('Second, better.', 'Edited, not stamped.'));
    assert.deepEqual(stampKit(kit, { today: TODAY, check: true }).stale, ['reference_how_to_a.md'], '--check names a method edited without a new stamp');
  } finally { done(root); }
});

test('first install copies every kit method with today as its date and remembers them', () => {
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'A.'), 'reference_how_to_b.md': method('b', 'B.') });
  try {
    stampKit(join(root, 'kit'), { today: TODAY });
    const r = refreshKit({ brain: root, today: TODAY, init: true });
    assert.deepEqual(r.added.sort(), ['reference_how_to_a.md', 'reference_how_to_b.md']);
    const copy = read(root, 'memory/reference_how_to_a.md');
    assert.match(copy, /\n  asserted: 2026-11-02\n  updated: 2026-11-02\n/);
    assert.equal(kitHash(copy), kitHash(read(root, 'kit/memory/reference_how_to_a.md')));
    const state = JSON.parse(read(root, '.kit-state.json'));
    assert.deepEqual(state.seen.sort(), ['reference_how_to_a.md', 'reference_how_to_b.md']);
  } finally { done(root); }
});

test('a kit method the user has not changed is refreshed to the new version, keeping its first date', () => {
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'Version one.') });
  try {
    stampKit(join(root, 'kit'), { today: TODAY });
    refreshKit({ brain: root, today: '2026-10-01', init: true });
    newKitVersion(root, 'reference_how_to_a.md', 'Version two, with a better step.');
    const r = refreshKit({ brain: root, today: TODAY });
    assert.deepEqual(r.refreshed, ['reference_how_to_a.md']);
    const copy = read(root, 'memory/reference_how_to_a.md');
    assert.match(copy, /Version two, with a better step\./);
    assert.equal(readKitFields(copy).kit_version, 2);
    assert.match(copy, /\n  asserted: 2026-10-01\n/, 'the date it was first installed stays');
    assert.match(copy, /\n  updated: 2026-11-02\n/);
    assert.ok(!existsSync(join(root, 'kit-updates', 'reference_how_to_a.md')), 'nothing waits when the copy was refreshed');
    assert.deepEqual(refreshKit({ brain: root, today: TODAY }).current, ['reference_how_to_a.md']);
  } finally { done(root); }
});

test('a kit method the user changed is never overwritten: the new version waits in kit-updates/ and is offered once', () => {
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'Version one.') });
  try {
    stampKit(join(root, 'kit'), { today: TODAY });
    refreshKit({ brain: root, today: TODAY, init: true });
    const mine = read(root, 'memory/reference_how_to_a.md').replace('Version one.', 'Version one, and my own step that matters to me.');
    writeFileSync(join(root, 'memory', 'reference_how_to_a.md'), mine);
    newKitVersion(root, 'reference_how_to_a.md', 'Version two.');
    const r = refreshKit({ brain: root, today: TODAY });
    assert.deepEqual(r.waiting, ['reference_how_to_a.md']);
    assert.deepEqual(r.refreshed, []);
    assert.equal(read(root, 'memory/reference_how_to_a.md'), mine, 'the user copy is byte for byte what the user wrote');
    const offered = read(root, 'kit-updates/reference_how_to_a.md');
    assert.match(offered, /Version two\./);
    assert.match(read(root, 'kit-updates/README.md'), /reference_how_to_a\.md/);
    const again = refreshKit({ brain: root, today: TODAY });
    assert.deepEqual(again.waiting, [], 'the same version is not offered twice');
    assert.deepEqual(again.kept, ['reference_how_to_a.md']);
    unlinkSync(join(root, 'kit-updates', 'reference_how_to_a.md'));
    refreshKit({ brain: root, today: TODAY });
    assert.ok(!existsSync(join(root, 'kit-updates', 'reference_how_to_a.md')), 'deleting the offer declines it for good');
    newKitVersion(root, 'reference_how_to_a.md', 'Version three.');
    assert.deepEqual(refreshKit({ brain: root, today: TODAY }).waiting, ['reference_how_to_a.md'], 'a newer version is offered again');
    assert.match(read(root, 'kit-updates/reference_how_to_a.md'), /Version three\./);
    assert.equal(read(root, 'memory/reference_how_to_a.md'), mine);
  } finally { done(root); }
});

test('the user own memories are never touched, even one named like a new kit method', () => {
  const own = {
    'user_me.md': '---\nname: Me\ndescription: who I am, my name and my work\ntype: user\n---\n\nI am the owner.\n',
    'feedback_my_rule.md': '---\nname: My rule\ndescription: my rule for replies, keep them short\ntype: feedback\n---\n\nShort.\n',
    'project_my_project.md': '---\nname: My project\ndescription: my project status and next steps\ntype: project\n---\n\nOngoing.\n',
    'reference_how_to_b.md': '---\nname: My own way to do b\ndescription: b, my own method that I wrote myself\ntype: reference\n---\n\nMine.\n',
    'notes.txt': 'not a memory',
  };
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'A.') }, own);
  try {
    stampKit(join(root, 'kit'), { today: TODAY });
    const before = Object.fromEntries(Object.keys(own).map((n) => [n, statSync(join(root, 'memory', n)).mtimeMs]));
    refreshKit({ brain: root, today: TODAY, init: true });
    writeFileSync(join(root, 'kit', 'memory', 'reference_how_to_b.md'), method('b', 'The kit b.'));
    stampKit(join(root, 'kit'), { today: TODAY });
    newKitVersion(root, 'reference_how_to_a.md', 'A, version two.');
    const r = refreshKit({ brain: root, today: TODAY });
    for (const [n, text] of Object.entries(own)) {
      assert.equal(read(root, 'memory/' + n), text, n + ' is unchanged');
      assert.equal(statSync(join(root, 'memory', n)).mtimeMs, before[n], n + ' was not even rewritten');
    }
    assert.deepEqual(r.waiting, ['reference_how_to_b.md'], 'the kit b is offered beside the user b, never over it');
    assert.deepEqual(r.refreshed, ['reference_how_to_a.md']);
    const names = readdirSync(join(root, 'memory')).sort();
    assert.deepEqual(names, [...Object.keys(own), 'reference_how_to_a.md'].sort(), 'no file was added or removed besides the kit method');
  } finally { done(root); }
});

test('a copy installed before kit versions existed is recognised by its hash: refreshed if unchanged, offered if changed', () => {
  const v0 = method('a', 'Original.');
  const v0b = method('b', 'Original b.');
  const root = tempBrain({ 'reference_how_to_a.md': v0, 'reference_how_to_b.md': v0b }, {
    // What the old init wrote: the kit text with today's date in place of 2026-09-26, no kit fields.
    'reference_how_to_a.md': v0.split('2026-09-26').join('2026-10-04'),
    'reference_how_to_b.md': v0b.split('2026-09-26').join('2026-10-04').replace('Original b.', 'Original b, changed by me.'),
  });
  try {
    writeFileSync(join(root, 'kit', 'history.json'), JSON.stringify({ 'reference_how_to_a.md': [kitHash(v0)], 'reference_how_to_b.md': [kitHash(v0b)] }));
    stampKit(join(root, 'kit'), { today: TODAY });
    newKitVersion(root, 'reference_how_to_a.md', 'Improved.');
    newKitVersion(root, 'reference_how_to_b.md', 'Improved b.');
    const r = refreshKit({ brain: root, today: TODAY });
    assert.deepEqual(r.refreshed, ['reference_how_to_a.md']);
    assert.deepEqual(r.waiting, ['reference_how_to_b.md']);
    assert.match(read(root, 'memory/reference_how_to_a.md'), /Improved\./);
    assert.match(read(root, 'memory/reference_how_to_b.md'), /changed by me/);
  } finally { done(root); }
});

test('a kit method the user deleted is not brought back, a new kit method is added', () => {
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'A.'), 'reference_how_to_b.md': method('b', 'B.') });
  try {
    stampKit(join(root, 'kit'), { today: TODAY });
    refreshKit({ brain: root, today: TODAY, init: true });
    unlinkSync(join(root, 'memory', 'reference_how_to_a.md'));
    writeFileSync(join(root, 'kit', 'memory', 'reference_how_to_c.md'), method('c', 'C.'));
    stampKit(join(root, 'kit'), { today: TODAY });
    const r = refreshKit({ brain: root, today: TODAY });
    assert.deepEqual(r.skipped, ['reference_how_to_a.md']);
    assert.deepEqual(r.added, ['reference_how_to_c.md']);
    assert.ok(!existsSync(join(root, 'memory', 'reference_how_to_a.md')));
    assert.deepEqual(refreshKit({ brain: root, today: TODAY, force: true }).added, ['reference_how_to_a.md'], '--force puts a deleted one back');
  } finally { done(root); }
});

test('an install with kit copies but no state yet counts the methods it already had as seen', () => {
  const a = method('a', 'A.');
  const c = method('c', 'C.');
  const root = tempBrain({ 'reference_how_to_a.md': a, 'reference_how_to_c.md': c, 'reference_how_to_new.md': method('new', 'New.') },
    { 'reference_how_to_c.md': c.split('2026-09-26').join('2026-10-04') });
  try {
    // The new method has a history entry too (stamped twice before release): it must still be added.
    writeFileSync(join(root, 'kit', 'history.json'), JSON.stringify({
      _before_versions: ['reference_how_to_a.md', 'reference_how_to_c.md'], 'reference_how_to_a.md': [kitHash(a)], 'reference_how_to_c.md': [kitHash(c)], 'reference_how_to_new.md': ['00000000deadbeef'],
    }));
    stampKit(join(root, 'kit'), { today: TODAY });
    const r = refreshKit({ brain: root, today: TODAY });
    assert.deepEqual(r.skipped, ['reference_how_to_a.md'], 'a method from before kit versions that is missing was deleted by the user');
    assert.deepEqual(r.added, ['reference_how_to_new.md']);
    assert.deepEqual(r.current, ['reference_how_to_c.md']);
  } finally { done(root); }
});

test('an install that never received the kit memories gets all of them', () => {
  const a = method('a', 'A.');
  const root = tempBrain({ 'reference_how_to_a.md': a, 'reference_how_to_b.md': method('b', 'B.') }, { 'user_me.md': '---\nname: Me\ndescription: who I am and what I do for work\ntype: user\n---\n\nMe.\n' });
  try {
    writeFileSync(join(root, 'kit', 'history.json'), JSON.stringify({ _before_versions: ['reference_how_to_a.md', 'reference_how_to_b.md'], 'reference_how_to_a.md': [kitHash(a)] }));
    stampKit(join(root, 'kit'), { today: TODAY });
    assert.deepEqual(refreshKit({ brain: root, today: TODAY }).added, ['reference_how_to_a.md', 'reference_how_to_b.md']);
  } finally { done(root); }
});

test('accept takes the waiting version and keeps the user copy as a backup', () => {
  const root = tempBrain({ 'reference_how_to_a.md': method('a', 'One.') });
  try {
    stampKit(join(root, 'kit'), { today: TODAY });
    refreshKit({ brain: root, today: TODAY, init: true });
    const mine = read(root, 'memory/reference_how_to_a.md').replace('One.', 'One, mine.');
    writeFileSync(join(root, 'memory', 'reference_how_to_a.md'), mine);
    newKitVersion(root, 'reference_how_to_a.md', 'Two.');
    refreshKit({ brain: root, today: TODAY });
    const r = acceptKit({ brain: root, name: 'reference_how_to_a', today: TODAY });
    assert.match(read(root, 'memory/reference_how_to_a.md'), /Two\./);
    assert.equal(readFileSync(r.backup, 'utf8'), mine);
    assert.ok(!existsSync(join(root, 'kit-updates', 'reference_how_to_a.md')));
    assert.equal(kitStatus({ brain: root }).find((s) => s.name === 'reference_how_to_a.md').state, 'current');
  } finally { done(root); }
});

// ---- the real kit -------------------------------------------------------------------------------
const KIT = join(REPO, 'kit', 'memory');
const kitFiles = existsSync(KIT) ? readdirSync(KIT).filter((n) => n.endsWith('.md')) : [];
const fm = (t) => { const n = t.replace(/\r\n/g, '\n'); const e = n.indexOf('\n---', 3); return n.startsWith('---') && e > 0 ? n.slice(4, e) : ''; };
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('every kit method is stamped with its current version and hash', () => {
  assert.ok(kitFiles.length >= 14, 'the kit has its methods');
  const r = stampKit(join(REPO, 'kit'), { check: true });
  assert.deepEqual(r.stale, [], 'edited without a new stamp, run: node tools/kit.mjs stamp');
});

test('every kit method is findable and linked: words a person types first, one method per file, a link to another kit method', () => {
  for (const f of kitFiles) {
    const text = readFileSync(join(KIT, f), 'utf8');
    const head = fm(text);
    const desc = (head.match(/^description:\s*(.+)$/m) || [])[1] || '';
    assert.ok(desc.length >= 40, f + ': description too short to be recalled');
    assert.ok(!/^how to\b/i.test(desc.trim()), f + ': the description starts with "How to", start with the words a person types');
    assert.match(head, /^type: reference$/m, f);
    assert.match(f, /^reference_how_to_[a-z0-9_]+\.md$/, f + ': one method per file, named reference_how_to_<slug>.md');
    const links = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    const toKit = links.filter((l) => l !== f.replace(/\.md$/, '') && kitFiles.includes(l + '.md'));
    assert.ok(toKit.length >= 1, f + ': links no other kit method');
    for (const l of links.filter((x) => x.startsWith('reference_how_to_'))) assert.ok(kitFiles.includes(l + '.md'), f + ': links [[' + l + ']], which is not in the kit');
  }
});

test('nothing in the kit uses characters the house style forbids', () => {
  const forbidden = [0x2013, 0x2014, 0x2713, 0x2714, 0x2705, 0x274C].map((c) => String.fromCharCode(c));
  const isArrow = (c) => c.charCodeAt(0) >= 0x2190 && c.charCodeAt(0) <= 0x21FF;
  // A folder with its own LICENSE is adapted third-party material, kept as its authors wrote it.
  const thirdParty = (p) => existsSync(join(dirname(p), 'LICENSE'));
  for (const p of walk(join(REPO, 'kit')).filter((x) => /\.(md|json)$/.test(x) && !thirdParty(x))) {
    let inCode = false;
    readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*```/.test(l)) inCode = !inCode;
      // An ASCII arrow inside a fenced block is code (a graph, a shell pipe), not prose.
      const bad = forbidden.some((c) => l.includes(c)) || [...l].some(isArrow) || (!inCode && /\s->\s|\s=>\s/.test(l));
      assert.ok(!bad, p + ':' + (i + 1) + ' has an em dash, en dash, arrow or checkmark');
    });
  }
});

// Only where the owner's brain.json exists, which is never in the public export: the kit must be clean at its source,
// because installed copies are recognised by hash and the export must not change a single byte of them.
test('the kit carries none of the owner private terms', { skip: !existsSync(join(REPO, 'brain.json')) }, () => {
  const cfg = JSON.parse(readFileSync(join(REPO, 'brain.json'), 'utf8'));
  const an = cfg.anonymise || {};
  // The same two tests the release makes: the publish scan matches its terms in any case, and the exporter's
  // replacements match exactly (one would change the bytes of a kit method, so no copy would match its hash).
  const swapped = [...(an.everywhere || []), ...(an.commentsOnly || [])].map((p) => p[0]);
  for (const p of walk(join(REPO, 'kit')).filter((x) => !x.endsWith('LICENSE'))) {
    let t = readFileSync(p, 'utf8');
    for (const pr of an.protect || []) t = t.split(pr).join('');
    for (const term of an.scan || []) assert.ok(!t.toLowerCase().includes(String(term).toLowerCase()), p + ' contains a private term: ' + term);
    for (const term of swapped) assert.ok(!t.includes(term), p + ' contains a term the exporter would replace: ' + term);
  }
});
