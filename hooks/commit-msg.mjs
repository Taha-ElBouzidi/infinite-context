// Run by git/commit-msg on EVERY commit to the brain, from an agent, a terminal or a script.
// A credit or an agent line is removed, not refused, and nothing is put in its place (The owner, 2026-10-13: a
// commit never mentions an AI). Agents are stopped earlier by hooks/check-commit-message.mjs. This hook never
// blocks and never adds a line.
import { readFileSync, writeFileSync } from 'node:fs';
import { withoutCredit } from './commit-message-rules.mjs';

const file = process.argv[2];
let msg = '';
try { msg = readFileSync(file, 'utf8'); } catch { process.exit(0); }
writeFileSync(file, withoutCredit(msg) + '\n', 'utf8');
process.exit(0);
