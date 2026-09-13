#!/usr/bin/env node
// gate-lint.mjs : audit whether a ledger is worth passing.
// Zero dependencies. Node 16+.
//
// The checker and the Stop hook decide whether gates were met. Neither asks
// whether the gates were worth meeting. A gate reading "the entire feature
// works perfectly" with `CHECK: echo ok` and `EXPECT: ok` passes the checker,
// the parent re-verification and the hook, because the oracle is real, runs,
// and returns what it promised. Authoring is the one step in the enforcement
// hierarchy that is still pure prose discipline, and this lints it.
//
// This never executes a CHECK. It reads the ledger, the files named in recorded
// evidence, and judges its oracles.
//
//   node gate-lint.mjs [options] <ledger.md ...>
//     --strict   treat warnings as failures
//     --json     machine-readable findings
//
// exit codes: 0 no strict failures, 1 strict findings, 2 usage or parse error.
//
// Usable as a gate, so a ledger can require its own quality:
//   CHECK: node <skill-dir>/scripts/gate-lint.mjs --strict GATES.md
//   EXPECT: /^LINT OK$/m

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  classifyGateEvidence, evidenceInputs, ledgerLockRoot, parseGates, readStableRegularFile,
} from "./lib/gates.mjs";
import { fileDigest } from "./lib/approval.mjs";
import { escapeTerminal } from "./lib/terminal.mjs";

const HELP = `usage: gate-lint.mjs [--strict] [--json] <ledger.md ...>

Audit gate quality, not gate completion. Report lexical signs of fixed-output
or masked oracles, weak or match-anything expectations, unreplaced placeholders,
manual measurements, uncited manual evidence, titles that name an activity
instead of an outcome, and scripts that changed after their evidence. Never
executes a CHECK.

exit codes: 0 no strict failures, 1 strict findings, 2 usage or parse error.`;

const KNOWN_OPTIONS = new Set(["--strict", "--json", "--help", "-h"]);
const MAX_GATE_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORTED_FINDINGS = 64;
const MAX_REPORT_BYTES = 256 * 1024;
const terminalSafe = (value, maxBytes = 1024) => escapeTerminal(value, maxBytes);

