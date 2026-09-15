#!/usr/bin/env node
// The brain, as a live picture. A zero-dependency server for dashboard/index.html.
//
//   node tools/dashboard.mjs [--port 8492] [--host 127.0.0.1] [--open]
//
// It reads memory/ directly rather than the generated index, so it works on a clone that has
// never run build-index, and it needs nothing installed: no framework, no build step, no npm
// install. That is the design constraint. Anyone who clones this repo can see their brain
// thirty seconds later.
//
// WITH AN EMPTY memory/ IT GENERATES A CONSTELLATION. A fresh clone has no memories, and a black
// screen teaches nobody what the thing is. So it invents a plausible one, marked as a demo in the
// payload so the page can say so. The moment one real memory exists the demo is gone.

import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname, normalize } from 'node:path';
import { hostname } from 'node:os';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(BRAIN, 'dashboard');
const MEM = join(BRAIN, 'memory');
const NL = String.fromCharCode(10);
const say = (s) => process.stdout.write(s + NL);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const PORT = Number(flag('port', process.env.BRAIN_DASHBOARD_PORT || 8492));
// Loopback by default. A picture of your own memory is not something to bind to every interface
// by accident, so widening it has to be typed on purpose.
const HOST = flag('host', '127.0.0.1');

// ---- configuration the user owns ------------------------------------------------------------
const DEFAULTS = {
  name: 'Your AI',
  tagline: 'the brain',
  regions: [
    { key: 'IDENTITY', types: ['person', 'user', 'contact'], color: '#8FA9CE' },
    { key: 'PROJECTS', types: ['project'], color: '#7FBBA4' },
    { key: 'RULES', types: ['feedback', 'rule'], color: '#D3A96B' },
    { key: 'REFERENCE', types: ['reference'], color: '#A79FC0' },
  ],
  colors: {
    void: '#07080A', ink: '#EDEAE3', ink2: '#9B978D', ink3: '#5E5C56',
    accent: '#D9C08C', accent2: '#8C7A53', pulse: '#6FB7FF', pulse2: '#B9DDFF',
    up: '#6FD3A5', down: '#E0806A',
  },
  links: [],
  showMachines: true,
};

function config() {
  const f = join(WEB, 'config.json');
  if (!existsSync(f)) return DEFAULTS;
  try {
    const user = JSON.parse(readFileSync(f, 'utf8'));
    return {
      ...DEFAULTS,
      ...user,
      colors: { ...DEFAULTS.colors, ...(user.colors || {}) },
      regions: Array.isArray(user.regions) && user.regions.length ? user.regions : DEFAULTS.regions,
    };
  } catch (e) {
    // A typo in config.json must not take the dashboard down with it.
    say('config.json is not valid JSON, using defaults: ' + e.message);
    return DEFAULTS;
  }
}

// ---- reading the brain -----------------------------------------------------------------------
// The same frontmatter parse as build-index.mjs, including the CRLF normalisation. A trailing
// carriage return defeats the line anchors and silently drops every key but the last, which once
// misfiled 22 memories with no error anywhere.
function frontmatter(input) {
  const raw = input.replace(/\r\n/g, '\n');
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const out = {};
  let inMeta = false;
  for (const line of raw.slice(3, end).split('\n')) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const m = line.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, val] = m;
    if (indent.length > 0 && inMeta) out['meta_' + key] = val.trim();
    else { inMeta = false; out[key] = val.trim(); }
  }
  return out;
}

const regionOf = (cfg, type) => {
  const t = String(type || 'reference').toLowerCase();
  for (const r of cfg.regions) if ((r.types || []).some((x) => t.startsWith(x))) return r;
  return cfg.regions[cfg.regions.length - 1];
};

function readBrain(cfg) {
  if (!existsSync(MEM)) return null;
  const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  if (!files.length) return null;
  const nodes = [];
  const bySlug = new Map();
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    let text = '';
    try { text = readFileSync(join(MEM, f), 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    const type = fm.meta_type || fm.type || slug.split('_')[0];
    const body = text.replace(/^---[\s\S]*?\n---\n/, '');
    const reg = regionOf(cfg, type);
    const n = {
      slug,
      name: fm.name || slug.replace(/_/g, ' '),
      desc: fm.description || '',
      type,
      region: reg.key,
      color: reg.color,
      // One fact per non-blank line, the same unit the index counts.
      facts: body.split(/\r?\n/).filter((l) => l.trim()).length,
      deg: 0,
      wiki: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()),
    };
    nodes.push(n);
    bySlug.set(slug, n);
  }
  // A wikilink names another memory's slug. Edges are undirected and deduplicated: A links B and
  // B links A is one relationship, not two.
  const seen = new Set();
  const edges = [];
  for (const n of nodes) {
    for (const target of n.wiki) {
      const t = bySlug.get(target);
      if (!t || t === n) continue;
      const key = [n.slug, t.slug].sort().join(' |> ');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([n.slug, t.slug]);
      n.deg++;
      t.deg++;
    }
  }
  for (const n of nodes) delete n.wiki;
  return { nodes, edges, demo: false };
}

