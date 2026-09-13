#!/usr/bin/env node
// PLAN contract reconciliation, exercised through scripts/plan-check.mjs.
// Zero dependencies.
//
// The required ids below stand for a human reread of the current request. The
// tool never infers requirements from prose; it checks that the documented
// inventory control discriminates omissions once that authority is supplied.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractProblems, reviewContract } from "../scripts/plan-check.mjs";
import { runNode, runSuite } from "./lib/harness.mjs";

const ESC = String.fromCharCode(27);
const PLAN_CHECK = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "plan-check.mjs");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const base = () => ({
  required: ["A", "B"],
  revision: 1,
  removedByUser: new Set(),
  owners: new Set(["leaf-a", "leaf-b"]),
  observations: new Set(["GA", "GB"]),
  coverage: new Map([["GA", new Set(["A"])], ["GB", new Set(["B"])]]),
  rows: [
    { id: "A", owner: "leaf-a", observation: "GA", disposition: "ACTIVE", revision: 1 },
    { id: "B", owner: "leaf-b", observation: "GB", disposition: "ACTIVE", revision: 1 },
  ],
});
const gaps = (spec) => reviewContract(spec).gaps.join("\n");

test("contract: A and B mapped to live owners and observations reconcile", () => {
  assert.deepEqual(reviewContract(base()), { gaps: [], handoffs: [] });
});

test("contract: an omitted B is reported", () => {
  const spec = base();
  spec.rows.pop();
  assert.match(gaps(spec), /B: missing row/);
});

test("contract: an unowned B is reported", () => {
  const spec = base();
  spec.rows[1].owner = "";
  assert.match(gaps(spec), /B: missing or stale owner/);
});

test("contract: missing, stale, or wrong observations are reported", () => {
  const missing = base();
  missing.rows[1].observation = "";
  assert.match(gaps(missing), /missing or stale observation/);
  const stale = base();
  stale.rows[1].observation = "OLD";
  assert.match(gaps(stale), /missing or stale observation/);
  const wrong = base();
  wrong.rows[1].observation = "GA";
  assert.match(gaps(wrong), /does not cover outcome/);
});

test("contract: explicit removal is distinct from abandonment or deferment", () => {
  const removed = base();
  removed.rows[1].disposition = "REMOVED_BY_USER";
  removed.removedByUser.add("B");
  assert.deepEqual(reviewContract(removed), { gaps: [], handoffs: [] });
  const unauthorized = base();
  unauthorized.rows[1].disposition = "REMOVED_BY_USER";
  assert.match(gaps(unauthorized), /B: removal lacks explicit user authority/);
  for (const disposition of ["ABANDONED", "DEFERRED", "OWNER_DECISION"]) {
    const spec = base();
    spec.rows[1].disposition = disposition;
    assert.deepEqual(reviewContract(spec).handoffs, ["B (" + disposition + ")"]);
  }
});

test("contract: amendment C invalidates the prior revision until reconciled", () => {
  const spec = base();
  spec.revision = 2;
  spec.required.push("C");
  assert.match(gaps(spec), /stale revision/);
  assert.match(gaps(spec), /C: missing row/);
});

test("contract: acceptance constraints count while optional ideas do not", () => {
  const spec = base();
  spec.required.push("NO_WRITE");
  spec.rows.push({ id: "NICE_TO_HAVE", owner: "", observation: "", disposition: "ACTIVE", revision: 1 });
  assert.match(gaps(spec), /NO_WRITE: missing row/);
  assert.doesNotMatch(gaps(spec), /NICE_TO_HAVE/);
});

test("contract: a table cannot pass without the current request denominator", () => {
  const spec = base();
  spec.rows = [spec.rows[0]];
  assert.notDeepEqual(reviewContract(spec).gaps, []);
});

// ------------------------------------------------------ plan-check on disk

const PLAN = (rows, revision = 1) => `# Plan: import

## Current contract inventory

Contract revision: ${revision}.

| ID | Required outcome or constraint | Owner | Observing gate or manual review | Disposition | Revision |
|---|---|---|---|---|---|
${rows.join("\n")}

## Tree

- 1 import .............. GATES.md
  - 1.1 parser .......... gates/node-1.1.md
    - 1.1.1 reader ...... gates/leaf-1.1.1.md
    - 1.1.2 writer ...... gates/leaf-1.1.2.md

## Leaf dispatch table

| Leaf | Owns | Needs | Tier | Planned wave | State |
|---|---|---|---|---|---|
| 1.1.1 | src/read/** | - | judgment | 1 | VERIFIED |
| 1.1.2 | src/write/** | 1.1.1 | mechanical | 2 | READY |

## Status log
`;

const LEDGER = (id) => `# Gates: ${id}\n\n- [ ] G1: ${id} fixture imports completely\n  CHECK: node verify.mjs\n  EXPECT: /^verified$/m\n  EVIDENCE: pending\n`;

