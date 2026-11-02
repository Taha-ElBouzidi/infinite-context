// Rows per machine in the analytics store on the host (tools/analytics-store.mjs).
//   node tools/analytics-count.mjs          a table per kind
//   node tools/analytics-count.mjs --json   the same as JSON
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counts, storeDir } from './analytics-store.mjs';

const BRAIN = process.env.HAVOK_ANALYTICS_BRAIN || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const all = counts(BRAIN);
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(all, null, 2) + '\n'); process.exit(0); }
const kinds = Object.keys(all);
if (!kinds.length) { console.log('No analytics rows yet in ' + storeDir(BRAIN)); process.exit(0); }
console.log('Analytics rows in ' + storeDir(BRAIN));
for (const kind of kinds) {
  const per = all[kind];
  const total = Object.values(per).reduce((s, c) => s + c.rows, 0);
  console.log('');
  console.log(kind + ': ' + total + ' row' + (total === 1 ? '' : 's'));
  for (const [machine, c] of Object.entries(per).sort((a, b) => b[1].rows - a[1].rows)) {
    console.log('  ' + machine.padEnd(14) + String(c.rows).padStart(7) + '   ' + (c.first || '?').slice(0, 16) + ' to ' + (c.last || '?').slice(0, 16));
  }
}
