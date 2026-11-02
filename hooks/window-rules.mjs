// Visible windows and timer-based watchers are refused (check-windows.mjs and the mod import this file).
// The owner, 2026-11-02, on two rules every agent has: "Every command runs hidden. Only a fork or branch he asked for
// opens a window" and "Events, not watchdogs: a failure reports itself. A timer only where no event exists, inside
// the check system". Until now both were only written rules.
//
// A Bash or PowerShell call is read, never run: its quoted text and here-documents are data, not commands, and the
// code of `powershell -Command`, `bash -c`, `cmd /c` and an encoded command is read as the commands it is. Two kinds
// of problem come back, { kind: 'window' | 'watchdog', what, fix }:
//   window    Start-Process without -WindowStyle Hidden or -NoNewWindow, cmd /c start, explorer of a folder, wt, mshta,
//             a .lnk, a desktop program (notepad and the like), a scheduled task whose action shows a window;
//   watchdog  a scheduled task that repeats (-RepetitionInterval, /SC MINUTE or HOURLY), a loop that never ends and
//             sleeps, setInterval in a script started detached. The check system (one register, one runner) is not
//             built yet, so a repeating task passes only with the marker CHECK_MARK <id> that the check system will own.
// Allowed by name: the launchers that open a fork or branch the owner asked for, and the restart scripts of an agent.
// Pure: no Node imports.

export const CHECK_MARK = 'havok-check-system:';
export const LAUNCHERS = ['open-fork-session.ps1', 'open-havok.ps1', 'restart-havok.ps1', 'run-agent.ps1', 'agent-launch.ps1', 'restart-agent.ps1', 'relaunch-rc.ps1'];

const MAX_DEPTH = 3;
const SHELLS = /^(Bash|PowerShell)$/;
const DESKTOP = new Set(['notepad', 'notepad++', 'mspaint', 'calc', 'wordpad', 'charmap', 'regedit', 'taskmgr', 'mmc', 'eventvwr', 'msinfo32', 'winver',
  'snippingtool', 'osk', 'magnify', 'mstsc', 'powershell_ise', 'winword', 'excel', 'powerpnt', 'outlook', 'mshta', 'wt']);
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'iexplore']);
const VEHICLES = new Set(['wt', 'start-process', 'saps', 'start', 'powershell', 'pwsh', 'cmd']);
const ALWAYS_WINDOW = new Set(['wt', 'mshta']);
// explorer.exe with a program (or a variable that holds one) starts that program, a trick to start it unelevated; only a folder opens a window.
const OPENS_PROGRAM = /\.(?:exe|bat|cmd|ps1|msi)\b|^\s*\$/i;
const SEPARATORS =/[;|&\n\r(){}<>]/;

const FIX_START = 'add -WindowStyle Hidden (or -NoNewWindow) to Start-Process; open a window only for a fork or branch the user asked for';
const FIX_APP = 'do not open it: read a file with the Read tool, run programs hidden, and open a window only for a fork or branch the user asked for';
const FIX_TASK = 'register the task with the action conhost.exe --headless <program> <script> for a long-running job, or wscript.exe with a run-hidden.vbs wrapper for a short one, or run it as SYSTEM';
const FIX_LOOP = 'make the thing that can fail report itself (an event, a push, the process exit) instead of looking at it in a loop';

const lower = (s) => String(s).toLowerCase();
const baseName = (p) => lower(String(p).replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop());
const noExe = (n) => n.replace(/\.(exe|cmd|bat|com)$/, '');

