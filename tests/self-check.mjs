#!/usr/bin/env node
// self-check.mjs : structural checks on the skill's own scripts.
//
//   node tests/self-check.mjs
//
// Lives in a file rather than as an inline `node -e` in GATES.md on purpose: a
// one-liner containing quotes, "^" or "!" is parsed differently by cmd.exe and
// by sh, so an inline check can pass on one platform and report a phantom
// failure on the other. A CHECK line should name a script, not embed one.
//
// Prints "self-check ok (N/N)" on success, which is what the gate matches.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/harness.mjs";
import { approvalKey, approvalOracle } from "../scripts/lib/approval.mjs";
import { planStructureProblems } from "../scripts/plan-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = [
  "scripts/gate-check.mjs",
  "scripts/gate-lint.mjs",
  "scripts/dispatch-check.mjs",
  "scripts/stop-hook.mjs",
  "scripts/install-hooks.mjs",
  "scripts/lib/gates.mjs",
  "scripts/lib/dispatch.mjs",
  "scripts/lib/check-supervisor.mjs",
  "scripts/lib/process-tree.mjs",
  "scripts/lib/regex-worker.mjs",
  "scripts/lib/approval.mjs",
  "scripts/lib/terminal.mjs",
  "scripts/plan-check.mjs",
  "tests/lib/harness.mjs",
  "tests/remediation-tests.mjs",
  "tests/run-tests.mjs",
  "tests/dispatch-tests.mjs",
  "tests/hardening-tests.mjs",
  "tests/stress-tests.mjs",
  "tests/lint-tests.mjs",
  "tests/contract-tests.mjs",
  "tests/self-check.mjs",
];

// Git may materialize CRLF on Windows. Structural source checks operate on
// text, so normalize checkout line endings before matching multiline rules.
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function releasePrecedesPromotion(section, releaseToken, promoteToken) {
  const release = section.indexOf(releaseToken);
  const promote = section.indexOf(promoteToken);
  return release !== -1 && promote !== -1 && release < promote;
}

check("zero non-stdlib imports", () => {
  const bad = [];
  for (const p of SCRIPTS) {
    for (const m of read(p).matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (!spec.startsWith("node:") && !spec.startsWith(".")) bad.push(p + " -> " + spec);
    }
  }
  return bad.length ? "non-stdlib import: " + bad.join(", ") : null;
});

check("one shared gate parser", () => {
  // The v2.0 checker and hook each had their own GATE_RE and disagreed about a
  // gate's id when it carried no "Gn:" prefix. Parsing now lives only in the lib.
  // This file names GATE_RE to describe the rule, so it scans only scripts/.
  const owners = SCRIPTS.filter(p => p.startsWith("scripts/") && read(p).includes("GATE_RE"));
  return owners.length === 1 && owners[0] === "scripts/lib/gates.mjs"
    ? null
    : "GATE_RE should exist only in scripts/lib/gates.mjs, found in: " + owners.join(", ");
});

check("no index-arithmetic argument filtering", () => {
  // The v2.0 arg filter dropped index tIdx+1, which is 0 when --timeout is
  // absent, silently discarding the first file argument.
  return read("scripts/gate-check.mjs").includes("i !== tIdx + 1")
    ? "gate-check.mjs still filters arguments by index arithmetic"
    : null;
});

check("gate files are written atomically", () => {
  const src = read("scripts/gate-check.mjs");
  if (!src.includes("writeAtomic")) return "gate-check.mjs does not write via writeAtomic";
  if (!src.includes("withFileLock")) return "gate-check.mjs does not take a lock before writing";
  return null;
});

check("checks wait for close and cap output", () => {
  const src = read("scripts/gate-check.mjs");
  if (!src.includes('child.once("close"')) return "gate runner does not settle on stdio close";
  if (src.includes('child.once("exit"')) return "gate runner settles on exit before stdio close";
  if (!src.includes("MAX_OUTPUT_BYTES")) return "gate runner has no explicit output cap";
  return null;
});

