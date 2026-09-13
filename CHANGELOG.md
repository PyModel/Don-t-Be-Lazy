# Changelog

## Unreleased, target 2.1.0

This section describes the current source tree. It does not claim that `2.1.0` has a Git tag or GitHub Release.

### Summary

- Ledgers are strict: a malformed ledger, an invisible character, an orphan attribute, or an expectation that matches empty output fails closed instead of certifying completion.
- Nothing executes without review. `--review` prints each oracle with a token, `--approve=<tokens>` approves exactly those tokens, and an approval binds the full runtime oracle, including the bytes of repository files the command names.
- `--reverify` re-executes met gates, evidence is bound to the gate definition, and every summary lists each remaining id with a measurement time.
- Handoffs (`ABANDONED`, `DEFERRED`, `OWNER_DECISION`) are visible non-completion that never promotes a parent.
- Scoped pipelines, ownership leases, native dispatch waves, and a checked PLAN contract support orchestrated and parallel work.
- The optional Claude Code Stop hook keeps per-session state outside the repository, and within a session it keeps blocking when a ledger with unmet gates is deleted or a runnable gate is rewritten as manual.
- Reporting and engineering references define what a report may claim and what the oracles for changed code must cover.

### Changes that need action

- `--approve` takes the tokens printed by `--review`: `--approve=<tokens>`. A bare `--approve` exits `2`.
- An oracle that still needs approval exits `4` instead of `1`.
- Approval records written by earlier builds of this unreleased source are outdated. Review and approve again; `--prune-approvals` removes the old records.
- Automatic evidence written before definition binding is stale until the gate runs again.
- Stop-hook state moved out of the repository to `~/.unlazy/hook-state`. Delete any leftover `.unlazy-hook-state.json` or `.unlazy/<scope>/hook-state.json`.
- The Stop hook no longer routes a session to the only scope present. Bind the session with `--bind` or pin the install with `--scope`.
- Leaf and branch ledger templates name the deliverable sentence `Summary:` instead of `Scope:`.
- CI runs on pushes to `main` and on pull requests.

### Audit remediation

Approval and execution:

- Add `--review`, which lists every runnable oracle with its approval state and a 16-character token without executing or writing. `--approve=<tokens>` approves exactly the named tokens; bare, empty, malformed, and unknown tokens exit `2`, and an oracle that still needs approval exits `4`.
- Bind approvals to the device and inode of the working directory and of the ledger's directory, and to the SHA-256 of up to 16 repository files named in `CHECK:`, skipping generated and dependency directories. Review names the fields that differ from the nearest prior approval for the same gate, and `--show-path` lists every `PATH` entry.
- Add `--list-approvals`, `--revoke <tokens>`, and `--prune-approvals`. A store with group or other access fails with a `chmod 700` remediation, and a ledger under the home directory can use the default store.
- Resolve a bare `--shell` name only through absolute `PATH` entries.
- On SIGHUP, SIGINT, or SIGTERM, stop running checks, keep results that finished, and exit `129`, `130`, or `143`.
- Stop before any check runs when a ledger lock is stale, anchor an explicit ledger's lock beside the ledger, and fail only the gate whose `CWD:` is missing.

Parsing and evidence:

- Reject lines with invisible or control characters, checkbox-like lines that are not strict gates, attributes separated from their gate, and `EXPECT:` patterns that match empty output. Warn when `CWD:` is absolute or climbs out of the repository.
- Count automatic evidence as current only with exit `0` and a matched expectation, record the working directory relative to the repository, and list bound inputs.
- Preserve file mode, CRLF newlines, and a byte-order mark on rewrite, and never follow or replace a colliding temporary file.
- List every unmet, self-certified, and handed-off id in summaries, count handoffs by kind, print `measured at`, remind `--status` users to re-verify before reporting, and add `--json`.
- Qualify ledgers that share a file stem by relative path, and accept only plain in-range integers for numeric options.

Linting:

- Warn on masked exits, an expectation echoed after `;`, a check that reads its own ledger, short and match-anything expectations, unreplaced placeholders, uncited manual evidence, and verifier files changed after their evidence. Treat `echo` behind `true &&` or `cmd /c` and `node -e` that only logs a literal as fixed-output commands, and warn on a lint self-gate that lacks `--strict` or an anchored marker. Stop flagging noun-led outcome titles and version numbers.

Leases and dispatch:

