# Gates: <leaf or task name>

OWNS: <repository-relative globs this leaf may write, for example src/api/**, tests/api/**>

Summary: <one sentence describing the complete deliverable>

- [ ] G1: <observable outcome measured directly from the artifact>
  CHECK: node scripts/verify-outcome.mjs
  EXPECT: outcome verification passed
  EVIDENCE: pending

- [ ] G2: <integration outcome in a subproject>
  CHECK: node scripts/verify-integration.mjs
  EXPECT: integration verification passed
  CWD: packages/example
  EVIDENCE: pending

- [ ] G3: <manual outcome that no command can decide>
  EVIDENCE: pending

<!--
Replace every placeholder before running the checker.

Workflow, where <skill-dir> is the directory holding SKILL.md:
- lint: node <skill-dir>/scripts/gate-lint.mjs --strict GATES.md
- list each oracle and its token: node <skill-dir>/scripts/gate-check.mjs --review GATES.md
- approve what you read, then run: node <skill-dir>/scripts/gate-check.mjs --approve=<tokens> GATES.md
- before every report and commit: node <skill-dir>/scripts/gate-check.mjs --reverify GATES.md

Strict format:
- Use a unique explicit id for every gate.
- Indent CHECK, EXPECT, CWD, and EVIDENCE directly under their gate, with no
  blank line or prose in between.
- Give a runnable gate both CHECK and EXPECT; give a manual gate neither.
- Success requires process exit 0 and EXPECT.
- Make EXPECT a success-only marker produced after every assertion passes, and
  anchor a pattern to it, for example /^outcome verification passed$/m.
- For an absence or negative assertion, test the same checker against a known
  positive fixture and record that control in the gate's manual review.
- Measure supplied figures from source. Do not copy a supplied number into
  EXPECT as its own proof.
- Prefer the project's own test runner. Add a verifier script only when no
  existing command observes the outcome, place it beside the project's tests,
  and quote any path that contains spaces.
- Declare any non-default shell or external tool requirement explicitly.
- Scoped and legacy discovery anchor checks at the repository root. When this
  ledger is named explicitly from `.unlazy/`, pass an explicit repository
  `--root` and `--cwd` so repository-relative commands keep the same base.
- Record exact manual evidence that cites the artifact and location. A manual
  gate you certify yourself is reported as self-certified.
- OWNS paths must be repository-relative, complete, and disjoint from every
  concurrently dispatched leaf. Claims coordinate writers; they do not sandbox.
- Keep a solo GATES.md untracked unless the user wants it committed.

If a gate cannot be finished, keep the gate and add one line at column 1:

```text
ABANDON: G<n> <specific reason the outcome is impossible>
ABANDON: G<n> DEFERRED: <what it waits on>
ABANDON: G<n> OWNER_DECISION: <the question for the user>
```

Each is a non-successful handoff; surface it by id in the final report. Put an
optional or out-of-scope edge case in the report's Risks section instead. See
references/gates.md.
-->