const args = process.argv.slice(2);
if (!args.length) {
  console.error(HELP);
  process.exit(2);
}
// `--` makes every following token a filename, including literal files named
// `--help` and `-h`. Only scan the option prefix for the help flags.
const positionalIndex = args.indexOf("--");
const optionPrefix = positionalIndex === -1 ? args : args.slice(0, positionalIndex);
if (optionPrefix.includes("--help") || optionPrefix.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
let strict = false;
let asJson = false;
let positional = false;
const files = [];
for (const arg of args) {
  if (!positional && arg === "--") { positional = true; continue; }
  if (!positional && KNOWN_OPTIONS.has(arg)) {
    if (arg === "--strict") strict = true;
    else if (arg === "--json") asJson = true;
    continue;
  }
  if (!positional && arg.startsWith("-")) {
    console.error("gate-lint: unknown option " + terminalSafe(arg, 512));
    console.error("run gate-lint.mjs --help for usage");
    process.exit(2);
  }
  files.push(arg);
}
if (!files.length) {
  console.error("gate-lint: name at least one ledger file");
  process.exit(2);
}

// Advisory, lexical rules. None shell-parses a command, and none proves that an
// oracle cannot fail; each names a pattern worth a second look.
// A literal print: echo or printf, optionally through `cmd /c`, or `node -e`
// that only logs a string literal. A leading `true &&` or `: &&` adds nothing.
const LITERAL_PRINT = /(?:cmd(?:\.exe)?\s+\/c\s+)?(?:echo|printf)(?:\s+[^&|;]*)?|node\s+-e\s+(["'])\s*(?:console\.log|process\.stdout\.write)\(\s*(["'])[^"'\\]*\2\s*\)\s*;?\s*\1/;
const FIXED_OUTPUT_COMMAND = new RegExp("^\\s*(?:(?:true|:)\\s*&&\\s*)*(?:" + LITERAL_PRINT.source + "|true|:|exit\\s+0)\\s*$", "i");
const MASKED_EXIT = /\|\|\s*(?:true|:|exit\s+0|echo\b|printf\b)|;\s*(?:true|:|exit\s+0)\s*$/i;
const PLACEHOLDER = /<[a-z][a-z0-9-]*>/i;
// Tokens that appear in failure output as readily as in success output.
const WEAK_EXPECT = new Set([
  "ok", "okay", "done", "pass", "passed", "success", "successful", "succeeded",
  "complete", "completed", "finished", "yes", "true", "0", "good", "fine", "working",
]);
const MIN_TEXT_EXPECT_CHARS = 4;
// Openings that name an activity rather than an outcome a stranger could judge.
const ACTIVITY_START = /^(work(ing)? on|improve|enhance|handle|support|ensure|make sure|try|attempt|look (at|into)|investigate|consider|review|refactor|clean ?up|polish|update|tidy|address|deal with|add support)\b/i;
// A verb that states an observable result keeps a noun-led title an outcome:
// "update log is written", "support matrix covers Windows".
const OUTCOME_VERB = /\b(is|are|was|were|has|have|had|passes|pass|returns|exits|renders|matches|contains|succeeds|fails|exists|equals|reports|prints|shows|lists|rejects|accepts|stays|remains|works|runs|builds|loads|reads|writes|holds|covers|includes|produces|emits|responds)\b/i;
// Numbers that are part of a name or version, not a measurement.
const NAMED_NUMBER = /\bv?\d+(?:\.\d+)+\b|\b[A-Za-z][A-Za-z_-]*\d[A-Za-z0-9_-]*\b/g;
// A manual gate's evidence should cite where the fact can be checked.
const EVIDENCE_LOCATION = /[\w.-]+\/[\w./-]+|[\w-]+\.[A-Za-z0-9]{1,6}(?::\d+)?\b|https?:\/\/|#\d+|\bline \d+|`[^`]+`/i;
// Short probes a pattern should not match. Kept short so evaluating an
// arbitrary author pattern stays cheap.
const MATCH_ANYTHING_PROBES = ["q7Zx", "FAIL"];

const findings = [];
let errorCount = 0;
let warningCount = 0;
let findingCount = 0;
const add = (file, level, gate, rule, message) => {
  findingCount++;
  if (level === "error") errorCount++;
  else if (level === "warn") warningCount++;
  if (findings.length >= MAX_REPORTED_FINDINGS) return;
  findings.push({
    file: terminalSafe(file, 512),
    level: terminalSafe(level, 16),
    gate: gate ? terminalSafe(gate, 128) : null,
    rule: terminalSafe(rule, 64),
    message: terminalSafe(message, 1024),
  });
};

function repositoryRoot(file) {
  let directory;
  try { directory = dirname(realpathSync(file)); }
  catch { return dirname(resolve(file)); }
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return ledgerLockRoot(file);
    directory = parent;
  }
}

// The command segment after the last `;`, `&&`, or `||`, with its separator.
function lastSegment(check) {
  const parts = String(check).split(/(;|&&|\|\|)/);
  if (parts.length < 3) return null;
  return { separator: parts[parts.length - 2], command: parts[parts.length - 1].trim() };
}

let parseFailed = false;

