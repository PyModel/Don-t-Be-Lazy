<div align="center">

# unlazy

**Completion discipline for substantial AI-agent work, backed by runnable gates.**

Write the acceptance ledger first. Run reviewed checks. Re-verify returned work. Report only what the evidence supports.

[Install](#install) | [Quick start](#quick-start) | [Gate contract](#the-gate-contract) | [Enforcement](#what-enforces-completion) | [Orchestration](#orchestration-and-parallel-work) | [Security](#security-boundary) | [Research](#research-basis)

</div>

## Status and evidence

The source targets `2.1.0`, which is not a tagged GitHub release. Pin a commit when you need an immutable install. See [CHANGELOG.md](CHANGELOG.md) for the unreleased change set.

The test suite validates the tools: parser, checker, approvals, hook, installer, and portability. No controlled evaluation yet shows that unlazy lowers the rate at which agents claim unfinished work is done. [research/validation-protocol.md](research/validation-protocol.md) describes an evaluation that could.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills):

```text
npx skills add Leonxlnx/unlazy
```

Add `-g` for a user-level install. `--all` installs for every supported agent without prompting, not only for agents detected on this machine.

Manual locations:

```text
Claude Code:  ~/.claude/skills/unlazy
Codex:        ~/.agents/skills/unlazy
```

For an install that can be rebuilt from history, clone and check out a commit:

```text
git clone https://github.com/Leonxlnx/unlazy ~/.agents/skills/unlazy
git -C ~/.agents/skills/unlazy checkout <commit>
```

When several agents link to one copy, point the links at a checkout reserved for installs, such as a `git worktree` at a tag, not at a development checkout. Every agent loads whatever that directory holds, uncommitted edits included.

Invoke the skill as `/unlazy` where slash skills are supported, `$unlazy` in Codex, or by a natural-language trigger from its description. The core is [SKILL.md](SKILL.md). The scripts need Node 16 or newer and no packages.

## Quick start

Ask for substantial work with an explicit trigger:

```text
/unlazy tree 5 refactor the payment module and verify every migration path
```

In the commands below, `<skill-dir>` is the directory that holds `SKILL.md`. For a solo task, copy [templates/gates-leaf.md](templates/gates-leaf.md) to `GATES.md`, replace every placeholder, then run:

```text
node <skill-dir>/scripts/gate-lint.mjs --strict GATES.md
node <skill-dir>/scripts/gate-check.mjs --review GATES.md
node <skill-dir>/scripts/gate-check.mjs --approve=<tokens> GATES.md
node <skill-dir>/scripts/gate-check.mjs --reverify GATES.md
```

1. `gate-lint` flags oracles that cannot fail. It never executes a check.
2. `--review` prints each oracle's command, expectation, working directory, shell, `PATH` digest, bound input files, and a token. It never executes.
3. `--approve=<tokens>` records approval for exactly the tokens you read, then runs them.
4. `--reverify` re-executes every runnable gate, including met ones. Run it before every report and commit.

`--status` reads recorded evidence without executing anything. A plain run never executes an unapproved oracle: it prints the review block and exits `4`. Once an oracle is approved, a plain run executes it, so plain mode is not a dry run. `--help` lists the complete CLI, including `--json`, `--show-path`, `--list-approvals`, `--revoke`, and `--prune-approvals`.

Exit codes: `0` all met; `1` unmet or handoff; `2` usage, parse, or infrastructure error; `3` lease conflict; `4` approval required; `129`, `130`, or `143` interrupted by a signal.

## The gate contract

```markdown
# Gates: pricing behavior

- [ ] G1: pricing fixtures render the expected tiers
  CHECK: node scripts/verify-pricing.mjs
  EXPECT: pricing verification passed
  EVIDENCE: pending

- [ ] G2: checkout integration succeeds from its package
  CHECK: node scripts/verify-checkout.mjs
  EXPECT: checkout verification passed
  CWD: packages/checkout
  EVIDENCE: pending
```

A runnable gate passes only when its process exits `0` and `EXPECT:` matches the combined output. Checker-written evidence starts with a versioned digest of the gate's `CHECK:`, `EXPECT:`, and `CWD:`, so evidence recorded for an older definition is stale and unmet. The digest detects drift, not tampering: anyone who can edit a ledger can forge it. `--status` and the Stop hook read evidence without executing; `--reverify` executes again.

