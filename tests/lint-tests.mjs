#!/usr/bin/env node
// lint-tests.mjs : behavioural tests for scripts/gate-lint.mjs.
// Zero dependencies, cross-platform.
//
//   node tests/lint-tests.mjs            run all
//   node tests/lint-tests.mjs regex      run tests whose name contains "regex"
//
// Prints "N/N passed" on success, which is the string CI matches on.

import {
  linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { automaticEvidencePrefix, gateDefinitionDigest, parseGates } from "../scripts/lib/gates.mjs";
import { fileDigest } from "../scripts/lib/approval.mjs";
import { requireFifo, runSuite, skip } from "./lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT = join(HERE, "..", "scripts", "gate-lint.mjs");
const filter = process.argv[2] || "";
const DIR = mkdtempSync(join(tmpdir(), "unlazy-lint-test-"));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function write(name, body) {
  const path = join(DIR, name);
  writeFileSync(path, body);
  return path;
}

function lint(...args) {
  const result = spawnSync(process.execPath, [LINT, ...args], { encoding: "utf8" });
  return { out: result.stdout + result.stderr, code: result.status };
}

// Program-authored line breaks and indentation are allowed. Repository or argv
// data must not be able to emit terminal controls or Unicode bidi controls.
const RAW_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const RAW_DATA_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
function assertTerminalSafe(output) {
  assert.doesNotMatch(output, RAW_TERMINAL_CONTROL);
}
function assertDataSafe(value) {
  assert.doesNotMatch(value, RAW_DATA_CONTROL);
}

// ------------------------------------------------------------- fixtures

// Every defect below passes gate-check and the Stop hook today.
const WEAK = write("weak.md", `# Gates: weak ledger

Scope: a ledger that satisfies every enforcement layer and proves nothing

- [ ] G1: the entire feature works perfectly
  CHECK: echo ok
  EXPECT: ok
  EVIDENCE: pending

- [ ] G2: improve the error handling
  CHECK: node scripts/verify.mjs --banner DONE
  EXPECT: DONE
  EVIDENCE: pending

- [ ] G3: renders 34 stat rows
  EVIDENCE: pending

- [ ] G4: config path is reported
  CHECK: node scripts/show-path.mjs
  EXPECT: /etc/app/conf/
  EVIDENCE: pending
`);

const SOUND_BODY = `# Gates: sound ledger

Scope: pricing section renders and behaves

- [ ] G1: three tiers render with real copy
  CHECK: node scripts/check.mjs pricing --tiers
  EXPECT: 3/3 tiers rendered
  EVIDENCE: pending

- [ ] G2: annual toggle changes price and label
  CHECK: node scripts/check.mjs pricing --toggle
  EXPECT: toggle switched both fields
  EVIDENCE: pending

- [ ] G3: typecheck is clean
  CHECK: npx tsc --noEmit
  EXPECT: /Found 0 errors/
  EVIDENCE: pending

- [ ] G4: unit suite green
  CHECK: node --test test/pricing.test.mjs
  EXPECT: /# fail 0/
  EVIDENCE: pending

- [ ] G5: no console errors on load
  CHECK: node scripts/check.mjs pricing --console
  EXPECT: 0 console errors
  EVIDENCE: pending
`;

const SOUND = write("sound.md", SOUND_BODY);
const MANUAL = write("manual.md", SOUND_BODY + `
- [ ] G6: copy reads as written by the brand, not by a model
  EVIDENCE: pending
`);
const TAINT = "\u001b\u0007\u0085\u202e";
const LINE_SEPARATORS = "\u2028\u2029";
const TAINTED = write("unsafe-" + LINE_SEPARATORS + "\u202e.md", `# Gates: unsafe terminal data

- [ ] G1: improve ${TAINT} terminal rendering
  EVIDENCE: pending
`);

// ------------------------------------------------------------- tests

test("lint: a fixed-output command is advisory by default", () => {
  const { out, code } = lint(WEAK);
  assert.match(out, /G1: CHECK looks like a fixed-output command/);
  assert.equal(code, 0);
});

test("lint: a chained verifier is not classified as a tautology", () => {
  const chained = write("chained.md", `# Gates: chained

- [ ] G1: verifier succeeds
  CHECK: echo starting && node scripts/verify.mjs
  EXPECT: VERIFY_OK
  EVIDENCE: pending
`);
  assert.doesNotMatch(lint(chained).out, /tautological-check|fixed-output command/);
});

test("lint: EXPECT passed as an argument is not guaranteed output", () => {
  const argument = write("argument.md", `# Gates: argument

- [ ] G1: verifier succeeds
  CHECK: node scripts/verify.mjs --expected VERIFY_OK
  EXPECT: VERIFY_OK
  EVIDENCE: pending
`);
  assert.doesNotMatch(lint(argument).out, /\[echoes-expect\]|\[masked-exit\]/);
});

test("lint: an expectation shared with failure output is warned", () => {
  assert.match(lint(WEAK).out, /G1:.*also appears in failure output/);
});

test("lint: an activity title is warned", () => {
  assert.match(lint(WEAK).out, /G2:.*names an activity, not an outcome/);
});

test("lint: an unmeasured number in a manual gate is warned", () => {
  assert.match(lint(WEAK).out, /G3:.*states a number that nothing measures/);
});

test("lint: a literal path read as a regex is warned", () => {
  assert.match(lint(WEAK).out, /G4:.*looks like a literal path/);
});

test("lint: a deliberate slash wrapped pattern is not warned", () => {
  assert.doesNotMatch(lint(SOUND).out, /looks like a literal path/);
});

test("lint: shipped leaf and node templates satisfy the documented size policy", () => {
  for (const name of ["gates-leaf.md", "gates-node.md"]) {
    const result = lint(join(HERE, "..", "templates", name));
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /ERROR/);
  }
});