for (const file of files) {
  let text;
  try {
    // Explicit lint targets may intentionally live outside the current
    // working directory, so constrain file kind and size without a root.
    text = readStableRegularFile(file, {
      maxBytes: MAX_GATE_LEDGER_BYTES,
      label: "gate ledger",
    });
  } catch (error) {
    console.error("gate-lint: cannot read " + terminalSafe(file, 512) + ": " + terminalSafe(error.message, 1024));
    process.exit(2);
  }

  const doc = parseGates(text);
  if (doc.errors.length) {
    // A ledger the shared parser rejects cannot be judged on quality.
    parseFailed = true;
    for (const error of doc.errors) add(file, "error", null, "parse", error);
    continue;
  }

  const live = doc.gates.filter((gate) => !doc.abandoned.has(gate.id));
  const runnable = live.filter((gate) => gate.check);
  const ledgerName = basename(file);
  let root = null;

  for (const gate of live) {
    const { id, title, check, expect } = gate;

    if (check && FIXED_OUTPUT_COMMAND.test(check)) {
      add(file, "warn", id, "tautological-check",
        'CHECK looks like a fixed-output command: "' + check + '"; use an oracle that observes the named outcome');
    }

    if (check && MASKED_EXIT.test(check)) {
      add(file, "warn", id, "masked-exit",
        "CHECK can exit zero after its real command fails (|| true, ; exit 0, or a trailing echo); let the failure reach the exit status");
    }

    if (check && expect && gate.expectation && gate.expectation.kind === "text") {
      const segment = lastSegment(check);
      if (segment && segment.separator !== "&&" && /^(?:echo|printf)\b/i.test(segment.command) &&
          segment.command.includes(expect.trim())) {
        add(file, "warn", id, "echoes-expect",
          "CHECK prints its own EXPECT marker after " + JSON.stringify(segment.separator) +
          ", so the marker appears whether or not the command before it succeeded");
      }
    }

    // Without --strict, gate-lint prints LINT OK beside its warnings, so only an
    // anchored marker keeps a lint self-gate from certifying a weak ledger.
    if (check && /\bgate-lint\b/.test(check) && !/(?:^|\s)--strict(?:\s|$)/.test(check) && !/\^LINT OK\$/.test(expect || "")) {
      add(file, "warn", id, "lenient-lint-gate",
        "CHECK runs gate-lint without --strict, so LINT OK also prints when warnings remain; add --strict or EXPECT /^LINT OK$/m");
    }

    if (check && check.includes(ledgerName) && !/gate-(?:lint|check)/.test(check)) {
      add(file, "warn", id, "reads-own-ledger",
        "CHECK reads its own ledger " + JSON.stringify(ledgerName) + ", so it measures the ledger instead of the artifact");
    }

    for (const [field, value] of [["CHECK", check], ["EXPECT", expect], ["CWD", gate.cwd]]) {
      if (value && PLACEHOLDER.test(value)) {
        add(file, "warn", id, "unreplaced-placeholder",
          field + " still contains the template placeholder " + value.match(PLACEHOLDER)[0] + "; replace it before running the ledger");
      }
    }

    if (expect && WEAK_EXPECT.has(expect.trim().toLowerCase())) {
      add(file, "warn", id, "weak-expect",
        'EXPECT "' + expect + '" also appears in failure output; match a line only success can print');
    } else if (expect && gate.expectation && gate.expectation.kind === "text" &&
        expect.trim().length < MIN_TEXT_EXPECT_CHARS) {
      add(file, "warn", id, "short-expect",
        'EXPECT "' + expect + '" is short enough to appear in unrelated output; match a distinctive success marker');
    }

    if (gate.expectation && gate.expectation.kind === "regex") {
      let pattern = null;
      try { pattern = new RegExp(gate.expectation.source, gate.expectation.flags.replace(/[gy]/g, "")); }
      catch { pattern = null; }
      if (pattern && MATCH_ANYTHING_PROBES.every((probe) => pattern.test(probe))) {
        add(file, "warn", id, "match-anything",
          'EXPECT "' + expect + '" matches arbitrary short output, including failure text; anchor it to a success marker');
      }
      if (gate.expectation.pathLike) {
        add(file, "warn", id, "path-read-as-regex",
          'EXPECT "' + expect + '" looks like a literal path but is read as a regular expression, so its dots are wildcards');
      }
    }

    if (!check) {
      add(file, "warn", id, "manual-gate",
        "no CHECK, so this outcome is judged by hand and its evidence is only as good as the reader");
      if (/\d/.test(title.replace(NAMED_NUMBER, ""))) {
        add(file, "warn", id, "unmeasured-number",
          'title states a number that nothing measures: "' + title + '"');
      }
      if (gate.checked && gate.evidence && !/^pending$/i.test(gate.evidence) && !EVIDENCE_LOCATION.test(gate.evidence)) {
        add(file, "warn", id, "uncited-manual-evidence",
          "manual evidence names no artifact location; cite a file and line, URL, issue, or quoted command output");
      }
    }

    if (ACTIVITY_START.test(title) && !OUTCOME_VERB.test(title.replace(ACTIVITY_START, ""))) {
      add(file, "warn", id, "activity-not-outcome",
        'names an activity, not an outcome a stranger could judge: "' + title + '"');
    }

    if (check && classifyGateEvidence(gate) === "automatic-current") {
      const recorded = evidenceInputs(gate.evidence);
      if (recorded.size) {
        if (root === null) root = repositoryRoot(file);
        for (const [encoded, digest] of recorded) {
          let path;
          try { path = decodeURI(encoded); } catch { path = encoded; }
          let current = null;
          try {
            current = fileDigest(readStableRegularFile(join(root, path), {
              root, maxBytes: MAX_INPUT_BYTES, label: "named input", raw: true,
            })).slice(0, 12);
          } catch { current = null; }
          if (current !== digest) {
            add(file, "warn", id, "input-changed-after-evidence",
              path + (current === null ? " is missing or unreadable" : " changed") +
              " since its evidence was recorded; run gate-check.mjs --reverify");
          }
        }
      }
    }
  }

  for (const warning of doc.warnings) {
    if (/: CWD /.test(warning)) add(file, "warn", warning.match(/^gate (\S+):/) ? warning.match(/^gate (\S+):/)[1] : null, "cwd-outside-repository", warning.replace(/^gate \S+: /, ""));
  }

  if (live.length && runnable.length / live.length < 0.5) {
    add(file, "warn", null, "mostly-manual",
      runnable.length + "/" + live.length + " gates are runnable; a mostly manual ledger is prose with checkboxes");
  }
}

