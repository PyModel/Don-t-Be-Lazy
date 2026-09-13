# Gates: <branch name> integration

Summary: integrate children <explicit child ids> into one verified result

- [ ] N1: every named direct child is reverified from its exact ledger
  CHECK: node "<skill-dir>/scripts/gate-check.mjs" --root . --cwd . --reverify --jobs 1 .unlazy/<scope>/gates/leaf-<a>.md .unlazy/<scope>/gates/node-<b>.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] N2: child interfaces match the contract in PLAN.md
  CHECK: node scripts/verify-interfaces.mjs
  EXPECT: interface verification passed
  EVIDENCE: pending

- [ ] N3: cross-child behavior works end to end
  CHECK: node scripts/verify-integration.mjs
  EXPECT: integration verification passed
  EVIDENCE: pending

- [ ] N4: affected sibling behavior has not regressed
  CHECK: node scripts/verify-regressions.mjs
  EXPECT: regression verification passed
  EVIDENCE: pending

- [ ] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: pending

- [ ] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: pending

<!--
Replace every placeholder before running the checker. Write <skill-dir> as the
absolute path of the directory holding SKILL.md. That path is part of N1's
definition digest and approval, so N1 is specific to this machine.

N1 must name every direct child ledger explicitly, whether that child is a leaf
or another branch, and use --reverify, not --status. Status validates the stored
definition binding without executing or inspecting current artifacts. Keep
--jobs 1 unless the child checks are independent and deterministic parallel
execution is intentional.

Review and approve N1 after its children are verified. Its approval binds the
bytes of the child ledgers it names, so a later child change needs a new N1
token. N1 fails when a child oracle lacks approval under the same directory and
PATH, because the nested checker exits 4; review that child with --review and
approve its tokens first.

If a child reports a handoff, N1 exits 1 with `HANDOFF REQUIRED`. Mark the
branch ABANDONED and surface the handoff; never rewrite that result as completion.

Branch paths use node-<id>.md. Leaf paths use leaf-<id>.md. Branch completion
requires integration evidence; a set of locally complete leaves is not enough.

For N5, run this once for each direct leaf child after verification and record
the outputs as manual evidence. Branch children do not own leaf leases:

node <skill-dir>/scripts/gate-check.mjs --scope <scope> --leaf leaf-<id> --release

Drop N5 only when no child claimed ownership. See references/orchestration.md
and references/parallel.md.
-->
