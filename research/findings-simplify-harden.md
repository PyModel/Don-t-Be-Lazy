# Findings: ways to simplify and harden the unlazy enforcement tools

Date: 2026-09-10. Repo state: `1667149` (2.1.0). Method: primary-source research against the three
hand-rolled hard mechanisms in `scripts/` (atomic writes + locks, process-tree termination, hook
lifecycle), the test harness, and prior art. Repo constraints treated as load-bearing:
**zero dependencies** and **Node >= 16** ([package.json], [gates.mjs:1-2]).

Repository links are pinned to the commit the line numbers describe. Later remediation merged the
duplicate approval lock into `withFileLock` and the seven runners into `tests/lib/harness.mjs`.

## TL;DR

1. **Simplify by consolidating, not by adopting libraries.** The biggest redundancy is inside the
   repo: two independent lock implementations, several copies of read-validate-write state handling,
   and seven hand-rolled test-runner copies. Prior-art lock libraries change safety semantics and
   would break the zero-dependency constraint.
2. **Hardening already applies every mitigation found in the public issues surveyed below** (about
   five reports and two library docs, not a systematic review) for Windows atomic renames and
   process-tree kills; the one known residual gap (grandchild escape on Windows, fixable only with
   Win32 Job Objects) is not reachable without native dependencies and should be recorded as an
   accepted limitation rather than half-fixed.
3. **Host-capability research surfaced possible simplifications**: `SessionEnd` hooks are documented
   for cleanup, though their 1.5 s default budget is shorter than unlazy's lock waits (section 3),
   and Node's stdlib `node:test` / `util.parseArgs` could replace several hundred lines if the Node
   floor moves to 16.17 or later (section 4).

---

## 1. Atomic writes and file locks

**Current implementation.** `scripts/lib/gates.mjs` owns a temp-file + `renameSync` replacement with
a bounded 2 s retry deadline, an exclusive `openSync(..., "wx")` temp creation, and an explicit
refusal to unlink the destination or fall back to in-place writes, "either of which would sacrifice
atomicity" ([gates.mjs:217-229], [gates.mjs:700-729]). Locks are sha256-named `.filelock` files with
JSON owner metadata under a canonicalized lock directory; acquisition treats only `EEXIST` and
Windows sharing errors (`EPERM/EACCES/EBUSY`) as contention, and never steals a lock observed by
path: the comment explicitly cites the stat-then-unlink ABA race and says a crashed owner's lock
"fails closed at timeout" ([gates.mjs:747-786]). `scripts/gate-check.mjs` carries a **second,
independent** lock implementation for approval locks with the same `wx` + deadline + owner-token +
ABA-avoidance shape ([gate-check.mjs:484-519]).

