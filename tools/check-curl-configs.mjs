// Builds every curl config hooks/pre-turn.mjs builds, with connectTo SET, and asserts each
// directive lands on its own line.
//
// WHY THIS EXISTS. On 2026-09-15 four of five connect-to lines shipped with a literal "@@n"
// instead of a newline, so the generated config fused two directives onto one line, curl never
// saw a url, and recall silently fell back to keyword on every machine reached over the relay.
//
// The SERVER check passed anyway, and that is the real lesson: connectTo is empty on the host, so
// all four broken branches were skipped and the verification could not touch the changed code.
// A fix to a conditional branch has to be exercised with that condition true.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const src = readFileSync(resolve(BRAIN, "hooks/pre-turn.mjs"), "utf8")

// Fixture values only. What is asserted below is the SHAPE of each config line, never the
// address, so a real host has no business being written into a test.
const cfg = {
  url: "https://brain.example.ts.net:8443", token: "TOKEN", cacert: "C:/cert.pem",
  connectTo: "brain.example.ts.net:8443:203.0.113.10:8443", ct: 4,
}

const bodies = [...src.matchAll(/const conf =([\s\S]*?);\r?\n/g)].map((m) => m[1])
console.log("curl configs found:", bodies.length)

// A check that examined nothing must FAIL, not pass: feedback_a_scan_of_zero_files_is_not_clean.
const EXPECTED = 5
if (bodies.length !== EXPECTED) {
  console.log(`FAIL: expected ${EXPECTED} curl configs in pre-turn.mjs, found ${bodies.length}.`)
  console.log("If a config was added or removed on purpose, update EXPECTED here.")
  process.exit(1)
}

let bad = 0
bodies.forEach((expr, i) => {
  let out
  try {
    // Every free name a config body can reference. Missing one shows up as "x is not defined"
    // and would otherwise be miscounted as a malformed config rather than a gap in this stub.
    const names = ["cfg", "payload", "token", "prompt", "queries", "text", "texts", "body", "json"]
    const vals = [cfg, "{}", "TOKEN", "p", [], "t", ["t"], "{}", "{}"]
    out = Function(...names, '"use strict"; return (' + expr + ")")(...vals)
  } catch (e) {
    console.log(`  [${i}] FAIL, could not evaluate: ${e.message.slice(0, 80)}`); bad++; return
  }
  if (typeof out !== "string") { console.log(`  [${i}] FAIL, not a string`); bad++; return }

  const lines = out.split("\n").filter(Boolean)
  const ct = lines.filter((l) => l.startsWith("connect-to = "))
  const url = lines.filter((l) => l.startsWith("url = "))
  // The corruption signature: a literal backslash-n left inside any line.
  const literal = lines.some((l) => l.includes("\n") || l.includes("@@n"))
  const ok = ct.length === 1 && url.length === 1 && !literal
  if (!ok) {
    bad++
    console.log(`  [${i}] BROKEN  connect-to lines:${ct.length} url lines:${url.length} literal-escape:${literal}`)
    console.log("       " + lines.find((l) => l.includes("connect-to") || l.includes("url ="))?.slice(0, 140))
  } else {
    console.log(`  [${i}] ok`)
  }
})

console.log(bad
  ? `FAIL: ${bad} of ${bodies.length} configs malformed on the relay branch`
  : `PASS: all ${bodies.length} configs put every directive on its own line`)
process.exit(bad ? 1 : 0)