- Compare lease paths after Unicode normalization, and without regard to case on case-insensitive filesystems. Add `--release-invalid` for lease records that fail validation.
- Require a ledger and a claimed lease for every leaf before `open`, keep transition timestamps monotonic when the wall clock steps back, and stop blocking Stop once a wave is sealed.

Stop hook:

- Keep progress state per session under `~/.unlazy/hook-state`, with an owner-private temporary fallback that completion also clears, so the hook writes nothing into repositories.
- Find pipelines from the session's current directory, `CLAUDE_PROJECT_DIR`, and the nearest ancestor with unlazy state, so a directory change does not disable enforcement.
- Enforce only the legacy ledger, the pinned scope, and scopes bound to the session. An unbound scope with unmet work blocks once with a notice naming its `--bind` command.
- Remember, per session, which gates were runnable and which ledgers had unmet gates, and keep blocking when a runnable gate becomes manual or such a ledger disappears.
- Block once per handoff, put the final-report instruction into the last no-progress block, count ledger parse errors toward the no-progress release, hash ledger names that are not safe labels, allow malformed payloads with a diagnostic, key sessions without a `session_id` by transcript, and bound the reason's id list.

Installer:

- Add `--verify`, which runs the installed hook and reports `OK`, `BROKEN`, or `NOT INSTALLED`. Record the skill path as invoked, warn about a version-managed Node, uncommitted changes, and an untagged checkout, follow a symlinked settings file, replace the handler in place, and keep the first backup.

Planning, tests, documentation, and CI:

- Add `scripts/plan-check.mjs`, which checks a PLAN's dispatch table, tree, and contract inventory, including owners, observations, `manual:` reviews, `user:` removal authority, revisions, and placeholders, without executing anything.
- Share one test harness with per-test timeouts, separate skip reporting, full failure stacks, and a scrubbed environment. Add a behavior suite for the remediation, check documented tool invocations against each tool's `--help`, and scan all repository text for dash-like punctuation and post-16.0 APIs.
- Rewrite `SKILL.md` around a numbered solo loop, one approval rule, handoff kinds, a host enforcement table, and a short report form. Make `SECURITY.md` the single approval binding list, with a threat table and a section on what unlazy cannot stop. Soften README claims until an effectiveness evaluation exists, and describe that evaluation in `research/validation-protocol.md`.
- Add a CI concurrency group, a Node 16.0.0 lane, a syntax check step, version comments on pinned actions, and Dependabot updates for actions.

### Engineering standard

- Add `references/engineering-standard.md`, scoped to the code a task changes or owns: record a baseline of the project's checks before the first edit, cover each applicable boundary row with its named proving artifact or report it `unverified`, gate edge cases inside the contract and list the rest as risks, end review rounds at a fixed limit, produce named artifacts before an authorized commit, record handoffs in the ledger, and complete an audit when every finding is recorded with evidence.
- Point `SKILL.md` and `references/token-economy.md` at the standard, add a risks, trade-offs, and limits section to `templates/REPORT.md`, and self-check the standard's structure rather than its wording.

### Truthful reporting

- Add `references/reporting.md` and `templates/REPORT.md`: the final report copies counts from a `--reverify` run taken immediately before writing, lists every unmet, abandoned, deferred, owner-decision, and not-started item by qualified id without "+N more", reports self-certified manual gates, reports commands that did not run as `not run` and read-only claims as `unverified`, labels hypotheses until a check in the session confirms or refutes them, and names the specific cause when part of a task cannot be done while the rest is finished.
- Make the Stop hook's block and six-block release messages state that only measured state may be reported and that unmet gates are never described as done.
- Add a self-check that the skill, reference, template, and hook carry those disclosures.

### Gate authoring

- Add `scripts/gate-lint.mjs`, a non-executing advisory audit of ledger quality. Warn on fixed-output commands, masked exits, echoed expectations, weak or match-anything expectations, path-shaped regular expressions, unreplaced placeholders, activity titles, unmeasured manual numbers, uncited manual evidence, inputs changed after evidence, and mostly manual ledgers, without pretending to shell-parse commands. Default warnings retain a `LINT OK` marker and exit `0`; `--strict` makes them fail. Reject unknown options, bound ledger reads, refuse linked or special-file inputs, escape terminal, line-separator, and bidirectional controls, and cap fields and the reported finding count so escaping cannot amplify output without bound.
- Let lint reports drain pipe-backed stdout before the final exit so large JSON remains complete on every supported Node version.

### Correctness and fail-closed behavior