function readQuoted(text, i, lang) {
  const q = text[i];
  let v = '', j = i + 1;
  const n = text.length;
  if (q === "'") {
    for (; j < n; j++) {
      if (text[j] === "'") { if (lang === 'ps' && text[j + 1] === "'") { v += "'"; j++; continue; } break; }
      v += text[j];
    }
    return { value: v, end: j + 1 };
  }
  for (; j < n; j++) {
    const c = text[j];
    if (c === '"') { if (lang === 'ps' && text[j + 1] === '"') { v += '"'; j++; continue; } break; }
    if (lang === 'sh' && c === '\\' && /["\\$`]/.test(text[j + 1] || '')) { v += text[j + 1]; j++; continue; }
    if (lang === 'ps' && c === '`' && j + 1 < n) { v += /["`$]/.test(text[j + 1]) ? text[j + 1] : c + text[j + 1]; j++; continue; }
    v += c;
  }
  return { value: v, end: j + 1 };
}

// Statements of a piece of code: { raw, mask, skel, detached }. mask keeps every character but hides separators inside
// quotes; skel also blanks quoted text (a one-word quote such as 'Hidden' stays), so a flag is only seen where it is a
// flag of this command and not inside an argument meant for another one. Heredoc and here-string bodies are collected
// apart: they are data written somewhere, not commands run now.
function scan(text, lang) {
  const stmts = [], bodies = [], pending = [];
  let raw = '', mask = '', skel = '', flat = '';
  const put = (c, m = c, s = c) => { raw += c; mask += m; skel += s; flat += m; };
  const sep = (c) => { flat += c; };
  const flush = (detached) => { if (raw.trim()) stmts.push({ raw, mask, skel, detached: !!detached }); raw = ''; mask = ''; skel = ''; };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if ((c === '"' || (c === "'" && lang !== 'cmd'))) {
      const { value, end } = readQuoted(text, i, lang);
      const whole = text.slice(i, Math.min(end, n));
      const simple = /^[A-Za-z]{1,20}$/.test(value);
      for (let k = 0; k < whole.length; k++) {
        const ch = whole[k];
        const edge = k === 0 || k === whole.length - 1;
        put(ch, !edge && SEPARATORS.test(ch) ? '_' : ch, edge || simple ? ch : '_');
      }
      i = end;
      continue;
    }
    if (lang === 'ps' && c === '@' && (d === "'" || d === '"')) {
      const m = /^@(['"])[ \t]*\r?\n/.exec(text.slice(i));
      if (m) {
        const close = new RegExp('\\r?\\n' + m[1] + '@');
        const rest = text.slice(i + m[0].length);
        const e = close.exec(rest);
        bodies.push(e ? rest.slice(0, e.index) : rest);
        put('@' + m[1] + m[1] + '@');
        i += m[0].length + (e ? e.index + e[0].length : rest.length);
        continue;
      }
    }
    if (lang === 'sh' && c === '<' && d === '<' && text[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?(\w+))/.exec(text.slice(i));
      if (m) { pending.push({ tag: m[2] || m[3] || m[4], dash: !!m[1] }); put(m[0]); i += m[0].length; continue; }
    }
    if (c === '\\' && lang === 'sh' && (d === '\n' || d === '\r')) { i += d === '\r' && text[i + 2] === '\n' ? 3 : 2; put(' '); continue; }
    if (c === '`' && lang === 'ps' && (d === '\n' || d === '\r')) { i += d === '\r' && text[i + 2] === '\n' ? 3 : 2; put(' '); continue; }
    if (c === '\\' && lang === 'sh' && d !== undefined && /["'\\ ;&|]/.test(d)) { put(c + d, '__', '__'); i += 2; continue; }
    if (c === '#' && lang !== 'cmd' && (raw === '' || /\s/.test(raw[raw.length - 1]))) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      flush(false);
      sep('\n');
      i++;
      if (c === '\n' || (c === '\r' && d !== '\n')) {
        while (pending.length) {
          const p = pending.shift();
          const lines = [];
          for (;;) {
            if (i >= n) break;
            let e = text.indexOf('\n', i);
            if (e < 0) e = n;
            const line = text.slice(i, e).replace(/\r$/, '');
            i = Math.min(e + 1, n);
            if ((p.dash ? line.replace(/^\t+/, '') : line) === p.tag) break;
            lines.push(line);
          }
          bodies.push(lines.join('\n'));
        }
      }
      continue;
    }
    if (c === ';' && lang !== 'cmd') { flush(false); sep(';'); i++; continue; }
    if (c === '{' || c === '}') { flush(false); sep(c); i++; continue; }
    if (c === '|') { flush(false); sep('|'); i += d === '|' ? 2 : 1; continue; }
    if (c === '&') {
      if (d === '&') { flush(false); sep('&'); i += 2; continue; }
      if (lang === 'cmd') { flush(false); sep('&'); i++; continue; }
      if (lang === 'sh' && !/[<>]/.test(raw[raw.length - 1] || '') && d !== '>') { flush(true); sep('&'); i++; continue; }
    }
    put(c);
    i++;
  }
  flush(false);
  return { stmts, bodies, flat };
}

// The command word of a statement, after the call operator, an assignment, an env prefix, nohup and the like.
function headOf(st, lang) {
  let s = st.mask, off = 0, called = false, assigned = false;
  const strip = (re) => { const m = re.exec(s); if (!m || !m[0]) return false; s = s.slice(m[0].length); off += m[0].length; return true; };
  strip(/^\s+/);
  for (let guard = 0; guard < 12; guard++) {
    if (strip(/^[$@]?\(+\s*/)) continue;
    if (strip(/^(?:&\s*(?=\S)|\.\s+(?=\S))\s*/)) { called = true; continue; }
    if (lang === 'ps' && strip(/^\$[\w:.{}[\]]+\s*[-+*/]?=\s*/)) { assigned = true; continue; }
    if (lang === 'sh' && strip(/^\w+=(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$)/)) { assigned = true; continue; }
    if (lang === 'sh' && strip(/^(?:nohup|exec|time|command|setsid|sudo|builtin|env)\s+/)) continue;
    if (lang === 'cmd' && strip(/^(?:call|@)\s*/i)) continue;
    break;
  }
  const m = /^(["']?)([^\s"'|;]+)\1/.exec(s);
  // A bare quoted string or value in PowerShell (also after an assignment) is data, not a command.
  const literal = lang === 'ps' && !called && /^["'$\d]/.test(s);
  if (!m || (assigned && !s.trim()) || literal) return { name: '', base: '', at: off + (m ? m[0].length : 0) };
  const full = m[2];
  return { name: full, base: noExe(baseName(full)), at: off + m[0].length };
}

function nestedCode(st, h, lang) {
  const rest = st.skel.slice(h.at);
  const take = (idx, outer, inner) => {
    const from = h.at + idx;
    let j = from;
    while (j < st.raw.length && /\s/.test(st.raw[j])) j++;
    if (st.raw[j] === '"' || (st.raw[j] === "'" && outer !== 'cmd')) return { code: readQuoted(st.raw, j, outer).value, lang: inner };
    return { code: st.raw.slice(j), lang: inner };
  };
  if (h.base === 'powershell' || h.base === 'pwsh') {
    const enc = /\s-(?:e|ec|en|enc|enco\w*)\s+([A-Za-z0-9+/=]{8,})/i.exec(rest);
    if (enc && typeof atob === 'function') {
      try {
        const bin = atob(enc[1]);
        let out = '';
        for (let k = 0; k + 1 < bin.length; k += 2) out += String.fromCharCode(bin.charCodeAt(k) | (bin.charCodeAt(k + 1) << 8));
        return { code: out, lang: 'ps' };
      } catch { /* not base64 */ }
    }
    const m = /\s-(?:c|command)\b\s*/i.exec(rest);
    return m ? take(m.index + m[0].length, lang, 'ps') : null;
  }
  if (h.base === 'bash' || h.base === 'sh' || h.base === 'zsh') {
    const m = /\s-\w*c\b\s*/.exec(rest);
    return m ? take(m.index + m[0].length, lang, 'sh') : null;
  }
  if (h.base === 'cmd') {
    const m = /\s\/[ck]\b\s*/i.exec(rest);
    return m ? take(m.index + m[0].length, lang, 'cmd') : null;
  }
  return null;
}

// An agent restarting itself writes its own restart-<name>.ps1 (restart-<agent>.ps1), so any such name counts.
const RESTART_SCRIPT = /\brestart-[\w.-]*\.ps1\b/i;
const launcherIn = (raw) => LAUNCHERS.some((l) => lower(raw).includes(l)) || RESTART_SCRIPT.test(raw);

function startProcessTarget(st, h) {
  const rest = st.mask.slice(h.at);
  const named = /(?:^|\s)-(?:FilePath|Path)\s+(?:\\?["'])?([^\s"']+)/i.exec(rest);
  if (named) return named[1];
  const first = /^\s*(?:\\?["'])?([^\s"'-][^\s"']*)/.exec(rest);
  return first ? first[1] : '';
}

function statementProblems(st, lang, run) {
  const out = [];
  const h = headOf(st, lang);
  const b = h.base;
  const rest = st.skel.slice(h.at);
  const restRaw = st.raw.slice(h.at);
  const launcher = launcherIn(st.raw) && (VEHICLES.has(b) || LAUNCHERS.some((l) => b === noExe(l) || baseName(h.name) === l));
  const where = st.raw.trim().replace(/\s+/g, ' ').slice(0, 90);
  const add = (what, fix) => { if (!launcher) out.push({ kind: 'window', what, fix, where }); };
  const isStartProcess = b === 'start-process' || b === 'saps' || (b === 'start' && lang !== 'sh');

  if (isStartProcess && lang !== 'cmd') {
    const target = baseName(startProcessTarget(st, h));
    const tname = noExe(target);
    const hidden = /(?:^|\s)-(?:NoNew\w*|nnw)\b/i.test(rest) || /(?:^|\s)-wi\w*[:\s]+['"]?hidden\b/i.test(rest);
    const variable = /(?:^|\s)-wi\w*[:\s]+\$/i.test(rest);
    if (tname === 'wt' || tname === 'mshta') add(tname + ' opens a window that -WindowStyle Hidden does not hide', FIX_APP);
    else if (target.endsWith('.lnk')) add('a .lnk shortcut launch', FIX_APP);
    else if (tname === 'explorer') {
      const at = restRaw.indexOf(target);
      if (!OPENS_PROGRAM.test(restRaw.slice(at < 0 ? 0 : at + target.length))) add('explorer.exe of a folder', FIX_APP);
    }
    else if (!hidden && !variable) add('Start-Process without -WindowStyle Hidden or -NoNewWindow', FIX_START);
    return out;
  }
  if (lang === 'cmd' && b === 'start') {
    if (!/(?:^|\s)\/b\b/i.test(rest)) add('start opens a new window (only start /b does not)', 'use start /b, or run the program directly; for a fork or branch use tools/open-fork-session.ps1');
    return out;
  }
  if (b === 'explorer') {
    if (!OPENS_PROGRAM.test(restRaw)) add('explorer.exe of a folder', FIX_APP);
    return out;
  }
  if (h.name && /\.lnk["']?$/i.test(h.name)) { add('a .lnk shortcut launch', FIX_APP); return out; }
  if (b === 'invoke-item' || b === 'ii') { add('Invoke-Item opens the file in its program', FIX_APP); return out; }
  if (DESKTOP.has(b)) { add(b + ' opens a window', FIX_APP); return out; }
  if (BROWSERS.has(b) && !/(?:^|\s)--(?:headless|version)\b/.test(rest)) { add(b + ' opens a browser window (only --headless does not)', FIX_APP); return out; }
  if (b === 'out-gridview' || b === 'show-command') { add(b + ' opens a window', FIX_APP); return out; }
  if (lang === 'ps' && /\bMessageBox\]::Show\b/i.test(st.skel)) add('a message box', FIX_APP);
  void run;
  return out;
}

function matchingEnd(flat, from, lang) {
  if (lang === 'ps') {
    let depth = 1;
    for (let k = from; k < flat.length; k++) {
      if (flat[k] === '{') depth++;
      else if (flat[k] === '}' && --depth === 0) return k;
    }
    return flat.length;
  }
  let depth = 1;
  const re = /\b(do|done)\b/g;
  re.lastIndex = from;
  for (let m; (m = re.exec(flat));) {
    if (m[1] === 'do') depth++;
    else if (--depth === 0) return m.index;
  }
  return flat.length;
}

const LOOP_HEADS = [
  { lang: 'ps', re: /\bwhile\s*\(\s*(?:\$true|1|!\s*\$false)\s*\)\s*\{/gi },
  { lang: 'ps', re: /\bfor\s*\(\s*;\s*;\s*\)\s*\{/gi },
  { lang: 'sh', re: /\b(?:while\s+(?:true|:|\[\s*1\s*\]|\(\(\s*1\s*\)\))|until\s+false)\s*[;\n]\s*do\b/g },
  { lang: 'sh', re: /\bfor\s*\(\(\s*;\s*;\s*\)\)\s*[;\n]?\s*do\b/g },
];

function loopProblems(flat, lang, raw) {
  if (/\btimeout(?:\.exe)?\s+\d/i.test(raw)) return [];
  const out = [];
  for (const head of LOOP_HEADS) {
    if (head.lang !== lang) continue;
    head.re.lastIndex = 0;
    for (let m; (m = head.re.exec(flat));) {
      const body = flat.slice(m.index + m[0].length, matchingEnd(flat, m.index + m[0].length, lang));
      const sleeps = lang === 'ps' ? /\b(?:Start-Sleep|sleep|Wait-Event)\b/i.test(body) : /\bsleep\b/.test(body);
      const leaves = /\b(?:break|exit|return|throw)\b/i.test(body);
      if (sleeps && !leaves) out.push({ kind: 'watchdog', what: 'a loop that never ends and sleeps between looks', fix: FIX_LOOP });
    }
  }
  return out;
}

function intervalProblems(levels, input) {
  const detachedRun = !!input.run_in_background;
  const nohup = (st) => /(?:^|\s)(?:nohup|setsid|disown)\b|\bStart-Job\b/i.test(st.skel);
  const nodeStatements = levels.flatMap((l) => l.s.stmts).filter((st) => /^node(?:js)?$/.test(headOf(st, st.lang || 'sh').base));
  const out = [];
  for (const st of nodeStatements) {
    const inline = /(?:^|\s)(?:-e|--eval|-p)\b/.test(st.skel) && /\bsetInterval\s*\(/.test(st.raw);
    if (inline && (st.detached || nohup(st) || detachedRun)) out.push({ kind: 'watchdog', what: 'setInterval in node code started detached', fix: FIX_LOOP });
  }
  const bodies = levels.flatMap((l) => l.s.bodies).filter((b) => /\bsetInterval\s*\(/.test(b));
  if (bodies.length) {
    const all = levels.flatMap((l) => l.s.stmts.map((st) => ({ st, lang: l.lang })));
    const remote = all.some(({ st, lang }) => /^(?:ssh|scp|adb|sftp)$/.test(headOf(st, lang).base));
    const started = all.some(({ st, lang }) => {
      const h = headOf(st, lang);
      if (/^node(?:js)?$/.test(h.base)) return st.detached || nohup(st) || detachedRun;
      return (h.base === 'start-process' || h.base === 'saps' || h.base === 'start-job') && /\bnode\b/i.test(st.raw);
    });
    if (!remote && started) out.push({ kind: 'watchdog', what: 'a script with setInterval started detached', fix: FIX_LOOP });
  }
  return out;
}

const SYSTEM_PRINCIPAL = /(?:-UserId|-User)\s+[\\'"]*(?:NT AUTHORITY\\+)?(?:SYSTEM|LOCAL SERVICE|NETWORK SERVICE)\b|-LogonType\s+(?:S4U|Password|ServiceAccount)\b|\/RU\s+[\\'"]*(?:NT AUTHORITY\\+)?SYSTEM\b/i;

function taskExecutables(full) {
  const found = [];
  for (const m of full.matchAll(/-Execute\s*[:=]?\s*(?:\\?(["'])(.*?)\\?\1|([^"'\s]+))/gi)) found.push({ exe: m[2] || m[3], line: full.slice(m.index, m.index + 400) });
  for (const m of full.matchAll(/\/TR\s+((?:\\?["'])?[^\n]*)/gi)) {
    const val = m[1].replace(/^\\?["']/, '');
    const e = /^(\S+)/.exec(val);
    if (e) found.push({ exe: e[1].replace(/["'\\]+$/, ''), line: val });
  }
  return found;
}

function taskProblems(levels, full) {
  const names = new Set(levels.flatMap((l) => l.s.stmts.map((st) => headOf(st, l.lang).base)));
  const schtasks = levels.flatMap((l) => l.s.stmts.filter((st) => headOf(st, l.lang).base === 'schtasks' && /\/(?:create|change)\b/i.test(st.skel)));
  const register = names.has('register-scheduledtask') || names.has('new-scheduledtask') || schtasks.length > 0
    || (names.has('set-scheduledtask') && /-Action\b/i.test(full));
  const trigger = names.has('new-scheduledtasktrigger');
  if (!register && !trigger) return [];
  const out = [];
  if (register && !launcherIn(full) && !/-Xml\b|\/XML\b/i.test(full) && !SYSTEM_PRINCIPAL.test(full)) {
    const bad = taskExecutables(full).find(({ exe }) => {
      const b = baseName(exe);
      if (b === 'wscript' || b === 'wscript.exe') return false;
      if (b === 'conhost' || b === 'conhost.exe') return !/--headless/.test(full);
      return true;
    });
    if (bad) out.push({ kind: 'window', what: 'a scheduled task whose action (' + baseName(bad.exe) + ') shows a console window; -Hidden in the settings only hides the task from the list', fix: FIX_TASK });
  }
  const repeats = /-RepetitionInterval\b|\.Repetition\.Interval\b|\/SC\s+(?:MINUTE|HOURLY)\b|\/RI\s+\d/i.test(full);
  const marked = new RegExp(CHECK_MARK + '[ \\t]*[\\w.-]{3,}', 'i').test(full);
  if (repeats && !marked) out.push({ kind: 'watchdog', what: 'a scheduled task that repeats on a timer', fix: 'unused' });
  return out;
}

// The problems of one Bash or PowerShell call; an empty list means the call may run.
export function windowProblems(tool, input) {
  if (!SHELLS.test(String(tool || ''))) return [];
  const full = input && typeof input.command === 'string' ? input.command : '';
  if (!full.trim()) return [];
  const levels = [];
  const problems = [];
  const walk = (code, lang, depth) => {
    const s = scan(code, lang);
    levels.push({ s, lang, code });
    for (const st of s.stmts) {
      st.lang = lang;
      problems.push(...statementProblems(st, lang, input));
      const nested = depth < MAX_DEPTH ? nestedCode(st, headOf(st, lang), lang) : null;
      if (nested && nested.code.trim()) walk(nested.code, nested.lang, depth + 1);
    }
    if (lang !== 'cmd') problems.push(...loopProblems(s.flat, lang, code));
  };
  walk(full, tool === 'PowerShell' ? 'ps' : 'sh', 0);
  problems.push(...intervalProblems(levels, input || {}));
  problems.push(...taskProblems(levels, full));
  const seen = new Set();
  return problems.filter((p) => { const k = p.kind + '|' + p.what; if (seen.has(k)) return false; seen.add(k); return true; });
}

// The refusal: what was found, why it is a rule, and what to do instead, in plain lines.
export function windowDenyReason(problems) {
  const win = problems.filter((p) => p.kind === 'window');
  const dog = problems.filter((p) => p.kind === 'watchdog');
  const lines = [];
  if (win.length) {
    lines.push('Blocked: this command would open a visible window (' + win.map((p) => p.what).join('; ') + '). Every command runs hidden; only a fork or branch the user asked for opens a window.');
    lines.push('Instead: ' + [...new Set(win.map((p) => p.fix))].join('; or ') + '.');
  }
  if (dog.length) {
    lines.push('Blocked: this would start a timer-based watcher (' + dog.map((p) => p.what).join('; ') + '). Rule: events, not watchdogs: a failure reports itself, and a timer is allowed only where no event exists.');
    const loops = dog.filter((p) => p.fix !== 'unused');
    if (loops.length) lines.push('Instead: ' + [...new Set(loops.map((p) => p.fix))].join('; or ') + '.');
    lines.push('Use an event: the process exit, service recovery, a Task Scheduler event trigger (logon, boot, crash event 1000 or 1002, network connected), or a push. If no event exists, say why in the command and add the marker "' + CHECK_MARK + ' <check-id>" (for example in a comment).');
  }
  return lines.join('\n');
}
