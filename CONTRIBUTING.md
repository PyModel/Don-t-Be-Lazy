# Contributing

Thanks for improving unlazy. Keep changes focused, testable, portable, and honest about their evidence.

## Welcome changes

- parser, checker, hook, installer, concurrency, and portability fixes
- sharper gate-authoring or orchestration guidance
- regression tests for reported behavior
- recent research that directly supports a narrowly worded claim
- compatibility fixes for agents that consume `SKILL.md`

## Ground rules

1. **Keep enforcement structural.** Completion is decided by valid ledgers, current evidence, parent re-verification, and integration checks.
2. **Treat the format as one contract.** A ledger-format change must update the shared parser, checker, hook, linter, `scripts/plan-check.mjs` where it applies, templates, references, and tests together.
3. **Fail closed on malformed completion state.** Invalid input must not become `ALL MET` or a silent Stop-hook allow unless the documented security boundary requires a diagnostic allow.
4. **Treat `CHECK:` as code.** Preserve review tokens, exact approval binding, approval invalidation, and non-executing status and review behavior. Do not weaken the trust boundary for convenience. Update the binding list in `SECURITY.md`, its single source, when approval identity changes.
5. **Keep Node 16.0.0 compatibility and zero runtime dependencies.** Use only standard-library APIs available in Node 16.0.0; CI runs the suite on exactly that version. Test Windows, macOS, and Linux behavior when changing shell, path, newline, file-lock, or installer code.
6. **Make claims exact.** Use primary research or official platform documentation when available. Distinguish a checkpoint metric from end-to-end success, an overall fit from a subset fit, and exploratory observations from reproducible results.
7. **Keep skill metadata valid.** `SKILL.md` frontmatter contains only `name` and a trigger-rich third-person `description`. Keep `agents/openai.yaml` aligned and do not add icon paths without real assets.
8. **Use imperative skill prose and progressive disclosure.** Keep the core workflow in `SKILL.md`; put detailed contracts in directly linked references.
9. **Keep documented commands executable.** Write tool invocations as `node <skill-dir>/scripts/<tool>.mjs` with flags that the tool's `--help` lists.
10. **Use no dash-like punctuation.** No em dash, en dash, figure dash, horizontal bar, or minus sign; use a hyphen, colon, or sentence break.
11. **Preserve unrelated user configuration.** Installer changes must validate container shapes, update atomically, and remove only unlazy's own handlers.

## Tests

Install no dependencies. Run:

```text
npm test
```

Every suite in `tests/` uses the shared harness in `tests/lib/harness.mjs`. `runSuite` gives each test a timeout, prints `SKIP` separately and never counts a skip as a pass, and prints full failure stacks. `cleanEnv` strips `UNLAZY_*` and `CLAUDE_PROJECT_DIR` from child processes, so a developer's configuration cannot change results. `reviewAndRun` drives the documented review-then-approve flow and fails when review output cannot be parsed. Pass a substring to run a subset, for example `node tests/remediation-tests.mjs hook:`.

For script changes, add a regression that fails before the fix, then break the guarded code once and confirm that a test fails. Cover the relevant adversarial boundaries, including:

- explicit one-file and multi-file targeting in different option orders
- status versus re-verification and changed-oracle invalidation
- zero gates, duplicates, orphan and malformed attributes, invisible characters, fences, indentation, CRLF, byte-order marks, and abandonment reasons
- handoff kinds as non-successful checker, parent, and Stop outcomes, with bounded host messages
- exit `0` plus `EXPECT:`, expectations that match empty output, timeouts, missing commands, output limits, and evidence insertion
- review tokens, partial and refused approvals, exit `4`, and approval rebinding when `PATH`, directory identity, platform, or named input bytes change
- the approval store outside the repository, its permissions, and list, revoke, and prune
- platform shell defaults, explicit shell override, inherited `PATH`, and paths containing spaces
- signals, stale locks, missing working directories, and Windows process-tree cleanup with helper failure and timeout settlement
- sequential default and deterministic bounded `--jobs`
- simultaneous conflicting lease claims, conservative and normalization-aware glob overlap, unsafe paths, invalid lease records, unknown leaves, and release
- concurrent gate updates and concurrent session-keyed hook state in both stores
- native dispatch open, start, seal, return, and abandon, lease requirements, clock steps, and semantic progress hashing
- PLAN contract omissions, stale owners and observations, amendments, explicit removal, placeholders, and the focused solo path
- Stop-hook block, progress reset, six-block release, directory changes, deleted ledgers, runnable-to-manual downgrades, one-time handoffs and notices, malformed payloads, and session routing
- installer install, idempotence, moved paths, symlinked settings, target-shape refusal, unrelated-handler preservation, `--verify`, and uninstall

`tests/self-check.mjs` runs last in `npm test`. It rejects non-standard-library imports and post-16.0 APIs, checks every documented tool invocation against that tool's `--help`, confirms that every resource `SKILL.md` names exists, scans repository text for dash-like punctuation, and runs behavioral checks of approval binding and handoffs. CI also runs `node --check` on every script. Keep tests deterministic and isolated from real user settings.

## Documentation changes

For a behavioral claim, link the exact source and state only what it supports. Keep the README source list ordered by the latest public version or publication date. If a source has no date, label it instead of guessing.

Do not add new benchmark ratios without the artifacts and calculation script needed to reproduce them. Follow [research/validation-protocol.md](research/validation-protocol.md).

## Security reports

Read [SECURITY.md](SECURITY.md). Do not publish credentials or a sensitive proof of concept in a public issue.

## Pull requests

Explain the failure, the contract after the change, and the exact regression evidence. Keep unrelated refactors out of the patch. Update `CHANGELOG.md` under the unreleased target when user-visible behavior changes, and credit contributors by GitHub handle.
