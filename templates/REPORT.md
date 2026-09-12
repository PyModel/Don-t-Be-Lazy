# Report: <task>

Measured at: <timestamp of the --status or --reverify run this report copies from>
Ledger: <GATES.md or .unlazy/<scope>/...>

## Summary

<One sentence stating the measured state, for example: 7 of 11 gates met; 3 unmet; 1 abandoned. Remaining work is larger than finished work: yes/no.>

## Met

- <qualified id>: <outcome, as measured>

## Unmet

- <qualified id>: <what is missing and what was attempted>

## Abandoned, deferred, or awaiting owner decision

- <qualified id or contract id>: <specific cause> - <handoff or decision needed>

## Not started

- <required outcome, roadmap phase, or leaf with no evidence yet>

## Not run or unverified

- <command or claim>: <why it did not run, or why it is unverified>

## Hypotheses

- validated: <claim> - <check that confirmed it and its deciding output line>
- refuted: <claim> - <check that disproved it>
- untested: <claim> - <why it was not checked>

## Assumptions

- <reading chosen where the request was ambiguous>

<!--
Fill every section from the ledger output taken immediately before writing.
Write `none` in a section with nothing to list. Never write "+N more": list
every id. Counts in Summary must equal the ids listed below. A report is not
a done report while Unmet, Abandoned, or Not started contains any item.
See references/reporting.md.
-->
