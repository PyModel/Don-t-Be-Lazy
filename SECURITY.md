# Security model

Unlazy runs commands that a repository describes. Its safety boundary is review and consent before execution, not command sandboxing, and that consent comes from whoever runs the checker: the operator or the agent. This file is the single source for what an approval binds.

## `CHECK:` lines are code

`gate-check.mjs` runs each `CHECK:` through a shell with the checker's user permissions and inherited environment. A command can read and write files, open network connections, and use any credential or tool available to that process.

Before running an inherited ledger:

1. Parse it without executing anything: `node <skill-dir>/scripts/gate-check.mjs --status <gate-file>`.
2. List every oracle: `node <skill-dir>/scripts/gate-check.mjs --review <gate-file>`. Review prints each `CHECK:`, `EXPECT:`, resolved working directory, resolved shell, a `PATH` digest (`--show-path` lists every entry), the bound input files, and a 16-character token. It never executes and never writes.
3. Read every command and every script it calls, including generated or ignored files.
4. Approve only what you read: `node <skill-dir>/scripts/gate-check.mjs --approve=<tokens> <gate-file>`. The checker records those tokens and runs them. A bare `--approve`, a malformed token, or a token that matches no current oracle is refused with exit `2`.

A normal run never executes an oracle without an exact approval. It prints the same review block, leaves the command unexecuted, and exits `4`. Normal mode is not a dry run: once an oracle is approved, a normal run executes it.

Who may approve is an instruction, not a mechanism. `SKILL.md` lets an agent approve oracles it wrote in the current session and requires the user's explicit approval for an inherited ledger. Nothing in the checker can tell those cases apart.

Do not run untrusted checks to learn what they do. Review them as source first, and use a disposable environment or a stronger sandbox when source trust is uncertain.

## What an approval binds

An approval is keyed to the absolute ledger path and the gate id, plus this runtime oracle:

- the exact `CHECK:` and `EXPECT:` text
- the resolved working directory, plus the device and inode of that directory and of the ledger's directory, so a directory replaced at the same path, or a different clone at the same path, needs approval again
- the resolved shell
- the timeout, the output limit, the regular-expression match and worker-startup limits, and the regular-expression worker count
- the platform
- the full inherited `PATH`, in order
- the SHA-256 of each regular repository file named directly in `CHECK:`, up to 16 files