// ---- the constellation, when there is nothing to read ----------------------------------------
// Not decoration. A clone with an empty memory/ would otherwise show a black screen, and nobody
// learns what the dashboard is from a black screen. The shape mirrors a real brain: a few hubs
// with many links and a long tail with one or two, which is what preferential attachment gives.
function constellation(cfg, count = 140) {
  // Deterministic per day, so a refresh is stable but tomorrow is a different sky.
  let seed = (Math.floor(Date.now() / 86400000) * 2654435761) % 2147483647;
  if (seed <= 0) seed += 2147483646;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];

  const HEAD = ['Nightly', 'Local', 'Draft', 'Shared', 'Private', 'Fast', 'Legacy', 'Live',
    'Quiet', 'Daily', 'Weekly', 'Frozen', 'Rolling', 'Hidden', 'Primary', 'Spare'];
  const MID = ['index', 'session', 'contact', 'budget', 'roadmap', 'client', 'deploy', 'recall',
    'token', 'schedule', 'report', 'ledger', 'route', 'preference', 'threshold', 'backup'];
  const TAIL = ['notes', 'rules', 'history', 'limits', 'owner', 'log', 'plan', 'source',
    'window', 'policy', 'defaults', 'trace'];

  const nodes = [];
  for (let i = 0; i < count; i++) {
    const reg = cfg.regions[Math.floor(rnd() * cfg.regions.length) % cfg.regions.length];
    nodes.push({
      slug: 'demo_' + i,
      name: [pick(HEAD), pick(MID), pick(TAIL)].join(' '),
      desc: 'An example memory. Write your first real one and this sky is replaced.',
      type: (reg.types || ['reference'])[0],
      region: reg.key,
      color: reg.color,
      facts: 6 + Math.floor(rnd() * 90),
      deg: 0,
    });
  }
  const edges = [];
  const pool = [0];
  for (let i = 1; i < nodes.length; i++) {
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const j = pool[Math.floor(rnd() * pool.length) % pool.length];
      if (j === i) continue;
      edges.push([nodes[i].slug, nodes[j].slug]);
      nodes[i].deg++;
      nodes[j].deg++;
      pool.push(i, j);
    }
  }
  return { nodes, edges, demo: true };
}

// ---- recall pulses, if the hook is writing them -----------------------------------------------
function pulses(since) {
  const f = join(BRAIN, '.recall-pulse.jsonl');
  if (!existsSync(f)) return [];
  let lines = [];
  try { lines = readFileSync(f, 'utf8').split(NL).filter(Boolean).slice(-400); } catch { return []; }
  const out = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (!e || !e.at || e.at <= since) continue;
      out.push({ at: e.at, host: e.host || '', hits: (e.slugs || []).map((s) => ({ name: s })) });
    } catch { /* a half-written line is not an error */ }
  }
  return out;
}

// ---- serving -----------------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

let cache = { graph: null, sig: '' };
function graph() {
  // Count plus the newest mtime is the whole signature: cheap, and it changes exactly when the
  // graph does.
  let newest = 0;
  let count = 0;
  if (existsSync(MEM)) {
    for (const f of readdirSync(MEM)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      count++;
      try { newest = Math.max(newest, statSync(join(MEM, f)).mtimeMs); } catch { /* raced */ }
    }
  }
  const sig = count + ':' + Math.round(newest);
  if (cache.graph && cache.sig === sig) return cache.graph;
  const cfg = config();
  const g = readBrain(cfg) || constellation(cfg);
  cache = { graph: { ...g, sig }, sig };
  return cache.graph;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/graph') {
    const g = graph();
    const cfg = config();
    return json(res, 200, {
      name: cfg.name,
      tagline: cfg.tagline,
      colors: cfg.colors,
      regions: cfg.regions.map((r) => ({ key: r.key, color: r.color })),
      links: cfg.links,
      showMachines: cfg.showMachines,
      demo: g.demo,
      sig: g.sig,
      counts: {
        memories: g.nodes.length,
        links: g.edges.length,
        facts: g.nodes.reduce((a, n) => a + n.facts, 0),
      },
      nodes: g.nodes,
      edges: g.edges,
      host: hostname(),
    });
  }

  if (p === '/api/pulse') {
    return json(res, 200, { events: pulses(Number(url.searchParams.get('since') || 0)) });
  }

  // Static, from dashboard/ only. Normalise, then check the RESOLVED path is still inside the
  // directory, or a ../ in the URL reads any file on the machine.
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = resolve(WEB, normalize(rel));
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    say('port ' + PORT + ' is already in use. Try: node tools/dashboard.mjs --port ' + (PORT + 1));
    process.exit(1);
  }
  say('dashboard server error: ' + (e && e.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const g = graph();
  const cfg = config();
  say('');
  say('  ' + cfg.name + ' dashboard on http://' + HOST + ':' + PORT);
  say('  ' + (g.demo
    ? g.nodes.length + ' demo nodes. Write a memory in memory/ and it becomes your own.'
    : g.nodes.length + ' memories, ' + g.edges.length + ' links.'));
  say('  customise: dashboard/config.json');
  say('');
  if (argv.includes('--open')) {
    const win = process.platform === 'win32';
    const cmd = win ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const url = 'http://' + HOST + ':' + PORT;
    const a = win ? ['/c', 'start', '', url] : [url];
    import('node:child_process').then(({ spawn }) => {
      spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    });
  }
});