- Replace positional-argument index arithmetic with a validating CLI parser. An explicitly named ledger is the only ledger targeted, regardless of option order.
- Use one strict ledger parser for the checker and Stop hook. Reject zero-gate ledgers, duplicate ids, partial runnable gates, invalid regular expressions, blank abandonment reasons, unknown abandonment ids, and unindented attributes. Validate CLI options and scope ids separately, and reject invalid `OWNS:` paths when claiming a lease.
- Ignore fenced examples, preserve CRLF or LF during updates, and insert a missing evidence line into an otherwise valid gate.
- Match CommonMark fence length, marker, indentation, and closing-line rules so nested shorter fences cannot expose example gates.
- Add `--reverify` so parent verification executes already checked runnable gates and removes completion when the oracle no longer passes.
- Require both process exit `0` and `EXPECT:` match. Include resolved shell, working directory, exit status, match state, and a SHA-256 and byte-count output fingerprint in persisted evidence; keep bounded raw diagnostics terminal-only on failure.
- Apply the 1 MiB ceiling to both raw captured output and the canonical decoded stdout, newline, and stderr string used by `EXPECT:` and evidence. This prevents separator or invalid-UTF-8 expansion from producing a reported pass whose oversized evidence immediately becomes stale.
- Bind checker-written evidence to the parsed `CHECK:`, `EXPECT:`, and raw `CWD:` with a versioned, environment-independent full SHA-256 definition digest shared by checker, status, and Stop. Treat legacy, handwritten, malformed, future-version, and mismatched runnable evidence as stale-unmet while preserving ordinary manual evidence.
- Keep runtime approval identity separate from evidence currentness. Status detects definition drift without shell, `PATH`, timeout, approval-store, execution, or write dependencies; failed stale reruns clear the box and old evidence, and concurrent current-definition results remain serialized last-writer-wins.
- Discard an in-flight result when the gate's bound oracle changes before writeback.
- Diagnose an indented `ABANDON:` instead of ignoring it. Attributes must be indented and `ABANDON:` must not be, so the natural formatting mistake previously left a gate unmet and the honest exit unexplained.
- Warn when a slash-wrapped `EXPECT:` containing an unescaped inner slash is read as a regular expression. A literal path silently became a pattern whose dots matched any character, and the wrapping slashes leave no way to express the literal.
- Treat gate abandonment as terminal handoff rather than successful completion. Checker modes exit `1` with `HANDOFF REQUIRED`, parent `ALL MET` promotion cannot accept an abandoned child, and Stop reports qualified ids.
- Include scoped dispatch state in the primary gate reduction, so open, sealed, or abandoned waves can never coexist with `ALL MET`. Reject fabricated terminal histories, non-string handles and reasons, missing lifecycle timestamps, and impossible timestamp order.
- Sanitize repository-controlled dispatch diagnostics before they reach a host hook message, retain qualified abandonment handoffs in mixed block and release outcomes, and discard malformed per-session hook entries instead of failing open.
- Refuse status-log symlinks and swapped or non-regular targets before appending, including automatic dispatch audit events.
- Strip terminal controls and bidirectional overrides from repository-controlled checker diagnostics.
- Separate regular-expression worker startup from the 250ms match budget and cap concurrent match workers at four, so high `--jobs` values remain fail-closed without startup-induced false failures.
- Read discovered and explicit ledgers, dispatch state, hook state, session bindings, and lease records through bounded nonblocking descriptors. Require an unchanged regular single-link file, reject replacements and outside-root discovery, and keep named invalid ledgers visible so the Stop hook cannot mistake them for an empty pipeline.

### Command trust and portability

