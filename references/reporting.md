# Truthful reporting

The checker proves gates. It cannot read the report you write, so the report is the layer where a confident sentence can outrun the evidence. This contract makes every completion sentence traceable to something measured in this session.

## Report only what was measured

- **Re-verify before writing.** Run `--reverify` immediately before composing the report, and copy counts, gate states, and the `measured at` time from its output. `--status` reads recorded evidence without executing, and a plain run skips gates already met, so neither shows whether the artifact still passes. A number remembered from earlier in the session is stale by definition.
- **Quote only observed output.** Paste command output, test results, file contents, and evidence lines only from commands that ran in this session. A command that did not run is reported as `not run`, with the reason. There is no honest way to predict what a command would have printed.
- **Label every unverified claim.** When a statement rests on reading rather than running, say `unverified` next to it. When it rests on a run you could not complete, say what was attempted and where it stopped.
- **Name the mismatch when the ledger and the artifact disagree.** A green ledger with an artifact you know to be wrong is a defect in the gate, not a pass. Report both and fix the gate.
- **Claim a property only with its artifact.** "Thread-safe", "leak-free", "idempotent", and "production-ready" each need a check that exercises the property, such as a concurrency test, a handle count, or a replay test. Without one, write `unverified`. No check proves an absolute guarantee, so report what was measured.
- **Report self-certified manual gates as such.** The checker prints `SELF-CERTIFIED` for a met manual gate, because someone wrote its evidence by hand. When that was you, cite the exact artifact and location in the evidence, list the gate under Self-certified in the report, and ask the user to review any consequential one. Solo mode has no independent reviewer; say so instead of implying one.
- **State risks as found.** Put each trade-off, vulnerability, bottleneck, resource bound, race, out-of-scope defect, and out-of-scope edge case in the report's Risks section with its mechanism and impact.

## Disclose every remaining item

The remaining-work section is the part of the report the user most needs and the part most often shortened. Its length is set by the work, never by the report.

- **List every unmet, abandoned, deferred, and owner-decision item by qualified id.** `leaf-1.2.1:G3`, `node-1.1:N2`, `C4`. Do not collapse them into "+N more". The checker lists every id; only the bounded Stop-hook message shortens its list that way.
- **Include the work you did not start.** A required outcome with no gate yet, a roadmap phase not begun, a leaf never dispatched: each is a line in the remaining list, not an omission.
- **State the true size.** When the remaining work is larger than the finished work, say so in one sentence at the top of the report. A long remaining list is correct output, not a failure of the report.
- **Keep the counts consistent.** The met, unmet, and handoff counts in the summary equal the number of ids listed beneath them. Reconcile before sending.

## Complete report versus finished task

A complete report fills every section of `templates/REPORT.md`, writing `none` where a section has nothing to list. A finished task is one whose Unmet, Abandoned, deferred, or awaiting owner decision, and Not started sections all read `none`. A report that names one blocker and four finished items is complete, and its summary still says the task is not finished.

## Say early and plainly what cannot be done

- **Report impossibility at the moment it is known**, not at the end. Record it in the ledger as `ABANDON: <id> <specific cause>`, `ABANDON: <id> DEFERRED: <cause>`, or `ABANDON: <id> OWNER_DECISION: <question>`, or in the PLAN inventory as `DEFERRED` or `OWNER_DECISION`, then continue every part that does not depend on it.
- **Name the specific cause.** "Needs credentials for the staging database that this session does not hold" is a cause. "Needs more investigation" is not.
- **Finish the rest.** Impossibility of one item is never grounds to stop the others or to shrink the request. Narrowing the task to the parts that could be done is not a complete report.
- **Use only the user's authority to remove scope.** `REMOVED_BY_USER` requires the user's explicit words. Everything else stays visible as non-completion.

## Hypotheses are allowed; facts need a check

Forming a hypothesis is how diagnosis and design start, and it is welcome. What is not allowed is a hypothesis wearing the grammar of a fact.

- **Label it while it is one.** Write `hypothesis:` in front of any causal or factual claim you have not yet checked, in working notes and in the report alike.
- **Validate with a runnable check, then cite the run.** A hypothesis becomes a fact only after a command, test, or direct observation in this session confirms it. Name the command and paste the deciding line of its output next to the claim.
- **Report the refuted ones too.** A hypothesis that a check disproved is a finding: record it as `refuted:` with the check, so the next reader does not re-run the same dead end.
- **Keep untested hypotheses out of the completion claim.** A report may list `untested:` hypotheses under Not run or unverified. It may not count them toward met work or use them to explain away an unmet gate.
- **Prefer a gate.** When a hypothesis matters to acceptance, turn its validation into a runnable gate with `CHECK:` and `EXPECT:` so the checker, not the prose, decides it.

## Long tasks and roadmaps

Long work produces the strongest pull toward a summary that sounds finished. For any task spanning several sessions, waves, or roadmap phases:

- **Report per phase.** For each phase or wave: state `VERIFIED`, `IN-FLIGHT`, `READY`, `WAITING`, or `ABANDONED`, with the ids behind that state.
- **Report from the ledger, never from the plan.** A phase listed in the plan is not a phase done. Only current evidence in its ledger moves it to `VERIFIED`.
- **Carry remaining work forward unchanged.** When a session ends mid-task, the handoff lists every remaining id and its state so the next session starts from measured state rather than from the last summary.
- **Give the honest estimate and its basis.** If asked how much remains, count ids and phases from the PLAN dispatch table and say what the count is based on. Never present a guess as a measurement.

## Report shape

Use `templates/REPORT.md` for any report that follows a ledger. Fill every section; write `none` in a section with nothing to list, so an empty section is a statement rather than a gap. The `Assumptions` section names each reading you chose when the request was ambiguous, so the user can reject one instead of discovering it later.

### Short form for a small solo task

A solo task with a handful of gates may use this short form, provided it keeps every disclosure:

```text
Measured at <time> by --reverify on GATES.md: <met> met, <unmet> unmet, <handoffs> handoff(s).
Unmet: <each id and what is missing, or none>
Handoffs: <each id with its kind and cause, or none>
Self-certified: <each id with the artifact it cites, or none>
Not run or unverified: <each command or claim with the reason, or none>
Risks: <each item, or none>
```

Switch to the full template as soon as any line needs more than one sentence.
