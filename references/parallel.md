# Parallel pipelines and leaves

Scopes and ownership leases coordinate cooperating unlazy processes. They prevent accidental cross-certification and refuse declared ownership overlap. They do not sandbox shell commands, enforce operating-system permissions, or stop a process that ignores the protocol from writing any file.

## Layout

```text
.unlazy/
  <scope>/
    PLAN.md
    GATES.md
    gates/
      leaf-*.md
      node-*.md
    dispatch.json
    status.log
    session
  locks/
```

Keep `.unlazy/` untracked. The legacy single-pipeline layout, `GATES.md` plus `gates/*.md` at the project root, remains available for solo work. Stop-hook progress state is not stored in the repository; it lives per user under `~/.unlazy/hook-state/`.

## Scope resolution

A scoped checker invocation selects one pipeline in this order:

1. `--scope <id>`
2. `UNLAZY_SCOPE`
3. the only scope present
4. the legacy layout when no scoped pipeline exists

When several scopes exist and none resolves, the checker refuses instead of running every ledger.

The Stop hook resolves differently, because blocking the wrong session is costly. It enforces the scope pinned with installer `--scope` or `UNLAZY_SCOPE`, each scope whose `session` binding names the current session, and the legacy layout when no scope exists. A scope with unmet work and no binding blocks each session once, to deliver a notice naming the exact `--bind` command, and then allows. A binding associates a session with a scope; it is not authentication.

Use scope ids that match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and are not `.` or `..`. Do not use separators, traversal, or absolute paths.

## What a scope isolates

A scope limits unlazy's own:

- default gate discovery
- status log target
- dispatch waves
- Stop-hook session binding
- lease owner label

A scope does not limit a `CHECK:` process. Checks inherit ambient operating-system access and can read or write outside the scope. Use separate worktrees or stronger process isolation when commands themselves must be isolated.

## Ownership declarations

Declare repository-relative paths before the first gate:

```markdown
OWNS: src/api/**, tests/api/**
```

Reject absolute paths and any path containing a `..` traversal segment. Every leaf dispatched concurrently must declare all paths it may modify and claim them before work:

```text
node <skill-dir>/scripts/gate-check.mjs --scope api --leaf leaf-1.2.1 --claim
```

Claiming checks all existing leases and writes the new lease while holding one global lease lock. Two simultaneous conflicting claims cannot both succeed. A claim is all-or-nothing.

A scope/leaf label is itself exclusive while its lease exists. Repeating the same claim is refused even when the replacement paths are disjoint, and the refused attempt never rewrites the original lease's OWNS path set. Release that exact leaf before claiming it again. This prevents two workers dispatched with the same logical identity from both believing they own one lease.

Lock directories contain JSON owner metadata. Unlazy deliberately does not auto-break an apparently stale lock, because deleting a live owner's path can let two successors enter at once. If a process dies while holding a lock, first verify that its recorded process is no longer running and that no unlazy operation could still own the lock, then remove only that specific abandoned lock manually. Never clear the whole lock directory while work is active. Approval-record locks use the same recovery rule.

Overlap detection is deliberately conservative. It may reject two globs that a full intersection engine could prove disjoint, especially globs with mid-segment wildcards. It must not clear an uncertain pair as safe. It compares paths after Unicode NFC normalization, and without regard to case when the repository's filesystem ignores case, so two spellings of one path conflict. Treat over-conflict as a prompt to use simpler disjoint paths or sequential dispatch.

Examples:

| First declaration | Second declaration | Result |
|---|---|---|
| `src/api/**` | `src/web/**` | disjoint |
| `src/shared/**` | `src/shared/util.mjs` | conflict |
| `src/a*.mjs` | `src/ab*.mjs` | conflict because intersection is possible |
| `**` | `docs/**` | conflict |

Leases cover only declared paths and only participants that honor them. They are coordination records, not write isolation.

A lease record that fails validation blocks every claim, because its paths cannot be known. After confirming that no worker still relies on it, remove such records:

```text
node <skill-dir>/scripts/gate-check.mjs --release-invalid
```

After parent re-verification and manual review, release only that exact leaf and
record the release before promoting any dependent:

```text
node <skill-dir>/scripts/gate-check.mjs --scope api --release --leaf leaf-1.2.1
node <skill-dir>/scripts/gate-check.mjs --scope api --log "leaf-1.2.1 lease released"
```

Release the whole scope only after every leaf has settled, all dispatch waves
are terminal, and branch, root, and final aggregate verification have run. The
scope-wide form is otherwise only for explicit recovery after verifying the
recorded owner is gone:

```text
node <skill-dir>/scripts/gate-check.mjs --scope api --release
```

An unknown `--leaf` is an error. The checker never silently falls back to the first ledger.

## Concurrent ledger updates

The checker serializes each gate-file update and commits it atomically. Before applying a completed check, it re-reads the ledger and confirms that the gate id and oracle fields still match what ran. If the command, expectation, working directory, or other bound oracle field changed in flight, the stale result is discarded.

Updates preserve the ledger's LF or CRLF style, byte-order mark, and file mode. A missing evidence line is inserted without changing unrelated content. Results stay deterministic in gate order even when `--jobs <N>` executes checks concurrently.

The status log is append-only:

```text
node <skill-dir>/scripts/gate-check.mjs --scope api --log "leaf-1.2.1 verified"
```

Append-only logging reduces lost updates; it does not replace the live state fields in `PLAN.md`.

## Session binding and hook state

The Stop hook keeps one progress file per session under `~/.unlazy/hook-state/`, outside every repository. Concurrent hook calls serialize their updates, and one session cannot consume another session's six no-progress blocks. When every enforced gate is met, the hook clears that session's file. A session that changes directory stays enforced, because the hook also checks `CLAUDE_PROJECT_DIR` and the nearest ancestor that holds unlazy state.

Bind the current session to a scope:

```text
node <skill-dir>/scripts/gate-check.mjs --scope api --bind <session-id>
```

The hook's notice for an unbound scope prints this command with the session id filled in. An install pinned with `--scope` enforces that scope for every session instead. Do not treat a stored session id as a secret or identity proof.

## Choose the right isolation level

- Use one working tree and several scopes for read-heavy work or leaves with simple disjoint ownership.
- Use one worktree per pipeline when worktree-local output or generated files would collide. Configure separate cache directories when cache writes can conflict; worktrees do not isolate external caches or services.
- Use operating-system or container isolation for untrusted commands. Unlazy approval and leases are not a sandbox.

Parallelism changes wall-clock time, not the evidence standard. Parent re-verification and branch integration remain required.