check("approval identity binds every execution input", () => {
  // Behavior, not source text: change each oracle field in turn and require a
  // different approval key.
  const base = {
    check: "node verify.mjs", expect: "/^ok$/m", cwd: "/repo", cwdIdentity: ["1", "2"],
    ledgerDirectoryIdentity: ["1", "3"], shell: "/bin/sh", timeoutMs: 120000, maxOutputBytes: 1048576,
    regexTimeoutMs: 250, regexStartupTimeoutMs: 5000, maxRegexWorkers: 4, platform: "linux",
    path: "/usr/bin", inputs: [["verify.mjs", "a".repeat(64)]],
  };
  const key = approvalKey("/repo/GATES.md", "G1", approvalOracle(base));
  const dropped = Object.keys(base).filter((field) => !(field in approvalOracle(base)));
  if (dropped.length) return "approvalOracle drops: " + dropped.join(", ");
  const mutate = (value) => typeof value === "number" ? value + 1 : Array.isArray(value) ? [...value, "x"] : value + "x";
  const unbound = Object.keys(base).filter((field) =>
    approvalKey("/repo/GATES.md", "G1", approvalOracle({ ...base, [field]: mutate(base[field]) })) === key);
  if (unbound.length) return "changing these fields keeps the approval: " + unbound.join(", ");
  if (approvalKey("/repo/other.md", "G1", approvalOracle(base)) === key) return "ledger path is unbound";
  if (approvalKey("/repo/GATES.md", "G2", approvalOracle(base)) === key) return "gate id is unbound";
  if (!read("scripts/gate-check.mjs").includes("approvalOracle(")) return "gate-check.mjs does not build approvals with approvalOracle";
  return null;
});

check("the hook resolves a scope rather than globbing the tree", () => {
  const src = read("scripts/stop-hook.mjs");
  if (!src.includes("resolveTarget")) return "stop-hook.mjs does not resolve a scope";
  if (!src.includes("hookStatePath")) return "stop-hook.mjs does not use a per-scope state path";
  return null;
});