A named file is a quoted or bare `CHECK:` word that contains a path separator or ends in a script extension, carries no shell expansion characters, and resolves to a single-link regular file inside the repository. Files under generated or dependency directories (`node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `.next`, `.nuxt`, `.cache`, `vendor`, `.venv`, `venv`, `__pycache__`) stay unbound because they change without review. The `INPUTS:` line of `--review` shows exactly which files are bound.

A change to any bound value produces a new token. When the store holds an approval for the same ledger gate, the review names the fields that differ from the closest one, so a reordered `PATH` or an edited verifier is visible instead of looking like a new oracle.

An approval does not bind:

- files that a named script imports, reads, or executes, or that the command reaches through a shell expansion
- tools found on `PATH`, environment variables other than `PATH`, dependencies, and network services
- the meaning of the gate: an approval is consent to execute, not evidence that the command measures the English outcome

Reinspect changed transitive inputs and run `--reverify`. When a workflow needs machine-enforced identity for them, put expected digests in the `CHECK:` text and validate them with a separately trusted tool.

Automatic evidence carries a separate, environment-independent digest of the parsed `CHECK:`, `EXPECT:`, and raw `CWD:`. `--status` and the Stop hook use it to mark evidence stale when the definition changes, without executing anything. The digest is unkeyed: it detects drift, not tampering.

## Approval store

Approvals live in `~/.unlazy/approved`. `UNLAZY_STATE_DIR` moves the `~/.unlazy` base, and `UNLAZY_APPROVAL_DIR` selects the store directly. The store must be a real, owner-private directory whose canonical path is outside every repository whose ledgers it authorizes, so a repository cannot ship its own approvals. A store that group or others can access fails with the `chmod 700` command that fixes it. A record is accepted only as an owner-private, single-link regular file, read through a no-follow descriptor that still names the same file after reading.

Manage the store by token:

- `--list-approvals` lists each record with its state, gate, approval time, and ledger.
- `--revoke <tokens>` deletes the named records.
- `--prune-approvals` deletes corrupt and outdated records and records whose ledger no longer exists.

Records are unkeyed JSON with no expiry. Any process running as the same user, including an agent, can write one.

Approval and lease locks fail closed instead of being broken automatically. If an owning process dies, confirm that the PID recorded in that specific lock is no longer running and that no operation can still own it, then remove only that lock. Do not bulk-delete lock directories while unlazy is active.

## What unlazy cannot stop

- **Ledger edits.** Anyone who can edit a ledger can mark a manual gate `[x]` with invented evidence, forge a canonical automatic-evidence line, or rewrite a gate so it proves less. A rewritten runnable gate needs a new approval, but approving the weaker oracle is one more token.
- **Self-approval.** An agent can approve its own tokens or write an approval record directly. The approval rule in `SKILL.md` is an instruction.
- **Sessions the hook does not see.** The Stop hook runs only on Claude Code where it is installed, gates only the main session because no SubagentStop handler is installed, and releases after six blocks without progress. A new session starts with no memory of an earlier one.
- **Designed fail-open paths.** The hook allows with a diagnostic when its input is not a JSON object, when the installed `--scope` is invalid or names a scope that no longer exists, and when progress state cannot be written in either store. A pipeline with unmet work and no bound session blocks once to deliver its binding notice, then allows. Each path exists so a broken configuration cannot trap a session.
- **Transitive inputs** described above, and any outcome that a passing oracle does not measure.

Within one session the hook does remember what it saw. A ledger with unmet gates that disappears, and a runnable gate rewritten as manual, both keep blocking until they are restored, handed off with a reason, or released by the no-progress guard.

## Threats and status

| Threat | Status | Mitigation or reason |
|---|---|---|
| Hostile `CHECK:` in an inherited ledger | Mitigated, relies on review | Nothing runs without approval of the exact oracle; review shows the resolved command and bound inputs |
| Oracle or named verifier changed after approval | Mitigated | Every bound field, including named file bytes, changes the token |
| Transitive input changed after approval | Open | Not traced; reinspect and run `--reverify` |
| Repository ships its own approvals | Mitigated | The store must be owner-private and outside the repository |
| Same-user process forges an approval, evidence, or hook state | Accepted | Records and state are unkeyed; unlazy holds no secret to sign with |
| Ledger or dispatch text injected into the model through the hook | Mitigated | The block reason carries counts, qualified ids, and fixed wording; unsafe ledger names become a hash, free-form reasons are never copied, and messages are capped |
| Hook fails open | Accepted | Listed above; the alternative traps sessions |
| Skill supply chain: an install follows a live checkout | Open, warned | The installer warns about uncommitted changes, an untagged checkout, and a version-managed Node; pin installs to a tag or a dedicated worktree |
| Windows timeout leaves a detached grandchild | Accepted | `taskkill /T` ends the tree it can see; a process that left that tree can outlive the timeout |
| Short successful output guessed from its digest | Accepted | Evidence stores a SHA-256 of output; do not print secrets or low-entropy sensitive values |
| Several operating-system users share one pipeline | Unsupported | State, lock, and approval directories are owner-private |
| Stale lock after a crash | Accepted | Locks are never broken automatically; recover by hand as described above |

## Shell and environment

Shell resolution follows `--shell`, then `UNLAZY_SHELL`, then Node's platform default. A bare `--shell` name resolves only through absolute `PATH` entries. The child inherits the whole environment, including `PATH`, so the terminal that launches unlazy can change which tools resolve, especially on Windows.

Prefer the project's test runner or repository-owned scripts, and repository-relative `CWD:` values. A shell override does not install utilities, clean the environment, or restrict access.

Persisted evidence contains the definition digest, the exit status, the match result, a SHA-256 and byte count of the exact string matched by `EXPECT:`, the resolved shell, the working directory relative to the repository, a `PATH` digest and entry count, and the digest of each bound input. Raw successful output is never written. Both the raw stdout and stderr payload and the combined matcher string must fit within 1 MiB; an overflow fails instead of being truncated. Failure diagnostics stay in the terminal, bounded and stripped of terminal controls, line separators, and bidirectional overrides.

Regular-expression expectations run in at most four disposable workers. Each worker gets a five-second startup limit before its separate 250ms match budget, so high `--jobs` values cannot spend the match budget on startup. A timed-out worker is terminated and cannot certify a gate.

See [references/gates.md](references/gates.md) for the full success contract.

## Scopes and leases are not a sandbox

Scopes limit unlazy's gate discovery, log target, hook association, dispatch waves, and lease labels. Ownership leases and dispatch launch barriers coordinate tools that voluntarily use the protocol. Neither mechanism prevents a process from reading or writing another path.

Separate worktrees can reduce ordinary path contention, but they may still share external caches and services. Use operating-system, container, or virtual-machine isolation for untrusted code. See [references/parallel.md](references/parallel.md).

## Stop hook and local state

The optional Claude Code Stop hook reads ledgers and dispatch state and writes one progress file per session. It never executes `CHECK:` commands, resolves an approval oracle, reads the approval store, or creates agent sessions. It validates the same definition digest as `--status`.

Progress state lives in `~/.unlazy/hook-state/`, or under `UNLAZY_STATE_DIR` when set, in a file named by a hash of the session id. When that store is unusable, the hook falls back to an owner-private `unlazy-hook-<uid>` directory under the system temporary directory and says so in its message. Stale state files are pruned. The hook writes nothing into the repository. Scoped pipelines keep their bindings, dispatch state, status log, and locks under `.unlazy/`, which should stay untracked.

The hook blocks while a pipeline it enforces has unmet gates, an invalid ledger, or a dispatch wave that has not sealed. It enforces the project's `GATES.md`, the scope pinned at install, and any scope bound to the current session, found from the session's current directory, `CLAUDE_PROJECT_DIR`, and the nearest ancestor that holds unlazy state. A scope with unmet work and no bound session blocks once per session to deliver a notice with the exact `--bind` command, and then allows. A handoff blocks once, so the report lists it, and later stops are allowed. Repository-derived text reaches the model only as counts, qualified ids, and fixed wording, and every message is capped.

Ledger, binding, lease, dispatch, and hook-state reads are bounded and require an unchanged regular single-link file. Repository-discovered inputs must stay inside the canonical repository root. A named invalid input fails closed instead of disappearing as an empty pipeline, including a pinned scope whose entry exists but is linked, special, unreadable, or outside the root; only a physically absent pinned scope takes the nonblocking path. Nonblocking opens keep FIFOs from wedging the checker or hook. State writes reject symlinked directories and targets, and the status-log append also rejects multi-link files and confirms that its descriptor still names the same file before writing.

### File identity on Windows

On Windows, named-entry `lstat` remains the type, symlink, and link-count guard, while same-file decisions compare BigInt `dev` plus `ino` from the original descriptor and from a second non-creating descriptor opened by name. Bracketing snapshots make ordinary link and replacement races fail closed.

These are snapshot checks, not atomic path isolation. An adversary who can rename or redirect the path during the checks could present one cross-volume target with the same inode to both opens, or replace the name after the final snapshot. Node 16 exposes neither a Windows no-follow open nor handle-to-path primitives that would close those races without a native dependency. Unix keeps `O_NOFOLLOW` and its descriptor-to-path checks.

Node's exposed `st_dev` and `st_ino` can be weaker than a native volume GUID plus a 128-bit file id. BigInt keeps every exposed bit but cannot recover bits the runtime does not expose.

Session ids in bindings and agent handles in dispatch waves are routing values, not secrets or credentials.

### Process cleanup

Each check runs beneath a detached Node supervisor that stays the process-group leader until the shell and every inherited output descriptor close. POSIX group cleanup is attempted only while that exact supervisor is still observed alive; after it exits, its numeric PID and PGID are never signalled, because they may have been reused.

On a Windows timeout, unlazy runs only the drive-root `<drive>:\Windows\System32\taskkill.exe`, and only when `SystemRoot`, `WINDIR`, and `SystemDrive` agree; it never searches the check's directory or `PATH`. Those variables are a consistency check, not proof of operating-system identity. If the helper cannot be located, cleanup falls back to the child handle, and the checker still settles on its own timer. A successful signal request is not treated as proof of exit.

On SIGHUP, SIGINT, or SIGTERM, the checker stops running checks, keeps the results that already finished, and exits `129`, `130`, or `143`.

## Installer targets and privacy

The installer changes Claude Code settings only when invoked:

- default: `.claude/settings.local.json` in the current project
- `--global`: the current user's Claude Code settings
- `--shared`: `.claude/settings.json` in the project

The installed command holds the absolute Node executable and the path to `stop-hook.mjs` exactly as the installer was invoked, so a symlinked skill directory stays a link. At every Stop the hook runs whatever that directory holds, including uncommitted edits on whatever branch is checked out. The installer warns when Node comes from a version manager, when the skill checkout has uncommitted changes, and when it is not at a tagged release. If the Node binary or the script disappears, Claude Code treats the failing hook as non-blocking and enforcement stops without notice; run `install-hooks.mjs --verify` after upgrading Node or moving the skill.

These paths can reveal local directory names, and they make `--shared` non-portable. Prefer the default local target, keep `.claude/settings.local.json` untracked, and review the diff before committing any Claude settings file.

Install and uninstall preserve unrelated hooks. New handlers carry an exact managed marker; legacy handlers are recognized only by an exact old marker and path shape, never by a substring of an unrelated command. The installer follows a symlinked settings file to its target, opens that target without following further links, verifies that the descriptor still names the same single-link regular file, and refuses malformed settings shapes. It writes atomically and keeps the first `<settings-file>.unlazy.bak` it creates, so the backup stays the file as it was before unlazy.

## Evidence and logs

Command output can contain private paths or other sensitive text. Successful output is used only for matching and is then represented by a digest and byte count. Failure diagnostics are visible in the local terminal, so checks must not print secrets on either path. Evidence records the working directory relative to the repository, but the shell path and bound input names can still reveal local layout. Review ledgers, dispatch state, and status logs before committing or sharing them.

A sealed wave records only that the driver wrote a distinct handle string for every declared leaf before a return was accepted. Unlazy cannot confirm a handle with the host: an invented handle, or a hand-written complete wave in `dispatch.json`, passes, and handles are compared only within one wave. A sealed wave proves nothing about CPU overlap, worker honesty, isolation, gates, or integration. Never put prompts, credentials, or result bodies in a handle.

`dispatch.json` is the transition authority, and `status.log` is a later audit append. If that append is refused after a committed transition, the command succeeds with a bounded warning so callers inspect state instead of replaying the transition.

Unlazy collects no telemetry and sends no approval, gate, or hook-state record to any service. A `CHECK:` command can perform its own network or logging activity because it is arbitrary code.

## Reporting a vulnerability

For ordinary defects, open a GitHub issue with a minimal reproduction. For a vulnerability whose reproduction would expose a secret or enable abuse, use GitHub's private vulnerability reporting for this repository if it is available. If it is not available, open a minimal issue asking the maintainer for a private contact method and omit sensitive details until a private channel exists.