test("lint: a sound ledger is clean and exits 0", () => {
  const { out, code } = lint(SOUND);
  assert.match(out, /^LINT OK$/m);
  assert.equal(code, 0);
});

test("lint: a symlink ledger is refused without changing its victim", () => {
  if (process.platform === "win32") skip("POSIX only");
  const victim = write("symlink-victim.md", SOUND_BODY);
  const before = readFileSync(victim, "utf8");
  const alias = join(DIR, "symlink-ledger.md");
  symlinkSync(victim, alias);
  const { out, code } = lint(alias);
  assert.equal(code, 2, out);
  assert.match(out, /gate ledger must be one unchanged regular single-link file/);
  assert.equal(readFileSync(victim, "utf8"), before);
});

test("lint: a hard-linked ledger is refused without changing its victim", () => {
  const victim = write("hardlink-victim.md", SOUND_BODY);
  const before = readFileSync(victim, "utf8");
  const alias = join(DIR, "hardlink-ledger.md");
  linkSync(victim, alias);
  const { out, code } = lint(alias);
  assert.equal(code, 2, out);
  assert.match(out, /gate ledger must be one unchanged regular single-link file/);
  assert.equal(readFileSync(victim, "utf8"), before);
});

test("lint: a FIFO ledger is refused promptly instead of blocking", () => {
  requireFifo();
  const fifo = join(DIR, "ledger.fifo");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const started = Date.now();
  const result = spawnSync(process.execPath, [LINT, fifo], {
    encoding: "utf8",
    timeout: 2000,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /gate ledger must be one unchanged regular single-link file/);
  assert.ok(elapsed < 1000, "FIFO refusal took " + elapsed + "ms");
});

test("lint: a gate ledger over 8 MiB is refused before parsing", () => {
  const oversized = write("oversized.md", "x".repeat(8 * 1024 * 1024 + 1));
  const { out, code } = lint(oversized);
  assert.equal(code, 2, out);
  assert.match(out, /gate ledger exceeds 8388608 bytes/);
});

test("lint: default warnings and strict warnings have distinct gate markers and exits", () => {
  const normal = lint(MANUAL);
  assert.match(normal.out, /G6:.*judged by hand/);
  assert.match(normal.out, /^LINT OK \(\d+ warning\(s\)\)$/m);
  assert.equal(normal.code, 0);
  const strict = lint("--strict", MANUAL);
  assert.equal(strict.code, 1);
  assert.match(strict.out, /^LINT FINDINGS:/m);
  assert.doesNotMatch(strict.out, /^LINT OK/m);
});

test("lint: json reports counts and stays parseable", () => {
  const data = JSON.parse(lint("--json", WEAK).out);
  assert.equal(data.ok, true);
  assert.equal(data.errors, 0);
  assert.ok(data.warnings >= 1, "expected warnings, got " + data.warnings);
  assert.ok(data.findings.every((f) => f.rule && f.level));
  const strict = JSON.parse(lint("--strict", "--json", WEAK).out);
  assert.equal(strict.ok, false);
});

test("lint: default output escapes terminal and bidi controls in finding data", () => {
  const { out, code } = lint(TAINTED);
  // Control characters inside ledger text are parse errors (exit 2): the
  // diagnostic names the code point and the file name renders escaped.
  assert.equal(code, 2, out);
  assertTerminalSafe(out);
  assert.match(out, /U\+001B/);
  assert.match(out, /unsafe-\\u2028\\u2029\\u202e\.md/);
  assert.match(out, /^LINT FINDINGS:/m);
});

test("lint: JSON escapes terminal data while retaining pretty parseable output", () => {
  const { out, code } = lint("--json", TAINTED);
  assert.equal(code, 2, out);
  assertTerminalSafe(out);
  assert.match(out, /^\{\n  "ok": false,/);
  const data = JSON.parse(out);
  assert.ok(data.findings.length > 0);
  assert.ok(data.findings.every((finding) => {
    assertDataSafe(finding.file);
    assertDataSafe(finding.gate || "");
    assertDataSafe(finding.rule);
    assertDataSafe(finding.message);
    return true;
  }));
  assert.ok(data.findings.some((finding) => finding.file.includes("\\u2028\\u2029\\u202e")));
  assert.ok(data.findings.some((finding) => finding.message.includes("U+001B")));
});

test("CLI: unknown-option diagnostics escape terminal and bidi controls", () => {
  const { out, code } = lint("--unsafe-" + TAINT + LINE_SEPARATORS);
  assert.equal(code, 2, out);
  assertTerminalSafe(out);
  assert.match(out, /unknown option --unsafe-\\x1b\\x07\\x85\\u202e\\u2028\\u2029/);
});

test("lint: hostile field expansion stays bounded in text and JSON", () => {
  const large = write("large-controls.md", [
    "# Gates: bounded output",
    "",
    "- [ ] G1: improve " + "x".repeat(1024 * 1024) + " terminal output",
    "  EVIDENCE: pending",
    "",
  ].join("\n"));
  const textResult = lint(large);
  assert.equal(textResult.code, 0, textResult.out.slice(0, 2000));
  assert.ok(Buffer.byteLength(textResult.out, "utf8") < 16 * 1024,
    "text output was not bounded: " + Buffer.byteLength(textResult.out, "utf8"));
  assert.match(textResult.out, /\.\.\.\[truncated\]/);
  assertTerminalSafe(textResult.out);

  const jsonResult = lint("--json", large);
  assert.equal(jsonResult.code, 0, jsonResult.out.slice(0, 2000));
  assert.ok(Buffer.byteLength(jsonResult.out, "utf8") < 32 * 1024,
    "JSON output was not bounded: " + Buffer.byteLength(jsonResult.out, "utf8"));
  const data = JSON.parse(jsonResult.out);
  assert.ok(data.findings.some((finding) => finding.message.includes("...[truncated]")));
  assertTerminalSafe(jsonResult.out);
});

test("lint: finding count is capped without hiding totals or failure state", () => {
  const gates = [];
  for (let index = 1; index <= 80; index++) {
    gates.push("- [ ] G" + index + ": improve item " + index + "\n  EVIDENCE: pending");
  }
  const crowded = write("crowded.md", "# Gates: crowded\n\n" + gates.join("\n\n") + "\n");
  const textResult = lint(crowded);
  assert.equal(textResult.code, 0, textResult.out);
  assert.match(textResult.out, /report truncated: 177 finding\(s\) omitted/);
  assert.match(textResult.out, /LINT OK \(241 warning\(s\)\)/);
  assert.ok(Buffer.byteLength(textResult.out, "utf8") < 256 * 1024);

  const jsonResult = lint("--strict", "--json", crowded);
  assert.equal(jsonResult.code, 1, jsonResult.out);
  assert.ok(Buffer.byteLength(jsonResult.out, "utf8") < 256 * 1024);
  const data = JSON.parse(jsonResult.out);
  assert.equal(data.ok, false);
  assert.equal(data.warnings, 241);
  assert.equal(data.findings.length, 64);
  assert.equal(data.truncated, true);
  assert.equal(data.omittedFindings, 177);
});

test("CLI: help retains trusted multiline formatting", () => {
  const { out, code } = lint("--help");
  assert.equal(code, 0, out);
  assert.match(out, /^usage: gate-lint\.mjs/m);
  assert.ok(out.split(/\r?\n/).length > 4, out);
  assert.doesNotMatch(out, /\\x0a/);
});

test("lint: a ledger the shared parser rejects exits 2, not 1", () => {
  const broken = write("broken.md", "# Gates: broken\n\n- [ ] no explicit id here\n");
  assert.equal(lint(broken).code, 2);
});

test("lint: multiple ledgers in one run are all honored", () => {
  const { out } = lint(SOUND, WEAK);
  assert.match(out, /weak\.md/);
  assert.match(out, /G1: CHECK looks like a fixed-output command/);
});

test("lint: path ambiguity is sourced once from the shared parser", () => {
  const result = lint(WEAK);
  assert.equal((result.out.match(/\[path-read-as-regex\]/g) || []).length, 1, result.out);
});

test("lint: an unknown option exits 2", () => {
  assert.equal(lint("--nope", SOUND).code, 2);
});

test("CLI: an unknown short option exits 2", () => {
  assert.equal(lint("-x", SOUND).code, 2);
});

test("CLI: the positional marker permits literal files named --help and -h", () => {
  write("--help", SOUND_BODY);
  write("-h", SOUND_BODY);
  for (const filename of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [LINT, "--", filename], { cwd: DIR, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^LINT OK$/m);
    assert.doesNotMatch(result.stdout, /^usage:/m);
  }
});

test("lint: no arguments exits 2", () => {
  assert.equal(lint().code, 2);
});

// ------------------------------------------------------- rule coverage

const ledger = (name, gates) => write(name, "# Gates: " + name + "\n\n" + gates.join("\n\n") + "\n");
const ruleCount = (file, name) => (lint(file).out.match(new RegExp("\\[" + name + "\\]", "g")) || []).length;

test("lint: masked exits are warned and honest chains are not", () => {
  const masked = ledger("masked.md", [
    "- [ ] G1: suite passes\n  CHECK: npm test || true\n  EXPECT: tests passed\n  EVIDENCE: pending",
    "- [ ] G2: build succeeds\n  CHECK: node build.mjs; exit 0\n  EXPECT: build finished\n  EVIDENCE: pending",
    "- [ ] G3: verifier passes\n  CHECK: node verify.mjs || echo verifier passed\n  EXPECT: verifier passed\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(masked, "masked-exit"), 3);
  const honest = ledger("honest.md", [
    "- [ ] G1: suite passes\n  CHECK: npm test && node report.mjs\n  EXPECT: tests passed\n  EVIDENCE: pending",
    "- [ ] G2: logs are verified\n  CHECK: node check-true.mjs --mode=strict\n  EXPECT: logs verified\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(honest, "masked-exit"), 0);
});

test("lint: an EXPECT echoed after ; is warned while && and argv are not", () => {
  const echoed = ledger("echoed.md", [
    "- [ ] G1: verifier passes\n  CHECK: node verify.mjs; echo VERIFY_OK\n  EXPECT: VERIFY_OK\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(echoed, "echoes-expect"), 1);
  const guarded = ledger("guarded.md", [
    "- [ ] G1: verifier passes\n  CHECK: node verify.mjs && echo VERIFY_OK\n  EXPECT: VERIFY_OK\n  EVIDENCE: pending",
    "- [ ] G2: verifier passes with argument\n  CHECK: node scripts/verify.mjs --expected VERIFY_OK\n  EXPECT: VERIFY_OK\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(guarded, "echoes-expect"), 0);
});

test("lint: a CHECK reading its own ledger is warned while the lint self-gate is not", () => {
  const own = ledger("own.md", [
    "- [ ] G1: every gate is checked\n  CHECK: node count-checked.mjs own.md\n  EXPECT: all gates checked\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(own, "reads-own-ledger"), 1);
  const selfGate = ledger("self.md", [
    "- [ ] G1: this ledger states outcomes that can fail\n  CHECK: node ../scripts/gate-lint.mjs --strict self.md\n  EXPECT: /^LINT OK$/m\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(selfGate, "reads-own-ledger"), 0);
});

test("lint: short and match-anything expectations are warned while decisive ones are not", () => {
  const vague = ledger("vague.md", [
    "- [ ] G1: build id is printed\n  CHECK: node build.mjs\n  EXPECT: A1\n  EVIDENCE: pending",
    "- [ ] G2: any letters appear\n  CHECK: node build.mjs\n  EXPECT: /[a-z]+/i\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(vague, "short-expect"), 1);
  assert.equal(ruleCount(vague, "match-anything"), 1);
  const decisive = ledger("decisive.md", [
    "- [ ] G1: build id is printed\n  CHECK: node build.mjs\n  EXPECT: BUILD_OK_7\n  EVIDENCE: pending",
    "- [ ] G2: lint marker appears\n  CHECK: node lint.mjs\n  EXPECT: /^LINT OK$/m\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(decisive, "short-expect") + ruleCount(decisive, "match-anything"), 0);
});

test("lint: literal prints behind true, cmd, or node -e are tautologies while real checks are not", () => {
  const literal = ledger("literal.md", [
    "- [ ] G1: service is healthy\n  CHECK: true && echo healthy\n  EXPECT: healthy\n  EVIDENCE: pending",
    "- [ ] G2: endpoints respond\n  CHECK: cmd /c echo 12 endpoints responded\n  EXPECT: 12 endpoints responded\n  EVIDENCE: pending",
    "- [ ] G3: stat rows render\n  CHECK: node -e \"console.log('34 rows')\"\n  EXPECT: 34 rows\n  EVIDENCE: pending",
    "- [ ] G4: e2e suite is green\n  CHECK: node -e \"process.stdout.write('e2e green')\"\n  EXPECT: e2e green\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(literal, "tautological-check"), 4);
  const real = ledger("real-node.md", [
    "- [ ] G1: marker file is read\n  CHECK: node -e \"console.log(require('fs').readFileSync('marker.txt','utf8'))\"\n  EXPECT: marker present\n  EVIDENCE: pending",
    "- [ ] G2: suite passes\n  CHECK: true && npm test\n  EXPECT: tests passed\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(real, "tautological-check"), 0);
});

test("lint: a lint self-gate without --strict or an anchored marker is warned", () => {
  const lenient = ledger("lenient.md", [
    "- [ ] G1: this ledger states outcomes that can fail\n  CHECK: node ../scripts/gate-lint.mjs lenient.md\n  EXPECT: LINT OK\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(lenient, "lenient-lint-gate"), 1);
  const exact = ledger("exact.md", [
    "- [ ] G1: this ledger states outcomes that can fail\n  CHECK: node ../scripts/gate-lint.mjs --strict exact.md\n  EXPECT: LINT OK\n  EVIDENCE: pending",
    "- [ ] G2: this ledger raises no warnings\n  CHECK: node ../scripts/gate-lint.mjs exact.md\n  EXPECT: /^LINT OK$/m\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(exact, "lenient-lint-gate"), 0);
});

test("lint: unreplaced template placeholders are warned", () => {
  const templated = ledger("templated.md", [
    "- [ ] G1: children reverify\n  CHECK: node <skill-dir>/scripts/gate-check.mjs --reverify leaf.md\n  EXPECT: ALL MET\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(templated, "unreplaced-placeholder"), 1);
  const concrete = ledger("concrete.md", [
    "- [ ] G1: children reverify\n  CHECK: node tools/unlazy/scripts/gate-check.mjs --reverify leaf.md\n  EXPECT: ALL MET\n  EVIDENCE: pending",
  ]);
  assert.equal(ruleCount(concrete, "unreplaced-placeholder"), 0);
});

test("lint: noun-led outcome titles and version numbers are not flagged", () => {
  const nouns = ledger("nouns.md", [
    "- [ ] G1: update log is written to disk\n  EVIDENCE: pending",
    "- [ ] G2: support matrix covers Windows\n  EVIDENCE: pending",
    "- [ ] G3: release v2.1.0 notes exist in sha256 order\n  EVIDENCE: pending",
    "- [ ] G4: improve the retry logic\n  EVIDENCE: pending",
    "- [ ] G5: dashboard renders 34 rows\n  EVIDENCE: pending",
  ]);
  const out = lint(nouns).out;
  assert.equal((out.match(/\[activity-not-outcome\]/g) || []).length, 1, out);
  assert.match(out, /G4: names an activity/);
  assert.equal((out.match(/\[unmeasured-number\]/g) || []).length, 1, out);
  assert.match(out, /G5: title states a number/);
});

test("lint: manual evidence without a location is warned", () => {
  const manual = ledger("manual-evidence.md", [
    "- [x] G1: copy reviewed\n  EVIDENCE: looks good to me",
    "- [x] G2: copy reviewed again\n  EVIDENCE: reviewed docs/copy.md:12 against the brief",
  ]);
  const out = lint(manual).out;
  assert.equal((out.match(/\[uncited-manual-evidence\]/g) || []).length, 1, out);
  assert.match(out, /G1: manual evidence names no artifact location/);
});

test("lint: a script named in CHECK and edited after its evidence is warned", () => {
  const script = write("verify-evidence.mjs", "console.log('VERIFY_OK');\n");
  const gateText = "- [x] G1: verifier passes\n  CHECK: node verify-evidence.mjs\n  EXPECT: VERIFY_OK\n";
  const parsed = parseGates(gateText + "  EVIDENCE: pending\n").gates[0];
  const evidence = automaticEvidencePrefix(gateDefinitionDigest(parsed)) + " exit=0; EXPECT=matched; output-sha256=" +
    "a".repeat(64) + "; output-bytes=10; shell=/bin/sh; cwd=.; path=abc/1 entries; inputs=verify-evidence.mjs@" +
    fileDigest(readFileSync(script)).slice(0, 12);
  const recorded = write("evidence-ledger.md", "# Gates\n\n" + gateText + "  EVIDENCE: " + evidence + "\n");
  assert.equal(ruleCount(recorded, "input-changed-after-evidence"), 0);
  writeFileSync(script, "console.log('VERIFY_OK'); process.exitCode = 0;\n");
  assert.equal(ruleCount(recorded, "input-changed-after-evidence"), 1);
});

// ------------------------------------------------------------- runner

const exitCode = await runSuite(tests, { filter });
rmSync(DIR, { recursive: true, force: true });
process.exit(exitCode);