check("every local resource the skill names exists", () => {
  const skill = read("SKILL.md");
  const missing = [];
  const named = new Set();
  for (const m of skill.matchAll(/`((?:references|templates|scripts)\/[^`\s]+|SECURITY\.md)`/g)) named.add(m[1]);
  for (const path of named) {
    try { read(path); } catch { missing.push(path); }
  }
  return missing.length ? "SKILL.md names missing local resources: " + missing.join(", ") : null;
});

check("all executable sources retain the Node 16 floor", () => {
  const bad = SCRIPTS.filter(p => /Node 1[89]\+/.test(read(p)));
  return bad.length ? "newer runtime claim in: " + bad.join(", ") : null;
});

check("the PLAN template carries a revisioned contract denominator", () => {
  const plan = read("templates/PLAN.md");
  const required = [
    "Current contract inventory", "Contract revision", "Required outcome or constraint",
    "Owner", "Observing gate or manual review", "Disposition", "REMOVED_BY_USER",
  ];
  const missing = required.filter((token) => !plan.includes(token));
  return missing.length ? "PLAN contract inventory missing: " + missing.join(", ") : null;
});

check("the PLAN dispatch table is the single operational authority", () => {
  const problems = planStructureProblems(read("templates/PLAN.md")).problems;
  return problems.length ? problems.join("; ") : null;
});

check("the PLAN structural check rejects contradictory representations", () => {
  const plan = read("templates/PLAN.md");
  const controls = [
    ["blocked leaf marked READY", plan.replace(
      "| 1.2.2 | src/<d>/**, tests/<d>/** | 1.2.1 | judgment | 2 | WAITING |",
      "| 1.2.2 | src/<d>/**, tests/<d>/** | 1.2.1 | judgment | 2 | READY |")],
    ["dependency in the same wave", plan.replace(
      "| 1.2.2 | src/<d>/**, tests/<d>/** | 1.2.1 | judgment | 2 | WAITING |",
      "| 1.2.2 | src/<d>/**, tests/<d>/** | 1.2.1 | judgment | 1 | WAITING |")],
    ["unknown dependency", plan.replace(
      "| 1.2.2 | src/<d>/**, tests/<d>/** | 1.2.1 | judgment | 2 | WAITING |",
      "| 1.2.2 | src/<d>/**, tests/<d>/** | 9.9.9 | judgment | 2 | WAITING |")],
    ["model name used as Tier", plan.replace(
      "| 1.1.2 | src/<b>/**, tests/<b>/** | - | judgment | 1 | READY |",
      "| 1.1.2 | src/<b>/**, tests/<b>/** | - | model-x | 1 | READY |")],
    ["duplicate table row", plan.replace(
      "| 1.1.2 | src/<b>/**, tests/<b>/** | - | judgment | 1 | READY |",
      "| 1.1.2 | src/<b>/**, tests/<b>/** | - | judgment | 1 | READY |\n" +
      "| 1.1.2 | src/<b>/**, tests/<b>/** | - | judgment | 1 | READY |")],
    ["operational state copied into the tree", plan.replace(
      "- 1.1.1 <leaf> ...... gates/leaf-1.1.1.md",
      "- 1.1.1 <leaf> ...... gates/leaf-1.1.1.md ...... State: READY")],
    ["separate schedule added", plan.replace(
      "## Status log",
      "## Dispatch schedule\n\n- Wave 1: 1.1.1\n\n## Status log")],
  ];
  for (const [name, control] of controls) {
    if (control === plan) return "negative-control fixture no longer matches: " + name;
    if (!planStructureProblems(control).problems.length) return "negative control passed: " + name;
  }
  return null;
});

check("leaf release precedes dependent promotion everywhere", () => {
  const orchestration = read("references/orchestration.md");
  const stepStart = orchestration.indexOf("6. **Append status and roll forward.**");
  const stepEnd = orchestration.indexOf("7. **Integrate bottom-up.**", stepStart);
  const loopStart = orchestration.indexOf("while an unverified leaf remains:");
  const loopEnd = orchestration.indexOf("```", loopStart);
  const sections = [
    ["driver step 6", orchestration.slice(stepStart, stepEnd),
      "--leaf leaf-1.2.1 --release", "Only then promote"],
    ["rolling dispatch loop", orchestration.slice(loopStart, loopEnd),
      "release that exact leaf lease and record the release", "promote each WAITING leaf"],
  ];
  for (const [name, section, releaseToken, promoteToken] of sections) {
    if (!releasePrecedesPromotion(section, releaseToken, promoteToken)) {
      return name + " does not release the exact leaf before promotion";
    }
    const omitted = section.replace(releaseToken, "record the leaf result");
    if (releasePrecedesPromotion(omitted, releaseToken, promoteToken)) {
      return name + " missing-release negative control passed";
    }
  }
  if (releasePrecedesPromotion("promote, then release", "release", "promote")) {
    return "swapped-order negative control passed";
  }
  const parallel = read("references/parallel.md");
  if (!parallel.includes("Release the whole scope only after every leaf has settled")) {
    return "parallel guide does not reserve whole-scope release for final cleanup";
  }
  const plan = read("templates/PLAN.md");
  if (!plan.includes("Do not promote a dependent until that exact\nrelease is recorded")) {
    return "PLAN template does not gate promotion on the recorded exact release";
  }
  const skill = read("SKILL.md");
  if (!skill.includes("parent-verified leaf's exact lease has been released")) {
    return "SKILL.md rolling rule omits exact release";
  }
  return null;
});

check("request reconciliation keeps the focused solo cheap path", () => {
  const skill = read("SKILL.md");
  if (!skill.toLowerCase().includes("re-read the current request")) return "SKILL.md lacks final request reread";
  if (!skill.includes("a PLAN table is not required")) return "focused solo path was made needlessly orchestrated";
  if (!read("references/orchestration.md").includes("review every current contract row")) {
    return "orchestration guide lacks final contract reconciliation";
  }
  return null;
});