The parser fails closed. A ledger with no gates, duplicate ids, a partial runnable gate, an orphan or malformed attribute, an invisible control character, an `EXPECT:` pattern that matches empty output, or an abandonment without a reason is an error, never `ALL MET`. A handoff line (`ABANDON:`, optionally of kind `DEFERRED:` or `OWNER_DECISION:`) exits `1` with `HANDOFF REQUIRED`.

The checker proves only the oracle you declare. Good gates read the artifact the title names, print a success-only marker after every assertion, test an absence check against a known positive control, measure figures instead of copying them, and send consequential manual outcomes to review. Full specification: [references/gates.md](references/gates.md).

## Shell and PATH

The checker uses `--shell`, then `UNLAZY_SHELL`, then Node's platform default: `/bin/sh` on Unix and `ComSpec` on Windows. Checks inherit the launch environment, including `PATH`, so a checker launched from Git Bash can see tools that the same checker launched from PowerShell cannot. Portable gates call the project's test runner or a repository-owned Node script, and parent re-verification uses the same shell and toolchain.

## What enforces completion

| Host | Enforcement |
|---|---|
| Claude Code with the Stop hook | The main session cannot stop while an enforced pipeline has unmet gates or an unsealed launch wave, until six blocks pass without progress. Subagents are not gated. |
| Claude Code without the hook | Skill instructions, the checker, and the report contract |
| Codex and other hosts | Skill instructions, the checker, and the report contract. No hook configuration ships for them. |

