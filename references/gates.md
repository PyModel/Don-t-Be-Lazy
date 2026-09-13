# Gate file format

A gate ledger is a machine-checked completion contract. The checker and Stop hook use the same strict parser. Invalid structure fails closed instead of producing a completion certificate.

## Minimal format

```markdown
# Gates: account import

OWNS: src/import/**, tests/import/**

Summary: import valid records and reject malformed records

- [ ] G1: valid fixture imports completely
  CHECK: node scripts/check-import.mjs fixtures/valid.json
  EXPECT: /^import verification passed$/m
  EVIDENCE: pending

- [ ] G2: package-level integration succeeds
  CHECK: node ../../scripts/check-package.mjs
  EXPECT: package verification passed
  CWD: packages/importer
  EVIDENCE: pending

- [ ] G3: migration wording is reviewed against the product decision
  EVIDENCE: pending

ABANDON: G3 OWNER_DECISION: keep or drop the legacy wording; asked in issue 123
```

The fenced example above is documentation. Lines inside fenced code blocks are ignored by the parser. Fence boundaries follow [CommonMark's fenced-code rules](https://spec.commonmark.org/0.30/#fenced-code-blocks): the closing marker uses the same character, is at least as long as the opener, has no trailing content, and may have up to three leading spaces.

## Strict parsing rules

- Start a gate with `- [ ] ID: outcome` or `- [x] ID: outcome` at column 1 with single spaces. Use a non-empty explicit id that is unique within the file; line-derived identifiers are not stable when lines move. Any other line shaped like a Markdown checkbox is an error, so a near miss cannot silently drop a gate.
- Indent `CHECK:`, `EXPECT:`, `CWD:`, and `EVIDENCE:` in uppercase directly beneath their gate. A blank line, heading, or prose line ends the gate's attribute block: an attribute after it is an orphan and an error. An unindented, lowercase, misspelled, or duplicated attribute is also an error, never a silent change to a manual gate.
- Give a runnable gate both a non-blank `CHECK:` and `EXPECT:`. Give a manual gate neither.
- Use one `EVIDENCE:` line per gate. If it is missing from an otherwise valid gate, the checker inserts it. Updates keep the file's newline style, byte-order mark, and file mode.
- Put the optional `OWNS:` header at column 1 before the first gate. Separate paths with commas. Paths are repository-relative globs; absolute paths and `..` segments are invalid.
- Write `ABANDON:` at column 1, once per gate, for a gate in the same file, with a reason that contains non-whitespace text. An unknown id is an error, because silently ignoring a typo could let an otherwise green child promote its parent. An indented `ABANDON:` is diagnosed rather than applied.
- Keep text visible. A line containing a control character, zero-width space, soft hyphen, line or paragraph separator, or bidirectional control is an error, because the text a reviewer reads would differ from the text the parser acts on. A byte-order mark at the start of the file is allowed and preserved.
- Do not define a ledger with zero gates. A named empty or malformed ledger is a parse error, not `ALL MET`.
- Use `/pattern/flags` for a JavaScript regular-expression expectation or plain text for a substring. An invalid regular expression is an error, and so is a pattern that matches empty output, because a silent command would pass it. Anchor a pattern to a success marker, such as `/^tests passed$/m`.
- Remember that the wrapping slashes always win. `EXPECT: /etc/app/conf/` is the pattern `etc/app/conf`, not that literal path, so its dots match any character. An unescaped inner slash is warned because both readings are plausible. Escape the inner slashes to keep the pattern, or drop the wrapping slashes and match a distinctive substring such as `etc/app/conf`.
- Keep `CWD:` repository-relative. An absolute `CWD:` or one that climbs with `..` is warned, because it ties approvals and evidence to one machine.

Ids are unique within one file. Tools qualify them in tree-wide output with the file stem, such as `leaf-1.2.1:G3` or `node-1.1:N2`, and with the relative path when two ledgers share a stem. Use the qualified form in reports and handoffs.

## Handoffs

A handoff keeps an unfinished gate visible without counting it as met. Three kinds share the `ABANDON:` line:

```text
ABANDON: G4 upstream API removed the endpoint this gate measures
ABANDON: G5 DEFERRED: retry backoff needs the queue client from leaf-1.2.1
ABANDON: G6 OWNER_DECISION: keep or drop the legacy CSV importer
```

The first line is `ABANDONED`: the outcome is impossible within the authorized task. `DEFERRED` waits on something outside the task. `OWNER_DECISION` needs the user to choose. Every kind is a terminal handoff, not success: `gate-check` prints `HANDOFF REQUIRED` with a count per kind and exits `1` even when every other gate is met. The Stop hook blocks once with the qualified ids, never the free-form reason, and allows later stops. Never promote a handed-off child through a parent `ALL MET` oracle or describe the task as complete. An optional or out-of-scope edge case belongs in the report's Risks section, not in a handoff.

## Success and evidence

A runnable gate passes only when both conditions hold:

1. The process starts and exits with status `0`.
2. `EXPECT:` matches the command's combined standard output and standard error.

A nonzero process never passes merely because its error text contains the expected token. A timeout, shell-start error, missing command, or output-limit failure also fails. The default timeout is 120 seconds; `--timeout` accepts an integer from 1 through 86400. Cleanup and checker settlement are bounded, but a deliberately detached process may outlive its timed-out shell because unlazy is not a process sandbox; checks must clean up any background services they intentionally detach. Each check has two 1 MiB ceilings: first on the total raw stdout and stderr payload captured, then on the UTF-8 byte length of the canonical matcher string. That string is all captured stdout decoded as UTF-8, one synthetic newline when both streams are nonempty, then all captured stderr decoded as UTF-8. `EXPECT:` and the evidence SHA-256 and byte count use that exact string. Invalid byte replacement or the stream separator can make the second representation larger than the raw payload; it fails as overflow and is never truncated into a match. Regular-expression matching uses at most four disposable workers; each gets a five-second startup limit before its separate 250ms match budget begins.

Checker-written evidence is one line:

```text
EVIDENCE: automatic-evidence=v1; definition-sha256=<64 hex>; exit=0; EXPECT=matched; output-sha256=<64 hex>; output-bytes=<N>; shell=<shell>; cwd=<repository-relative directory>; path=<12 hex>/<N> entries; inputs=<file>@<12 hex>
```

The definition digest is a full lowercase SHA-256 of the parsed `CHECK:`, `EXPECT:`, and raw `CWD:`. It excludes the gate id and title, formatting, ledger path, resolved paths, shell, timeout, platform, and `PATH`. The exit status, match result, output digest, and byte count follow immediately and are validated; the shell, working directory, `PATH` digest, and bound-input digests after them form a capped transcript. Raw successful output and the full `PATH` are never persisted. Failure diagnostics are bounded, terminal-only, and control-stripped.

A checked runnable gate is met only when that exact v1 definition binding and the canonical `exit=0; EXPECT=matched` header are present. Missing, blank, `pending`, ordinary prose, pre-v1, malformed, future-version, nonzero-exit, unmatched, or mismatched runnable evidence is `stale-unmet`; a normal run schedules it for the usual approval lookup, and a successful run migrates it. The digest is unkeyed drift detection, not authenticity: a ledger editor can forge a canonical header. A failed stale rerun clears the box and restores `EVIDENCE: pending`. Manual gates keep ordinary human evidence, but reserved v1 evidence and the legacy `exit=0; shell=` transcript stay machine evidence if a runnable gate becomes manual. Adding a runnable definition to a human-attested manual gate makes that old evidence stale.

`--status` parses and reports recorded state without executing a command or changing a file, and reminds you that it reads recorded evidence only. It validates the definition binding without resolving a shell, reading approval storage, or depending on `PATH`, timeout, or other runtime options. The Stop hook uses the same non-executing state model. Neither inspects current artifacts or transitive inputs, and a plain run skips gates already met. Before reporting or committing, and for parent verification, use `--reverify`: it executes every runnable gate, including gates already checked, and returns a gate to unmet when its oracle no longer passes. Its summary reports all commands rerun and the subset that had previously been met.

Every summary lists each unmet, self-certified, and handed-off gate by qualified id, never truncated, and ends with a `measured at` timestamp. A met manual gate is reported as `SELF-CERTIFIED`, because its evidence was written by hand. `--json` prints the same result as one JSON object on stdout, with counts, per-gate states, and `measuredAt`, and moves the transcript to stderr.

## Approval boundary

`CHECK:` is executable shell code with the permissions and inherited environment of the checker. Parse an inherited ledger with `--status` and read its source, then review and approve:

```text
node <skill-dir>/scripts/gate-check.mjs --review GATES.md
node <skill-dir>/scripts/gate-check.mjs --approve=<tokens> GATES.md
```

`--review` prints every runnable oracle with its resolved working directory, shell, `PATH` digest, the repository files whose bytes the approval binds, and a 16-character token, and it never executes. `--approve=<tokens>` approves exactly those tokens and then runs; any other unapproved oracle stays unexecuted. A plain run prints the same review block for each unapproved oracle and exits `4`. When the store already holds an approval for the same gate, the review names the fields that changed, such as `path` or `inputs`.

Approval is deliberately separate from the evidence digest. Approval decides whether this runtime oracle may execute here, and it binds the resolved environment and the bytes of up to 16 repository files named in `CHECK:`. The definition digest decides whether recorded evidence describes the current parsed definition. Approval does not trace transitive inputs: a byte change in a file that a named script imports can still run under an existing approval. Reinspect such changes and run `--reverify`. Approval confirms that a command may run; it does not prove that the command measures the English outcome. [../SECURITY.md](../SECURITY.md#what-an-approval-binds) holds the complete binding list, the store rules, and the threat model.

## Shell, PATH, and working directory

The checker resolves its shell in this order:

1. `--shell <path-or-name>`, where a bare name resolves only through absolute `PATH` entries
2. `UNLAZY_SHELL`
3. `/bin/sh` on Unix, or `process.env.ComSpec` on Windows with `cmd.exe` as the fallback name

The child process inherits the checker's environment, including `PATH`. Node documents that shell commands use the platform shell and inherited environment; Microsoft documents that `cmd.exe` searches the current directory and then `PATH` for executable extensions. Launching the checker from Git Bash can therefore expose tools that the same command launched from PowerShell does not. A shell override changes the interpreter, not the installed programs or inherited `PATH`.

Prefer the project's own test runner, or a repository-owned Node script, in portable gates:

```markdown
  CHECK: node scripts/verify-output.mjs
  EXPECT: /^output verification passed$/m
```

Do not assume stock Windows provides `grep`, `tail`, `tr`, `sed`, or POSIX pipeline behavior. If a gate intentionally needs a particular shell or external tool, declare that prerequisite and use the same shell and toolchain during parent re-verification.

`CWD:` is resolved relative to the checker's default working directory. Set that default with `--cwd`. Without `--cwd`, explicitly named ledgers anchor beside that ledger, while scoped and legacy discovery anchor at `--root`. Keep `CWD:` repository-relative. The resolved directory and its identity are part of approval, and evidence records the directory relative to the repository.

Primary platform references:

- [Node.js child process documentation](https://nodejs.org/api/child_process.html#child_processexeccommand-options-callback)
- [Microsoft `path` documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/path)

## Author gates that can fail

The checker validates a declared oracle. It cannot infer whether unrestricted English and unrestricted shell code mean the same thing. `G1: invoices reconcile` plus `CHECK: node -e "console.log('ok')"` is syntactically valid and semantically useless.

- **Observe the outcome directly.** Make the check read the artifact, service, or measurement named by the title.
- **Emit a success-only marker.** Let the script perform all assertions, exit nonzero on any failure, and print the expected marker only after every assertion passes.
- **Test negative controls.** Before trusting an absence check, run the same logic against a known positive fixture and confirm that it fails. A missing file, wrong path, or malformed pattern can otherwise look like valid absence.
- **Measure supplied numbers independently.** Do not make a number copied from the brief its own expectation. Make the script calculate the value from source data, apply the acceptance rule, and print a separate success marker.
- **Prefer the project's own runner.** In a repository that already has a test command, call it with a filter instead of adding a Node verifier. Place any new verifier script beside the project's tests, and quote a path that contains spaces.
- **Review consequential manual gates by risk.** A contributor's single 17-gate course audit found that its only manual gate was also its most consequential. Use that observation as a prompt for stronger review, not as evidence of a general correlation between checkability and risk. Cite exact evidence and obtain a second review when the consequence warrants it.
- **Keep evidence decisive.** Automated successful evidence stores an output fingerprint, not raw output. For manual gates, record the smallest non-sensitive fact that proves the outcome, with its artifact and location; do not paste full logs into a ledger.

### Lint the ledger before working it

`gate-lint.mjs` makes the mechanical subset of these rules checkable. It never executes a `CHECK:`; it reads the ledger and the files named in its evidence.

```text
node <skill-dir>/scripts/gate-lint.mjs GATES.md
node <skill-dir>/scripts/gate-lint.mjs --strict --json .unlazy/<scope>/gates/leaf-1.1.1.md
```

Its warnings are lexical signals, each with an id:

- `tautological-check`: the command only prints a fixed output, including `echo` behind `true &&` or `cmd /c` and `node -e` that logs a string literal
- `lenient-lint-gate`: a gate runs `gate-lint` without `--strict` and without the anchored `/^LINT OK$/m` marker, so it passes while warnings remain
- `masked-exit`: the command can exit zero after its real command fails, as with `|| true` or a trailing `echo`
- `echoes-expect`: the command prints its own expectation after a separator
- `reads-own-ledger`: the command reads its own ledger instead of the artifact
- `weak-expect`, `short-expect`, `match-anything`: the expectation also appears in failure output, is short enough to appear anywhere, or matches arbitrary short output
- `path-read-as-regex`: a slash-wrapped path is read as a regular expression
- `unreplaced-placeholder`: a template placeholder remains
- `cwd-outside-repository`: `CWD:` is absolute or climbs out of the repository
- `input-changed-after-evidence`: a file named in the evidence changed since it was recorded
- `activity-not-outcome`: the title names an activity instead of an outcome a stranger could judge
- `manual-gate`, `unmeasured-number`, `uncited-manual-evidence`: a gate is manual, states a number nothing measures, or cites no artifact
- `mostly-manual`: most gates in the ledger are manual

The linter does not shell-parse commands, so a warning does not prove an oracle is wrong and silence does not prove it can fail. Default mode prints the findings plus `LINT OK` or `LINT OK (<N> warning(s))` and exits `0`. `--strict` treats every warning as a failure, prints `LINT FINDINGS`, and exits `1`. Exit `2` is a usage or parse error.

An all-runnable ledger can require its own quality by linting itself as a gate:

```markdown
- [ ] G0: this ledger states outcomes that can fail
  CHECK: node "<skill-dir>/scripts/gate-lint.mjs" --strict GATES.md
  EXPECT: /^LINT OK$/m
  EVIDENCE: pending
```

Write `<skill-dir>` as the absolute path. That path is part of the definition digest and the approval, so the gate is specific to one machine. Every manual gate raises `manual-gate`, so strict lint fails any ledger that has one; for such a ledger, lint at authoring time and review each warning instead of gating on it.

## Leaf gates versus branch gates

Place a gate where its evidence lives. A leaf ledger proves one leaf, so give it
only gates that read that leaf's own artifact and that its declared `OWNS:` paths
can satisfy alone. A parent re-verifies a returned leaf by naming its exact
ledger; a whole-project check smuggled into a leaf therefore makes every per-leaf
`--reverify` re-run the entire tree instead of the one leaf that returned.

Cross-cutting outcomes belong in the branch ledger, where they run once after all
named children return: interface compatibility, end-to-end behavior, and
regression across the joined work. `templates/gates-node.md` reserves `N1`
through `N6` for exactly these. A regression or end-to-end gate duplicated in
each leaf is both slower and weaker evidence than the single branch gate that
observes the composed result.

## Concurrency

Use `OWNS:` only as part of the coordination protocol in [parallel.md](parallel.md). It does not restrict a command's filesystem access. Concurrent leaves must declare disjoint paths, claim them before dispatch, and release them after verification.