const failed = errorCount > 0 || (strict && warningCount > 0);

if (asJson) {
  const report = {
    ok: !failed,
    errors: errorCount,
    warnings: warningCount,
    findings: [...findings],
    truncated: findingCount > findings.length,
    omittedFindings: findingCount - findings.length,
  };
  let output = JSON.stringify(report, null, 2);
  while (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES && report.findings.length) {
    report.findings.pop();
    report.truncated = true;
    report.omittedFindings = findingCount - report.findings.length;
    output = JSON.stringify(report, null, 2);
  }
  console.log(output);
} else {
  let lastFile = null;
  for (const finding of findings) {
    if (finding.file !== lastFile) {
      console.log(finding.file);
      lastFile = finding.file;
    }
    const label = finding.level === "error" ? "ERROR" : "WARN ";
    const who = finding.gate ? finding.gate + ": " : "";
    console.log("  " + label + " " + who + finding.message + "  [" + finding.rule + "]");
  }
  const omitted = findingCount - findings.length;
  if (omitted) console.log("... [report truncated: " + omitted + " finding(s) omitted]");
  if (!failed) {
    console.log(warningCount ? "LINT OK (" + warningCount + " warning(s))" : "LINT OK");
  } else {
    console.log("LINT FINDINGS: " + errorCount + " error(s), " + warningCount + " warning(s)");
  }
}

// Let Node drain stdout before exiting. A forced process.exit() can truncate a
// large report when stdout is an asynchronous POSIX pipe.
process.exitCode = parseFailed ? 2 : failed ? 1 : 0;