function planFixture(rows, revision) {
  const directory = mkdtempSync(join(tmpdir(), "unlazy-plan-"));
  mkdirSync(join(directory, "gates"));
  writeFileSync(join(directory, "PLAN.md"), PLAN(rows, revision));
  for (const stem of ["leaf-1.1.1", "leaf-1.1.2", "node-1.1"]) writeFileSync(join(directory, "gates", stem + ".md"), LEDGER(stem));
  writeFileSync(join(directory, "GATES.md"), LEDGER("GATES"));
  return directory;
}

async function planCheck(rows, args = [], revision = 1) {
  const directory = planFixture(rows, revision);
  try {
    return await runNode(PLAN_CHECK, [...args, join(directory, "PLAN.md")]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const GOOD = [
  "| C1 | reader imports valid records | leaf-1.1.1 | leaf-1.1.1:G1 | ACTIVE | 1 |",
  "| C2 | writer never mutates input | 1.1.2 | manual: reviewer reads src/write/index.mjs | ACTIVE | 1 |",
];

test("plan-check: a reconciled plan with live gates and a manual review prints PLAN OK", async () => {
  const result = await planCheck(GOOD, ["--require", "C1,C2"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /^PLAN OK \(0 finding\(s\), 0 handoff\(s\)\)$/m);
});

test("plan-check: without --require it says omissions are undetected", async () => {
  const result = await planCheck(GOOD);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /omitted contract rows are not detected without --require/);
});

test("plan-check: an omitted required row, a stale gate, and an unknown owner are findings", async () => {
  const result = await planCheck([
    "| C1 | reader imports valid records | leaf-9.9.9 | leaf-1.1.1:G7 | ACTIVE | 1 |",
  ], ["--require=C1,C2"]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.stdout, /FINDING C1: missing or stale owner/);
  assert.match(result.stdout, /FINDING C1: missing or stale observation/);
  assert.match(result.stdout, /FINDING C2: missing row/);
  assert.match(result.stdout, /^PLAN FINDINGS/m);
});

test("plan-check: a deferred row is a handoff, not PLAN OK", async () => {
  const result = await planCheck([GOOD[0], "| C2 | writer never mutates input | 1.1.2 | manual: pending | DEFERRED | 1 |"]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.stdout, /HANDOFF C2 \(DEFERRED\)/);
  assert.match(result.stdout, /^HANDOFF REQUIRED/m);
});

test("plan-check: removal needs quoted user authority", async () => {
  const quoted = await planCheck([GOOD[0], "| C2 | csv export | driver | user: \"drop csv export\" | REMOVED_BY_USER | 1 |"]);
  assert.equal(quoted.code, 0, quoted.out);
  const bare = await planCheck([GOOD[0], "| C2 | csv export | driver | decided in chat | REMOVED_BY_USER | 1 |"]);
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.stdout, /C2: removal lacks explicit user authority/);
});

test("plan-check: an amendment leaves earlier rows stale until restamped", async () => {
  const result = await planCheck(GOOD, [], 2);
  assert.equal(result.code, 1, result.out);
  assert.match(result.stdout, /C1: stale revision/);
});

test("plan-check: template placeholders and a broken dispatch table are findings", async () => {
  const result = await planCheck([
    "| C1 | <concise paraphrase> | <leaf/node> | <qualified gate/reviewer> | ACTIVE | 1 |",
  ]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.stdout, /unreplaced placeholder in outcome/);
  const directory = planFixture(GOOD, 1);
  try {
    const plan = join(directory, "PLAN.md");
    writeFileSync(plan, PLAN(GOOD).replace("| 1.1.2 | src/write/** | 1.1.1 | mechanical | 2 | READY |",
      "| 1.1.2 | src/write/** | 1.1.1 | mechanical | 1 | READY |"));
    const broken = await runNode(PLAN_CHECK, ["--json", plan]);
    assert.equal(broken.code, 1, broken.out);
    const parsed = JSON.parse(broken.stdout);
    assert.equal(parsed.verdict, "PLAN FINDINGS");
    assert.ok(parsed.findings.includes("1.1.2 is not planned after 1.1.1"), broken.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plan-check: usage errors exit 2 and repository text is escaped", async () => {
  const none = await runNode(PLAN_CHECK, []);
  assert.equal(none.code, 2);
  const unknown = await runNode(PLAN_CHECK, ["--nope", "PLAN.md"]);
  assert.equal(unknown.code, 2);
  const badRequire = await runNode(PLAN_CHECK, ["--require", "C 1", "PLAN.md"]);
  assert.equal(badRequire.code, 2);
  const hostile = await planCheck(["| C1" + ESC + "[2J | x | driver | manual: ok | ACTIVE | 1 |"]);
  assert.ok(!hostile.stdout.includes(ESC), hostile.stdout);
  assert.match(hostile.stdout, /\\x1b/);
});

test("plan-check: the library skips gate observations it cannot locate", () => {
  const { problems } = contractProblems(PLAN(GOOD));
  assert.deepEqual(problems, []);
});

process.exit(await runSuite(tests, { filter: process.argv[2] || "" }));