**Prior art on Windows rename failures.** The failure mode is well documented: `fs.rename` maps to
`MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which fails with `EPERM` when any handle is open on the
target. Filesystem filter drivers (App-V, WdFilter, bindflt), antivirus, watchers, and networked
profiles all trigger it ([openchamber#2544], [cabinet#292]). The ecosystem's standard mitigation is
bounded retry on `EPERM/EACCES/EBUSY`; npm's `write-file-atomic` and VS Code retry the rename
([cabinet#292]). A second, weaker mitigation adds a `copyFile` + `unlink` fallback when retries
exhaust ([MCP servers PR #3430]). Field evidence says the fallback is lossy: when a handle is held
persistently, retry loops never succeed, and the copy+unlink fallback *silently gives up atomicity*.
An openclaw incident needed both retry and copy-fallback patches across separate modules and
still failed [openclaw#78640].

**Assessment.**

- The 2 s bounded retry already exceeds `write-file-atomic`'s retry window, and the deliberate
  no-fallback choice is the correct fail-closed policy for gate state, where a torn write is worse
  than a failed write. Keep it; the pattern matches the ecosystem's hard-won guidance.
- The **two lock implementations fail the locality test**: the same ABA-race reasoning, deadline
  logic, and owner-token format now live in two files. Deleting the `gate-check.mjs` approval lock
  and acquiring through one lock module in `lib/gates.mjs` *concentrates* the complexity (deletion
  test passes). One lock interface, two call-site adapters (approval lock, state-file lock); the
  seam is already justified by real variation in what is protected; only the implementation is
  duplicated.
- `proper-lockfile` (the reference prior art: atomic `mkdir` acquisition, mtime staleness with
  update intervals, compromise handling, realpath canonicalization) was evaluated and should **not**
  be adopted: it is a dependency, its retries are unsupported in synchronous mode, and its core
  semantic, *stealing locks older than the stale threshold*, is precisely the behavior unlazy
  chose to avoid [proper-lockfile docs].

## 2. Process-tree termination on timeout

**Current implementation.** POSIX path: the CHECK runs under a detached supervisor that is the
process-group leader and deliberately stays alive until descendants that inherited its stdout/stderr
close, preserving group identity ([check-supervisor.mjs:29-31]); kill targets the numeric PGID but
refuses to signal once Node observed the leader exit, because the PGID may have been reused
([process-tree.mjs:49-53]). Windows path: `taskkill /pid <pid> /f /t` resolved from a trusted
System32 path (never `PATH`), bounded by a 1 s timeout so cleanup cannot extend the CHECK timeout,
with a `child.kill("SIGKILL")` fallback ([process-tree.mjs:20-24], [process-tree.mjs:94-152]).

**Prior art.** Node cannot kill a process group on Windows: `process.kill` has no group semantics
there [nodejs/node#3617]. `taskkill /T /F` at the execution layer is the accepted approach; pnpm
moved to it after `pidtree` enumeration could not finish inside a 500 ms bound [pnpm#12406]. execa's
`killDescendants` likewise delegates to `taskkill` on Windows [execa termination]. The known
residual defect of the `taskkill /T` approach is a TOCTOU window: `/T` kills only descendants that
exist at execution time, so a grandchild spawned during the window escapes; the proposed robust fix
is Win32 Job Objects [opencode#33071], which practitioners describe as "not yet wired" even in
process-management libraries [babysitter lifecycle doc].

**Assessment.** unlazy's implementation already incorporates every mitigation the ecosystem uses,
plus one most lack: holding inherited pipes open in the supervisor narrows exactly the
descendant-escape window the TOCTOU reports describe, because lingering descendants keep the
supervisor (the kill target) alive. The remaining gap, Job Objects, requires FFI/native code and
conflicts with the zero-dependency constraint. Recommended action is documentation, not code:
record the accepted limitation and the pipe-holding rationale in `SECURITY.md` so a future
contributor does not re-derive it as a bug.

## 3. Hook lifecycle: what the host now offers that unlazy reimplements

Grounded against the current Claude Code hooks reference [hooks reference], [hooks guide]:

- `Stop` fires **once per turn**; a hook returns `{"decision":"block","reason":...}` to force
  continued work. unlazy's `stop-hook.mjs` matches this contract.
- **`SessionEnd`** exists specifically "for cleanup tasks, logging session statistics, or saving
  session state", with per-reason matchers (`clear`, `resume`, `logout`, `prompt_input_exit`,
  `other`) and no decision control; its default timeout is 1.5 s [hooks reference §SessionEnd].
  unlazy currently clears per-session hook state lazily from inside the `Stop` hook
  ([stop-hook.mjs:110-113]). Moving cleanup to a `SessionEnd` handler removes that branch from the
  block/no-block decision path: a small interface, clearer seam: lifecycle events stop sharing one
  implementation.
  *Caveat:* the 1.5 s `SessionEnd` default is shorter than the Stop hook's bounded lock wait, so a
  cleanup handler could time out while a concurrent Stop holds the state lock. Do not move cleanup
  there without a shorter lock budget. (After this note, hook state moved to per-user storage under
  `~/.unlazy/hook-state`, and Stop still clears settled entries itself.)
- **Skill-frontmatter hooks**: hooks may now be declared in a skill's frontmatter, registered when
  the skill is invoked and kept "for the rest of the session", with `once: true` to auto-remove
  [hooks reference §Hooks in skills and agents]. This could replace part of `install-hooks.mjs`
  *for skill-invoked sessions*, but unlazy's enforcement model requires the Stop gate to exist
  **before** the skill is invoked (blocking relies on the hook already being installed), so the
  settings-file installer remains load-bearing for Claude Code hosts. Record the tradeoff in
  `references/`; do not delete the installer based on the new capability.
- Hook `timeout` defaults are 600 s for command hooks (30 s on `UserPromptSubmit`) [hooks reference
  §Common fields]; unlazy's bounded lock waits (10 s approval deadline, 30 s filelock) are
  comfortably inside the host budget; the earlier "keep hook lock waits within host timeout" fix
  (commit `754d9a6`) remains consistent with documented budgets.

## 4. Test harness and CLI parsing: stdlib replacements behind a version decision

**Current.** Seven test entry scripts each carry their own mini-runner: a `tests` array plus a
`filter` taken from `process.argv[2]` ([dispatch-tests.mjs:16-20], [lint-tests.mjs:20-24],
[run-tests.mjs:20-24]), and `package.json` chains all seven sequentially [package.json].
`gate-check.mjs` hand-rolls `parseArgs` ([gate-check.mjs:86-148]); the other entry scripts each
hand-roll argv loops ([install-hooks.mjs:29-32], [dispatch-check.mjs:7-8], [stop-hook.mjs:53-55]).

**Stdlib options.** `node:test` provides `describe`/`it`, subtests with cancellation, `beforeEach`
hooks, and a runner via `node --test` [node:test docs]; `util.parseArgs` provides strict-mode
parsing with typed options, positionals, `multiple`, and defaults [util.parseArgs docs].

**Tradeoff.** `util.parseArgs` was added in v18.3.0 and `node:test` in v18.0.0; both were backported
to v16.17.0 as experimental APIs and are stable from v20 [node:test docs], [util.parseArgs docs].
The repo pins `engines.node: >=16` [package.json], so using them means raising the floor to at
least 16.17. Node 16 reached end-of-life in September
2023 [node EOL schedule], so the floor is already support-unverified upstream. Raising the floor to
16.17, 18, or 20 unlocks deleting the seven runner copies and the hand-rolled parser, several
hundred lines, at zero dependency cost. If the floor must stay at 16, this whole section is void; that is
a legitimate but load-bearing choice that should be stated in `CONTRIBUTING.md` either way.

## 5. Prior-art taxonomy: how comparable systems structure gates and waves

GSD (a spec-driven enforcement layer for Claude Code) structures the same problem
domain with **four canonical gate types (pre-flight, revision, escalation, abort) wired into
plan-checker and verifier agents**, and **wave-based parallel execution** grouping independent plans
into waves with commit-per-task tracking [GSD article]. unlazy already has waves
([dispatch.mjs:199-212]) and falsifiable gates ([references/gates.md]); the comparable artifact is
vocabulary, not code: unlazy's gate taxonomy is implicit in `references/gates.md` where GSD's is
named. If cross-agent teaching of the model is a goal, naming unlazy's gate classes (e.g.
pre-flight vs exit gates) in `SKILL.md` is a cheap alignment; no code change implied.

---

## Sources

[package.json]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/package.json
[gates.mjs:1-2]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/gates.mjs
[gates.mjs:217-229]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/gates.mjs
[gates.mjs:700-729]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/gates.mjs
[gates.mjs:747-786]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/gates.mjs
[gate-check.mjs:484-519]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/gate-check.mjs
[gate-check.mjs:86-148]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/gate-check.mjs
[check-supervisor.mjs:29-31]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/check-supervisor.mjs
[process-tree.mjs:20-24]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/process-tree.mjs
[process-tree.mjs:49-53]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/process-tree.mjs
[process-tree.mjs:94-152]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/process-tree.mjs
[stop-hook.mjs:110-113]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/stop-hook.mjs
[stop-hook.mjs:53-55]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/stop-hook.mjs
[install-hooks.mjs:29-32]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/install-hooks.mjs
[dispatch-check.mjs:7-8]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/dispatch-check.mjs
[dispatch.mjs:199-212]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/scripts/lib/dispatch.mjs
[dispatch-tests.mjs:16-20]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/tests/dispatch-tests.mjs
[lint-tests.mjs:20-24]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/tests/lint-tests.mjs
[run-tests.mjs:20-24]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/tests/run-tests.mjs
[references/gates.md]: https://github.com/Leonxlnx/unlazy/blob/16671491f6679ad9378f52604d3bc2415b4120c7/references/gates.md
[openchamber#2544]: https://github.com/openchamber/openchamber/issues/2544
[cabinet#292]: https://github.com/hilash/cabinet/issues/292
[MCP servers PR #3430]: https://github.com/modelcontextprotocol/servers/pull/3430
[openclaw#78640]: https://github.com/openclaw/openclaw/issues/78640
[proper-lockfile docs]: https://github.com/moxystudio/node-proper-lockfile
[nodejs/node#3617]: https://github.com/nodejs/node/issues/3617
[pnpm#12406]: https://github.com/pnpm/pnpm/issues/12406
[opencode#33071]: https://github.com/anomalyco/opencode/issues/33071
[execa termination]: https://github.com/sindresorhus/execa/blob/main/docs/termination.md
[babysitter lifecycle doc]: https://github.com/a5c-ai/babysitter/blob/main/docs/adapters/reference/11-process-lifecycle-and-platform.md
[hooks reference]: https://code.claude.com/docs/en/hooks
[hooks guide]: https://code.claude.com/docs/en/hooks-guide
[hooks reference §SessionEnd]: https://code.claude.com/docs/en/hooks#sessionend
[hooks reference §Hooks in skills and agents]: https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents
[hooks reference §Common fields]: https://code.claude.com/docs/en/hooks#common-fields
[node:test docs]: https://nodejs.org/api/test.html
[util.parseArgs docs]: https://nodejs.org/api/util.html#utilparseargsconfig
[node EOL schedule]: https://github.com/nodejs/release#release-schedule
[GSD article]: https://www.augmentcode.com/learn/gsd-stars-spec-driven-dev-claude-code
