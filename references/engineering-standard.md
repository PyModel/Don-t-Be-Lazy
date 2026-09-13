# Engineering standard

A met gate proves only the oracle it names. This standard decides what the oracles for changed code must cover before a deliverable counts as done and before an authorized commit lands.

It applies to the code the task changes or owns: the leaf's `OWNS:` paths, or the files in the solo diff. Code outside that scope keeps its existing quality bar. Record a defect you notice there under Risks in the report and keep the task its original size.

## Record a baseline before the first edit

Run the project's own build, lint, type, and test commands once before changing code, and record each outcome in the ledger (a runnable gate, or manual evidence quoting the failing command). A command that already fails is a baseline failure. Completion requires no new failure against that baseline; it does not require repairing checks that were red before the task began unless the contract says so.

## Cover each boundary the change has

Apply a row wherever the language and deliverable actually have that boundary. Each row names the artifact that proves it. A row that applies but has no artifact is reported as `unverified`.

| Row | Applies when the change | Proving artifact |
|---|---|---|
| Complete paths | ships any code | a gate that fails on placeholder, stub, `TODO`, `FIXME`, or test-double markers in shipped changed files |
| Input validation | reads user input, requests, files, environment, configuration, or deserialized data | a test that feeds invalid, empty, and missing values and asserts the defined rejection |
| Failure handling | calls anything that can fail: I/O, network, parsing, subprocess, allocation | one test per reachable failure that asserts its defined, visible outcome |
| Bounded waits | waits on a network call, lock, queue, or child process | a test or configuration assertion showing the timeout |
| Resource release | acquires a handle, connection, timer, subscription, or process | a failure-path test asserting release (closed handle, no leftover process, stable count) |
| Retry and concurrency safety | can be retried, replayed, or run concurrently | a replay or concurrency test |

Test doubles belong inside tests that name them. A feature flag may stage finished, verified code; the flagged path is still held to every row above.

## Gate edge cases inside the contract

Give an edge case a gate when it falls inside the task's contract or `OWNS:` paths, preferably a runnable test that exercises it. List an edge case outside that scope under Risks in the report.

## End the review rounds

Leaf pass 3 hunts defects in review rounds. Append what each round found to the ledger or status log. Stop after the first round that finds nothing new in scope, or after two rounds following the first all-green run, whichever comes first. Each item still open becomes an unmet gate, a handoff, or a Risks entry.

## Check before an authorized commit

Commit only with authority from the user or host. Before each authorized commit, produce and cite these artifacts from this session:

1. The project's checks on the commit's tree, showing no new failure against the baseline.
2. `gate-check --reverify` output for the ledger: `ALL MET`, or a report that names every unmet and handed-off id.
3. The proving artifact for every applicable row above, or an `unverified` entry for each missing one.
4. Every known in-scope defect either fixed with a test that fails before the fix, or recorded as an unmet gate or handoff.

A known in-scope defect blocks a completion claim. It never blocks recording honest partial progress.

## Record handoffs in the ledger

Use one line per handoff, starting at column 1:

```text
ABANDON: G4 DEFERRED: retry backoff needs the queue client from leaf-1.2.1
ABANDON: G5 OWNER_DECISION: keep or drop the legacy CSV importer
ABANDON: G6 upstream API removed the endpoint this gate measures
```

Every form is non-successful handoff state. The checker reports the kind, and the report lists each id.

## Audits and reviews

An audit or review task is complete when every finding is recorded with its evidence and severity. Fixing the findings is a separate deliverable unless the contract includes it.