check("the final report discloses remaining work, unrun checks, and hypotheses", () => {
  const skill = read("SKILL.md");
  const reference = read("references/reporting.md");
  const template = read("templates/REPORT.md");
  const hook = read("scripts/stop-hook.mjs");
  const problems = [];
  for (const phrase of ["not run", "unverified", "hypothesis:", "+N more", "templates/REPORT.md", "references/reporting.md"]) {
    if (!skill.includes(phrase)) problems.push("SKILL.md lacks " + JSON.stringify(phrase));
  }
  for (const heading of ["## Unmet", "## Abandoned, deferred, or awaiting owner decision", "## Not started", "## Not run or unverified", "## Hypotheses", "## Assumptions"]) {
    if (!template.includes(heading + "\n")) problems.push("templates/REPORT.md lacks " + JSON.stringify(heading));
  }
  for (const phrase of ["refuted:", "untested:", "REMOVED_BY_USER", "+N more"]) {
    if (!reference.includes(phrase)) problems.push("references/reporting.md lacks " + JSON.stringify(phrase));
  }
  if (!hook.includes("never describe unmet gates as done")) problems.push("block reason omits the reporting rule");
  if (!hook.includes("do not describe this task as done")) problems.push("release message omits the reporting rule");
  return problems.length ? problems.join("; ") : null;
});

// Structure only: headings, pointers, and the table shape. The wording inside
// each section is editorial and deliberately not pinned here.
function engineeringStandardProblems({ skill, reference, economy, template }) {
  const problems = [];
  if (!skill.includes("`references/engineering-standard.md`")) problems.push("SKILL.md does not point to the engineering standard");
  if (!economy.includes("`references/engineering-standard.md`")) problems.push("token economy does not point to the engineering standard");
  for (const heading of [
    "## Record a baseline before the first edit", "## Cover each boundary the change has",
    "## Gate edge cases inside the contract", "## End the review rounds",
    "## Check before an authorized commit", "## Record handoffs in the ledger", "## Audits and reviews",
  ]) {
    if (!reference.split("\n").includes(heading)) problems.push("references/engineering-standard.md lacks " + JSON.stringify(heading));
  }
  const header = reference.split("\n").find((line) => line.startsWith("| Row |"));
  if (header !== "| Row | Applies when the change | Proving artifact |") problems.push("boundary table lost its artifact column");
  if (!template.split("\n").includes("## Risks, trade-offs, and limits")) problems.push("templates/REPORT.md lacks a risk section");
  return problems;
}

check("the engineering standard keeps its scoped, terminating structure", () => {
  const sources = {
    skill: read("SKILL.md"),
    reference: read("references/engineering-standard.md"),
    economy: read("references/token-economy.md"),
    template: read("templates/REPORT.md"),
  };
  const problems = engineeringStandardProblems(sources);
  if (problems.length) return problems.join("; ");
  for (const [name, mutate] of [
    ["missing review-round stop", (value) => ({ ...value, reference: value.reference.replace("## End the review rounds\n", "## Notes\n") })],
    ["missing artifact column", (value) => ({ ...value, reference: value.reference.replace("| Proving artifact |", "| Notes |") })],
    ["missing skill pointer", (value) => ({ ...value, skill: value.skill.split("`references/engineering-standard.md`").join("the standard") })],
  ]) {
    const control = mutate(sources);
    if (JSON.stringify(control) === JSON.stringify(sources)) return "negative-control fixture no longer matches: " + name;
    if (!engineeringStandardProblems(control).length) return "negative control passed: " + name;
  }
  return null;
});

// Every text file in the checkout, skipping version control, dependencies, and
// local dot-directories such as .unlazy/ and .claude/.
function repositoryTextFiles(directory = ROOT, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...repositoryTextFiles(join(directory, entry.name), path));
    else if (entry.isFile() && /\.(?:md|mjs|js|json|ya?ml|txt)$/.test(entry.name)) files.push(path);
  }
  return files;
}

check("repository text uses no dash-like punctuation", () => {
  // U+2012 to U+2015 are the figure, en, em, and horizontal-bar dashes; U+2212
  // is the minus sign that renders like one.
  const DASH = /[\u2012-\u2015\u2212]/;
  if (DASH.test("plain - hyphen")) return "negative control passed: hyphen flagged as dash";
  for (const code of [0x2012, 0x2013, 0x2014, 0x2015, 0x2212]) {
    if (!DASH.test("x" + String.fromCharCode(code) + "y")) return "negative control failed: U+" + code.toString(16) + " not detected";
  }
  const files = repositoryTextFiles();
  if (!files.includes("SKILL.md") || !files.some((path) => path.startsWith("research/"))) {
    return "file walk missed SKILL.md or research/: " + files.length + " files";
  }
  const dashed = files.filter((path) => DASH.test(read(path)));
  return dashed.length ? "dash-like punctuation in: " + dashed.join(", ") : null;
});

