# Report: <task>

Measured at: <the "measured at" time printed by the --reverify run this report copies from>
Ledger: <GATES.md or .unlazy/<scope>/...>

## Summary

<One sentence stating the measured state, for example: 7 of 11 gates met; 3 unmet; 1 handed off. Task finished: yes/no. Remaining work is larger than finished work: yes/no.>

## Met

- <qualified id>: <outcome, as measured>

## Self-certified

- <qualified id>: <manual outcome> - <artifact and location cited as evidence; reviewed by the user: yes/no>

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

## Risks, trade-offs, and limits

- <trade-off, vulnerability, bottleneck, race, or resource bound>: <mechanics and root cause> - <systemic impact and disposition>

## Assumptions

- <reading chosen where the request was ambiguous>

<!--
Fill every section from the --reverify output taken immediately before writing.
Write `none` in a section with nothing to list. Never write "+N more": list
every id. Counts in Summary must equal the ids listed below. The report is
complete when every section is filled; the task is finished only when Unmet,
Abandoned, and Not started all read `none`. See references/reporting.md.
-->