Ledgers, approvals, dispatch waves, and leases are records that cooperating agents keep. [SECURITY.md](SECURITY.md#what-unlazy-cannot-stop) lists what unlazy cannot prevent.

## Security boundary

`CHECK:` lines are code. Nothing runs until an approval binds the exact runtime oracle, including the bytes of repository files the command names. Approvals live outside the repository, under `~/.unlazy/approved`, and can be listed, revoked, and pruned. An approval is consent to execute, not a sandbox: checks run with your filesystem, credential, and network access, and scopes and leases coordinate cooperating processes without restricting them. [SECURITY.md](SECURITY.md) holds the complete binding list and threat model.

## Orchestration and parallel work

For work that needs fresh contexts, create one scoped pipeline under `.unlazy/<scope>/`:

```text
.unlazy/<scope>/PLAN.md
.unlazy/<scope>/GATES.md
.unlazy/<scope>/gates/leaf-*.md
.unlazy/<scope>/gates/node-*.md
```

The driver rereads the current request and keeps a revisioned contract inventory that maps each independently required outcome or acceptance-changing constraint to an owner and an observation. `scripts/plan-check.mjs` checks that inventory, the dispatch table, and the tree without executing anything. The driver fixes interfaces, dependencies, conventions, and file ownership before dispatch. Leaves use `WAITING`, `READY`, `IN-FLIGHT`, `VERIFIED`, or `ABANDONED`; branches use `OPEN`, `VERIFIED`, or `ABANDONED`.

Ready leaves may run together only after each declares complete, disjoint, repository-relative `OWNS:` paths and claims them:

```text
node <skill-dir>/scripts/gate-check.mjs --scope api --leaf leaf-1.2.1 --claim
```

Lease matching is conservative and may reject a safe-looking pair. It is a coordination guard, not write isolation. Use separate worktrees for colliding worktree-local output, and separate cache locations when cache writes can conflict.

Dispatch is rolling: when a verified leaf unblocks another, start the newly ready leaf without waiting for unrelated work. Gate checks stay sequential by default; `--jobs <N>`, an integer from 1 through 64, runs independent checks concurrently and keeps reporting in ledger order.

For every independent READY set, open a native launch wave, record each host agent handle, and seal before the first wait. Opening a wave requires the scope's ledger and a claimed lease for every leaf. If a partial launch cannot recover, use the audited `abandon --reason` transition; never invent a handle or delete state. Read [references/method.md](references/method.md), [references/orchestration.md](references/orchestration.md), [references/dispatch.md](references/dispatch.md), and [references/parallel.md](references/parallel.md) before parallel fan-out.

`gate-check.mjs --scope <id>` reduces the scope's ledgers and dispatch waves together. It prints `ALL MET` only when every gate is met and every wave is complete; an abandoned wave is a non-successful `HANDOFF REQUIRED` outcome.

## Optional Claude Code Stop hook

The hook reads the session's enforced ledgers and dispatch state and returns Claude Code's documented `decision: "block"` response while gates remain unmet or a launch wave is unsealed. It never executes checks. It enforces the project's `GATES.md`, the scope pinned with `--scope`, and scopes bound to the session; an unbound pipeline with unmet work blocks once with a notice that names its `--bind` command. Its per-session guard releases after six blocks without gate or dispatch progress, and the sixth block tells the model what to report as unmet. A handoff blocks once. A ledger with unmet gates that disappears, or a runnable gate rewritten as manual, keeps blocking.

Install only with the user's consent:

```text
node <skill-dir>/scripts/install-hooks.mjs
node <skill-dir>/scripts/install-hooks.mjs --scope api
node <skill-dir>/scripts/install-hooks.mjs --verify
node <skill-dir>/scripts/install-hooks.mjs --uninstall
```

The default target is `.claude/settings.local.json`. `--shared` writes project settings with machine-specific absolute paths, and `--global` writes user settings. Hook progress state lives in `~/.unlazy/hook-state`, outside the repository. Keep `.claude/settings.local.json` and `.unlazy/` in the project's ignore rules.

The installed command records the Node binary and the skill path as you invoked the installer, and at each Stop it runs whatever that directory holds. The installer warns about a version-managed Node, uncommitted changes, and an untagged checkout, and `--verify` reports `OK`, `BROKEN`, or `NOT INSTALLED`. It preserves unrelated hooks, follows a symlinked settings file, refuses malformed settings, writes atomically, and keeps the first `<settings-file>.unlazy.bak`.

## What 2.1.0 changes

The unreleased `2.1.0` source integrates community pull requests and an audit remediation:

- strict shared ledger parsing that fails closed on invisible characters, orphan attributes, and expectations that match empty output
- reviewed execution: `--review` tokens, `--approve=<tokens>`, exit `4` for approval required, approvals bound to directory identity and to the bytes of named verifier files, and `--list-approvals`, `--revoke`, and `--prune-approvals`
- `--reverify`, exit-plus-`EXPECT:` success, and definition-bound automatic evidence with repository-relative paths
- summaries that list every unmet id with a measurement time, plus `--json`
- `--shell` and `UNLAZY_SHELL` with `PATH` disclosure, and signal handling that keeps finished results
- scoped pipelines, session binding, atomic ledger updates, and serialized lease coordination that folds Unicode normalization and filesystem case
- rolling orchestration, opt-in `--jobs`, and native dispatch waves that require a ledger and a lease per leaf
- revisioned PLAN contract inventories checked by `scripts/plan-check.mjs`
- advisory gate linting with a strict mode
- handoff kinds (`ABANDONED`, `DEFERRED`, `OWNER_DECISION`) that never promote a parent to complete
- a Stop hook with per-user state, directory-change tracking, deleted-ledger memory, one-time handoffs and notices, and bounded messages
- an installer with `--verify`, symlinked-settings support, and install-time warnings
- strict Windows file identity and bounded Windows process-tree cleanup
- a truthful-reporting contract (`references/reporting.md`, `templates/REPORT.md`) and a scoped engineering standard for changed code (`references/engineering-standard.md`)
- Node 16 support, zero runtime dependencies, and CI that includes Node 16.0.0

Contributor history and pull-request links are in [CHANGELOG.md](CHANGELOG.md).

## Repository map

```text
SKILL.md                            core workflow and mode routing
SECURITY.md                         approval binding, threat model, hook and installer boundaries
agents/openai.yaml                  skill UI metadata
references/gates.md                 ledger format, success contract, and authoring rules
references/method.md                Depth Tree decomposition
references/orchestration.md         states, rolling dispatch, and verification layers
references/dispatch.md              native launch waves, host adapters, and recovery
references/parallel.md              scopes, leases, session binding, and their limits
references/token-economy.md         attention and verification cost discipline
references/engineering-standard.md  what the oracles for changed code must cover
references/reporting.md             truthful-reporting contract
research/                           validation protocol and research notes
templates/                          PLAN, leaf ledger, branch ledger, and REPORT templates
scripts/gate-check.mjs              checker, approvals, leases, status log, and session binding
scripts/gate-lint.mjs               non-executing ledger quality audit
scripts/plan-check.mjs              non-executing PLAN inventory, table, and tree check
scripts/dispatch-check.mjs          native launch-wave recorder
scripts/install-hooks.mjs           Stop hook installer and verifier
scripts/stop-hook.mjs               Claude Code Stop hook
scripts/lib/                        shared parser, approval store, dispatch state, process and terminal helpers
tests/                              behavior suites, the shared harness in tests/lib, and self-check
```

Run the complete test command:

```text
npm test
```

## Research basis

Research supports the failure modes that motivate explicit structure; it does not prove that unlazy produces a fixed improvement.

- Detailed multi-part prompts still see partial compliance and premature truncation in tested models ([Quantifying Laziness](https://arxiv.org/abs/2512.20662)).
- Reasoning can stop exploration too early or continue beyond useful compute, depending on task and model ([Thoughts Are All Over the Place](https://arxiv.org/abs/2501.18585), [When More Thinking Hurts](https://arxiv.org/abs/2604.10739), [OptimalThinkingBench](https://arxiv.org/abs/2508.13141)).
- SlopCodeBench reports that no tested agent fully solved a problem end to end and that the best agent passed `14.8%` of checkpoints. Checkpoint success is not task completion ([SlopCodeBench](https://arxiv.org/abs/2603.24755)).
- s1's budget forcing lengthens reasoning by appending `Wait` multiple times when the model tries to stop; it is not a claim that one token always improves work ([s1](https://arxiv.org/abs/2501.19393)).
- METR's Time Horizon 1.1 reports a `196.5` day overall P50 doubling-time fit and `130.8` days for the post-2023 fit. The shorter figure must not be described as the all-years estimate ([METR Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/)).
- Closed-book knowledge-intensive tasks can hallucinate more with additional test-time compute, and compute-only post-processing cannot add ground-truth information that was not present ([Test-Time Scaling in Reasoning Models Is Not Effective for Knowledge-Intensive Tasks Yet](https://arxiv.org/abs/2509.06861), COLM 2026).

Earlier README versions also cited a six-run internal comparison. The raw artifacts needed to reproduce those exact ratios and counts are not in this repository. Treat the results as historical design input, not a benchmark guarantee. The limitations and a protocol for a defensible rerun are in [research/validation-protocol.md](research/validation-protocol.md).

### Sources, newest first

Ordered by the most recent public version or publication date known on 2026-08-23. Undated material appears last.

- 2026-08-06: [Test-Time Scaling in Reasoning Models Is Not Effective for Knowledge-Intensive Tasks Yet](https://arxiv.org/abs/2509.06861), v3, COLM 2026
- 2026-07-10: [Measuring AI Ability to Complete Long Software Tasks](https://arxiv.org/abs/2503.14499), v4, NeurIPS 2025
- 2026-05-07: [SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks](https://arxiv.org/abs/2603.24755), v2
- 2026-04-13: ["Should I Give Up Now?" Investigating LLM Pitfalls in Software Engineering](https://arxiv.org/abs/2411.09916), v3
- 2026-04-12: [When More Thinking Hurts: Overthinking in LLM Test-Time Compute Scaling](https://arxiv.org/abs/2604.10739)
- 2026-01-29: [METR Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/)
- 2025-12-19: [Quantifying Laziness, Decoding Suboptimality, and Context Degradation in Large Language Models](https://arxiv.org/abs/2512.20662)
- 2025-10-04: [OptimalThinkingBench: Evaluating Over and Underthinking in LLMs](https://arxiv.org/abs/2508.13141), v2
- 2025-10-03: [Context Anxiety: How AI Agents Panic About Their Perceived Context Windows](https://inkeep.com/blog/context-anxiety)
- 2025-03-01: [s1: Simple test-time scaling](https://arxiv.org/abs/2501.19393), v3
- 2025-02-18: [Thoughts Are All Over the Place: On the Underthinking of o1-Like LLMs](https://arxiv.org/abs/2501.18585), v2
- Undated page: [Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/docs/unified-diffs.html)

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Behavioral claims need current, directly supporting sources; executable changes need regression coverage.

## License

[MIT](LICENSE)