check("no API newer than the Node 16.0 floor", () => {
  // A grep cannot prove compatibility; CI runs the suite on Node 16.0.0 for
  // that. This catches the common additions early and names them.
  const NEWER = /\.at\(|Object\.hasOwn|structuredClone|findLast|util\.parseArgs|["']node:test["']|AbortSignal\.timeout|cpSync|toSorted|toReversed|Array\.fromAsync/;
  if (!NEWER.test("list.at(-1)") || NEWER.test("const parseArgs = (argv) => argv")) return "API pattern negative control failed";
  const bad = SCRIPTS.filter((path) => path !== "tests/self-check.mjs" && NEWER.test(read(path)));
  return bad.length ? "post-16.0 API in: " + bad.join(", ") : null;
});

// Documented invocations must use flags and values the tools accept today. The
// accepted flags come from each tool's own --help output, so a flag renamed in
// code but not in prose fails here rather than in a reader's terminal.
const TOOLS = ["gate-check", "gate-lint", "dispatch-check", "install-hooks", "plan-check"];
const INVOCATION_RE = /node\s+"?([^\s"`]*\/)?scripts\/(gate-check|gate-lint|dispatch-check|install-hooks|plan-check)\.mjs"?([^`\n]*)/g;
const METAVAR_VALUE = {
  TOKENS: /^(?:<[^>]+>|[a-f0-9]{16}(?:,[a-f0-9]{16})*)$/,
  N: /^(?:<[^>]+>|\d+)$/,
  S: /^(?:<[^>]+>|\d+)$/,
  IDS: /^(?:<[^>]+>|[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*)$/,
  ID: /^[A-Za-z0-9._<>-]+$/,
  NAME: /^[A-Za-z0-9._<>-]+$/,
};

function toolHelp(tool) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", tool + ".mjs"), "--help"], { encoding: "utf8", env: cleanEnv() });
  if (result.status !== 0) throw new Error(tool + " --help exited " + result.status + ": " + result.stderr);
  const flags = new Set(result.stdout.match(/--[a-z][a-z-]*/g) || []);
  const values = new Map();
  for (const match of result.stdout.matchAll(/(--[a-z][a-z-]*)[ =]([A-Z][A-Z_]*)\b/g)) values.set(match[1], match[2]);
  const subcommands = new Set([...result.stdout.matchAll(new RegExp(tool + "\\.mjs ([a-z]+) --", "g"))].map((match) => match[1]));
  return { flags, values, subcommands };
}

function invocationProblems(text, helps) {
  const problems = [];
  let count = 0;
  for (const [whole, prefix, tool, rest] of text.matchAll(INVOCATION_RE)) {
    count++;
    const shown = whole.trim();
    if (prefix !== "<skill-dir>/") problems.push(shown + ": name the tool as <skill-dir>/scripts/" + tool + ".mjs");
    const help = helps[tool];
    const words = rest.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (help.subcommands.size && !help.subcommands.has(words[0])) {
      problems.push(shown + ": unknown subcommand " + JSON.stringify(words[0]));
    }
    for (let index = 0; index < words.length; index++) {
      if (!words[index].startsWith("--")) continue;
      const [name, ...inline] = words[index].split("=");
      if (!help.flags.has(name)) {
        problems.push(shown + ": " + tool + " has no " + name);
        continue;
      }
      const metavar = help.values.get(name);
      if (!metavar) {
        if (inline.length) problems.push(shown + ": " + name + " takes no value");
        continue;
      }
      const value = inline.length ? inline.join("=") : words[++index];
      if (value === undefined || value.startsWith("--")) problems.push(shown + ": " + name + " needs " + metavar);
      else if (METAVAR_VALUE[metavar] && !METAVAR_VALUE[metavar].test(value)) {
        problems.push(shown + ": " + JSON.stringify(value) + " is not " + metavar + " for " + name);
      }
    }
  }
  return { problems, count };
}

const markdownIn = (directory) => readdirSync(join(ROOT, directory))
  .filter((name) => name.endsWith(".md")).map((name) => directory + "/" + name);