- Add explicit execution consent for ledger commands. Store approvals under `~/.unlazy/approved` by default, require the canonical owner-private store to remain outside the repository, reject linked, replaced, or non-private records, and bind each approval to the runtime oracle listed in [SECURITY.md](SECURITY.md#what-an-approval-binds).
- Add `--shell` with `UNLAZY_SHELL` fallback. Keep the platform shell as the final default and make inherited `PATH` behavior visible.
- Replace POSIX-only gate examples with repository-owned Node scripts and document Windows shell and `PATH` variance.
- On Windows, retain strict `dev` plus `ino` same-file checks by comparing the original descriptor with a second non-creating descriptor opened from the current name. Continue bracketing that identity acquisition with named-entry symlink, type, link-count, and replacement guards instead of ignoring device identity globally.
- On Windows timeouts, terminate an active `cmd.exe` tree with the drive-root `<drive>:\Windows\System32\taskkill.exe` only when `SystemRoot`, `WINDIR`, and `SystemDrive` agree. Bound the helper itself to one second, inspect every result, and fall back to the direct child without `PATH` lookup. Skip numeric-PID cleanup when Node has already observed leader exit, and independently settle after cleanup even when descendants retain pipes. The Windows CI path launches and reaps a real shell plus nested Node descendant.
- Keep a detached Node supervisor alive until each shell and inherited output stream closes. POSIX cleanup signals the group only while that exact supervisor still owns its PID and PGID, preventing a reused numeric group from being targeted without regressing descendant cleanup.
- Add [SECURITY.md](SECURITY.md) for command, environment, installer, hook, evidence, scope, and lease boundaries.
- Clarify that `--status` and Stop validate only structural definition currentness until explicit `--reverify` checks artifacts.

### Orchestration and concurrency

- Add scoped pipelines under `.unlazy/<scope>/`, qualified gate ids, session binding, append-only status logging, and explicit scope discovery refusal when the target is ambiguous.
- Add repository-relative `OWNS:` declarations with `--claim` and `--release`. Serialize claim discovery and creation under one lock, reject unsafe paths, and use conservative overlap detection.
- Treat a scope/leaf identity as an exclusive lease owner so duplicate workers cannot both claim and later release the same logical lease.
- Canonicalize the named-path identity used by every file lock, so real-root and symlink-root spellings of one physical repository cannot enter the same lease, dispatch, hook-state, or ledger critical section concurrently.
- Describe scopes and leases as coordination rather than filesystem or process isolation.
- Add opt-in `--jobs <N>` rolling check concurrency while retaining sequential default behavior and deterministic ledger-order reporting.
- Add declared readiness states, real `node-*` branch paths, explicit dependencies, and rolling leaf dispatch to the plan and orchestration guide.
- Add atomic native dispatch waves that require a distinct recorded start handle for every independent leaf before the first return is accepted.
- Add auditable dispatch abandonment for irrecoverable partial launches. Preserve the reason and timestamps in state, make status non-successful, and keep abandoned waves visible without permanently blocking Stop.
- Make scoped `gate-check` the aggregate completion oracle for both ledgers and dispatch waves; per-wave status and the optional Stop hook are no longer required to prevent a false completion certificate.
- Add Codex and Claude Code launch adapters, incomplete-wave Stop-hook enforcement, and a measured worker-overlap regression without adding a model subprocess runner.
- Key Stop-hook progress state to the session, serialize state changes, and retain unlazy's own six-block no-progress release.
- Compare resolved gate state between stops rather than raw ledger bytes. A comment, a reflowed line, or a rewritten evidence line no longer counts as progress, so the six-block release can fire for an agent that is editing without advancing.
- Compare canonical dispatch state and counts in the same guard, so timestamps and metadata do not impersonate launch progress.
- Distinguish an absent pinned scope from an existing unsafe scope entry: stale absent hook configuration may allow Stop, while a linked, special, unreadable, or outside-root named scope blocks without reading through it.
- Make the atomic `dispatch.json` transition authoritative when a later status-log append is refused. Return the committed transition with a bounded warning so a caller cannot blindly retry a state change that already happened.
- State the leaf-versus-branch gate placement rule in `references/gates.md`, so whole-project checks (interface, end-to-end, regression) live in the branch ledger and run once instead of re-running the tree on every per-leaf `--reverify`. Make one PLAN leaf dispatch table authoritative for Needs, Tier, Planned wave, and State; retain Owns as a derived planning mirror, keep the tree topology-only, and keep actual launches in dispatch state and logs. Require normalized set equality with the ledger's command-time `OWNS:` authority before READY and claim, map Tier only through host-specific controls that exist, keep driver and branch duties outside leaf tiers, and distinguish exact-leaf release after parent verification from whole-scope release after all leaves settle and final verification runs.

### Installer, package, and documentation

- Identify installed hooks by an exact stable marker and constrained legacy script path so moved installations are repaired without claiming unrelated marker substrings. Verify an existing settings file through a no-follow descriptor before reading or backing it up.
- Validate settings container shapes, preserve unrelated entries, write atomically, and create `<settings-file>.unlazy.bak` before replacing an existing settings file.
- Repair matching hook commands whose managed type or timeout fields drifted, and return the documented infrastructure exit code when approval storage fails.
- Warn that local settings and `.unlazy/` should remain untracked and that `--shared` embeds a machine-specific absolute path.
- Keep Node 16 compatibility and zero runtime dependencies. Add a package test command and cross-platform CI, plus a dedicated Windows Node 22.14.0/libuv 1.49.2 lane for the affected stat implementation.
- Add valid `agents/openai.yaml` metadata and keep `SKILL.md` focused through linked references.
- Add a revisioned PLAN contract inventory that maps every independently omittable required outcome and acceptance-changing constraint to an owner and observation, plus request rereads before fan-out and root completion.
- Correct research titles, dates, ordering, and metric interpretation. Add a reproducibility protocol and label the historical six-run comparison's missing raw artifacts.

### Community work integrated

Contributors and reporters are credited by GitHub handle.

- [#2](https://github.com/Leonxlnx/unlazy/pull/2): re-verification, parser diagnostics, CRLF preservation, evidence insertion, fenced-example handling, and validation ideas, by @elkaix
- [#3](https://github.com/Leonxlnx/unlazy/pull/3): the explicit-file positional fix, by @silvereyes137-eng
- [#5](https://github.com/Leonxlnx/unlazy/pull/5): rolling dispatch and bounded `--jobs`, by @abhilash333naidu
- [#8](https://github.com/Leonxlnx/unlazy/pull/8): stable hook identification and moved-install repair, by @marceloterra1983
- [#9](https://github.com/Leonxlnx/unlazy/pull/9): explicit approval for executable checks, by @marceloterra1983
- [#10](https://github.com/Leonxlnx/unlazy/pull/10): scoped pipelines, shared parsing, ownership leases, session routing, and the first regression suite, by @HeeyunCho
- [#14](https://github.com/Leonxlnx/unlazy/pull/14): the COLM 2026 test-time-scaling source, by @chrono-meta
- [#15](https://github.com/Leonxlnx/unlazy/pull/15): negative controls, supplied-number measurement, and manual-gate review guidance, by @vishalsachdev; the single-run risk observation is intentionally not generalized
- [#17](https://github.com/Leonxlnx/unlazy/pull/17): the read-only gate-quality linter, JSON output, strict mode, documentation, and regression harness, by @Dalydoo
- [#18](https://github.com/Leonxlnx/unlazy/pull/18): atomic native dispatch waves, launch adapters, durable state, Stop integration, documentation, and tests, by @hangloose50
- [#20](https://github.com/Leonxlnx/unlazy/pull/20): the Windows process-tree timeout diagnosis and `taskkill /t` direction, by @parveen0029
- [#24](https://github.com/Leonxlnx/unlazy/pull/24): fail-closed diagnosis of an indented `ABANDON:`, by @Dalydoo
- [#25](https://github.com/Leonxlnx/unlazy/pull/25): semantic Stop-hook progress hashing, by @Dalydoo
- [#26](https://github.com/Leonxlnx/unlazy/pull/26): shared-parser warning for ambiguous path-shaped EXPECT regexes, by @Dalydoo
- [#29](https://github.com/Leonxlnx/unlazy/pull/29): leaf-versus-branch gate placement, visible PLAN dispatch metadata, and host-neutral skill wording, by @mafiaboyhacker
- [#21](https://github.com/Leonxlnx/unlazy/issues/21), [#22](https://github.com/Leonxlnx/unlazy/issues/22), and [#23](https://github.com/Leonxlnx/unlazy/issues/23): abandonment promotion, approval currentness after a checked script changes, and contract omission reports and reproducers, by @theislampill
- [#30](https://github.com/Leonxlnx/unlazy/issues/30): the affected-Windows descriptor and path `st_dev` mismatch report and reproduction, by @kimdans
- [#31](https://github.com/Leonxlnx/unlazy/issues/31): the automatic-evidence definition drift report and false-green reproduction, by @satwareAG-ironMike

## 2.0.0 source milestone, 2026-08-10

Moved completion enforcement from prose into gate files, runnable checks, evidence, and an optional Claude Code Stop hook.

- Reframed the Depth Tree as decomposition and integration rather than an arithmetic effort multiplier.
- Added rule zero: write acceptance gates before real work.
- Added the original zero-dependency checker, Stop hook, and installer.
- Added solo and orchestrated workflows, per-leaf and per-branch ledgers, parent verification guidance, and final report remeasurement.
- Split detailed method, gate, orchestration, and token guidance into references for progressive disclosure.

The exploratory six-run comparison that informed this milestone is not reproducible from the repository because its raw artifacts were not retained. See [research/validation-protocol.md](research/validation-protocol.md).

## 1.0.0 source milestone, 2026-08-10

- Added the original instruction-only Depth Tree method.
- Added behavioral rules against premature completion, silent scope reduction, and unmeasured final claims.
- Added installation and related-research documentation.
