// Run by git/commit-msg on EVERY commit to the brain, from an agent, a terminal or a script.
// A credit or an agent line is removed, not refused, and nothing is put in its place (The owner, 2026-10-13: a
// commit never mentions an AI). Agents are stopped earlier by hooks/check-commit-message.mjs. It adds no line.
// It refuses one thing: a staged change to brain.json's limitReserve without the owner's approval line (see
// RESERVE_APPROVAL in commit-message-rules.mjs, and what that check can and cannot stop).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { withoutCredit, reserveChanged, reserveApproved, RESERVE_REFUSAL } from './commit-message-rules.mjs';

const file = process.argv[2];
let msg = '';
try { msg = readFileSync(file, 'utf8'); } catch { process.exit(0); }
const show = (spec) => { try { return execFileSync('git', ['show', spec], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
// A merge (git pull --no-rebase) brings in reserve changes approved in their own commits: it is refused only when the
// staged reserve matches none of its parents, that is, when it was edited by hand while merging.
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
let mergeHeads = [];
try { mergeHeads = readFileSync(git('rev-parse', '--git-path', 'MERGE_HEAD'), 'utf8').split(/\s+/).filter(Boolean); } catch { /* not merging */ }
const staged = show(':brain.json');
const changed = ['HEAD', ...mergeHeads].every((parent) => reserveChanged(show(parent + ':brain.json'), staged));
if (changed && !reserveApproved(msg)) {
  process.stderr.write(RESERVE_REFUSAL + '\n');
  process.exit(1);
}
writeFileSync(file, withoutCredit(msg) + '\n', 'utf8');
process.exit(0);