check("documented tool invocations use flags the tools accept", () => {
  const helps = Object.fromEntries(TOOLS.map((tool) => [tool, toolHelp(tool)]));
  for (const [name, text] of [
    ["bare --approve", "`node <skill-dir>/scripts/gate-check.mjs --approve GATES.md`"],
    ["unknown flag", "`node <skill-dir>/scripts/gate-lint.mjs --nope GATES.md`"],
    ["repository-relative tool path", "`node scripts/gate-lint.mjs GATES.md`"],
    ["other skill placeholder", "`node <path-to-skill>/scripts/gate-check.mjs --status GATES.md`"],
    ["unknown subcommand", "`node <skill-dir>/scripts/dispatch-check.mjs launch --scope api --wave w1`"],
    ["missing value", "`node <skill-dir>/scripts/gate-check.mjs --scope`"],
  ]) {
    if (!invocationProblems(text, helps).problems.length) return "negative control passed: " + name;
  }
  const accepted = invocationProblems("`node <skill-dir>/scripts/gate-check.mjs --approve=0123456789abcdef,fedcba9876543210 GATES.md`", helps);
  if (accepted.problems.length || accepted.count !== 1) return "positive control failed: " + accepted.problems.join("; ");
  let total = 0;
  const problems = [];
  for (const path of ["SKILL.md", "SECURITY.md", "README.md", "CONTRIBUTING.md", ...markdownIn("references"), ...markdownIn("templates")]) {
    const result = invocationProblems(read(path), helps);
    total += result.count;
    problems.push(...result.problems.map((problem) => path + ": " + problem));
  }
  if (total < 20) return "found only " + total + " documented invocations; the pattern no longer matches the docs";
  return problems.length ? problems.join("; ") : null;
});

check("abandonment is terminal handoff rather than ALL MET", () => {
  // Behavior, not source text: run the real checker and hook on a ledger with
  // one met gate and one deferred handoff.
  const dir = mkdtempSync(join(tmpdir(), "unlazy-self-check-"));
  try {
    writeFileSync(join(dir, "GATES.md"), "# Gates\n\n- [x] G1: done\n  EVIDENCE: checked notes.md:1\n" +
      "- [ ] G2: impossible\n  EVIDENCE: pending\n\nABANDON: G2 DEFERRED: needs the vendor API\n");
    const env = cleanEnv({ UNLAZY_STATE_DIR: mkdtempSync(join(tmpdir(), "unlazy-self-check-state-")) });
    const status = spawnSync(process.execPath, [join(ROOT, "scripts", "gate-check.mjs"), "--status"], { cwd: dir, encoding: "utf8", env });
    if (status.status !== 1 || !status.stdout.includes("HANDOFF REQUIRED") || status.stdout.includes("ALL MET")) {
      return "checker did not report a non-successful handoff: " + status.stdout + status.stderr;
    }
    if (!status.stdout.includes("GATES:G2 (DEFERRED)")) return "checker lost the handoff kind: " + status.stdout;
    const hook = spawnSync(process.execPath, [join(ROOT, "scripts", "stop-hook.mjs")], {
      cwd: dir, encoding: "utf8", env, input: JSON.stringify({ cwd: dir, session_id: "self-check" }),
    });
    rmSync(env.UNLAZY_STATE_DIR, { recursive: true, force: true });
    if (!hook.stdout.includes('"decision":"block"') || !hook.stdout.includes("HANDOFF REQUIRED")) {
      return "Stop hook did not deliver the handoff to the model: " + hook.stdout + hook.stderr;
    }
    if (hook.stdout.includes("vendor API")) return "Stop hook copied a free-form handoff reason";
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let passed = 0;
const failures = [];
for (const c of checks) {
  let problem;
  try { problem = c.fn(); } catch (e) { problem = e.message; }
  if (problem) { failures.push(c.name + ": " + problem); console.log("FAIL " + c.name + "\n     " + problem); }
  else { passed++; console.log("ok   " + c.name); }
}

console.log("");
if (failures.length) {
  console.log("self-check FAILED (" + passed + "/" + checks.length + ")");
  process.exit(1);
}
console.log("self-check ok (" + passed + "/" + checks.length + ")");
