#!/usr/bin/env node
// plan-check.mjs: validate an orchestrated PLAN.md without executing anything.
// Zero dependencies. Node 16+.
//
//   node plan-check.mjs [--require C1,C2,...] [--json] .unlazy/<scope>/PLAN.md
//
// Checks the leaf dispatch table against the topology tree and the contract
// inventory against the ledgers beside the plan. It cannot read the user's
// request: pass the reread inventory ids with --require to detect omitted rows.
// Prints "PLAN OK" only when the plan is well formed and every row is ACTIVE.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGates, readStableRegularFile } from "./lib/gates.mjs";
import { escapeTerminal, terminalSafeJson } from "./lib/terminal.mjs";

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_BYTES = 300;
const LEAF_ID_RE = /^\d+(?:\.\d+)+$/;
const CONTRACT_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PLACEHOLDER_RE = /<[^<>\s][^<>]*>/;
export const LEAF_STATES = new Set(["WAITING", "READY", "IN-FLIGHT", "VERIFIED", "ABANDONED"]);
export const TIERS = new Set(["mechanical", "judgment"]);
export const DISPOSITIONS = new Set(["ACTIVE", "ABANDONED", "DEFERRED", "OWNER_DECISION", "REMOVED_BY_USER"]);
const DISPATCH_HEADER = ["Leaf", "Owns", "Needs", "Tier", "Planned wave", "State"];
const CONTRACT_HEADER = ["ID", "Required outcome or constraint", "Owner", "Observing gate or manual review", "Disposition", "Revision"];

function sections(source) {
  const lines = source.split(/\r?\n/);
  return {
    lines,
    section(name, problems) {
      const marker = "## " + name;
      const starts = [];
      for (let i = 0; i < lines.length; i++) if (lines[i].trim() === marker) starts.push(i);
      if (starts.length !== 1) {
        problems.push(marker + " occurs " + starts.length + " times");
        return [];
      }
      let end = lines.length;
      for (let i = starts[0] + 1; i < lines.length; i++) {
        if (/^##\s+/.test(lines[i])) { end = i; break; }
      }
      return lines.slice(starts[0] + 1, end);
    },
  };
}

function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

// Read one markdown table that starts at the header row matching `header`.
function readTable(block, header, label, problems) {
  const headerIndex = block.findIndex((line) => {
    const row = cells(line);
    return row && row[0] === header[0];
  });
  if (headerIndex < 0) {
    problems.push(label + " has no header");
    return [];
  }
  if (JSON.stringify(cells(block[headerIndex])) !== JSON.stringify(header)) {
    problems.push(label + " header must be: " + header.join(", "));
  }
  const separator = cells(block[headerIndex + 1] || "");
  if (!separator || separator.length !== header.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    problems.push(label + " has an invalid separator");
  }
  const rows = [];
  for (let i = headerIndex + 2; i < block.length; i++) {
    const row = cells(block[i]);
    if (!row) {
      if (rows.length && block[i].trim() === "") break;
      continue;
    }
    if (row.length !== header.length) {
      problems.push(label + " row has " + row.length + " cells: " + row.join(" | "));
      continue;
    }
    rows.push(row);
  }
  if (!rows.length) problems.push(label + " has no rows");
  return rows;
}

// Structure of the tree and the leaf dispatch table: one authority per field,
// consistent states, and dependencies planned before their dependents.
export function planStructureProblems(source) {
  const problems = [];
  const { lines, section } = sections(source);
  const rows = readTable(section("Leaf dispatch table", problems), DISPATCH_HEADER, "leaf dispatch table", problems);

  const byId = new Map();
  for (const [id, owns, needsText, tier, waveText, state] of rows) {
    if (!LEAF_ID_RE.test(id)) problems.push("invalid leaf id: " + id);
    if (byId.has(id)) problems.push("duplicate leaf row: " + id);
    if (!owns || owns === "-") problems.push(id + " has no Owns paths");
    if (!TIERS.has(tier)) problems.push(id + " has invalid Tier: " + tier);
    if (!/^[1-9]\d*$/.test(waveText)) problems.push(id + " has invalid Planned wave: " + waveText);
    if (!LEAF_STATES.has(state)) problems.push(id + " has invalid State: " + state);
    const needs = needsText === "-" ? [] : needsText.split(",").map((value) => value.trim());
    if (needs.some((value) => !LEAF_ID_RE.test(value))) problems.push(id + " has invalid Needs: " + needsText);
    byId.set(id, { needs, state, wave: Number(waveText) });
  }

  for (const [id, row] of byId) {
    let blocked = false;
    for (const dependency of row.needs) {
      const target = byId.get(dependency);
      if (!target) {
        problems.push(id + " needs unknown leaf " + dependency);
        blocked = true;
        continue;
      }
      if (dependency === id) problems.push(id + " depends on itself");
      if (target.wave >= row.wave) problems.push(id + " is not planned after " + dependency);
      if (target.state !== "VERIFIED") blocked = true;
    }
    if (row.state === "WAITING" && !blocked) problems.push(id + " is WAITING without a blocked dependency");
    if (["READY", "IN-FLIGHT", "VERIFIED"].includes(row.state) && blocked) {
      problems.push(id + " is " + row.state + " with a blocked dependency");
    }
  }

  // A tree line is a leaf when its ledger path is gates/leaf-<id>.md.
  const topologyLeaves = [];
  const topologyIds = new Set();
  for (const line of section("Tree", problems)) {
    const node = line.match(/^\s*-\s+(\d+(?:\.\d+)*)\s/);
    if (!node) continue;
    topologyIds.add(node[1]);
    if (/\b(?:Owns|Needs|Tier|Wave|State)\b/i.test(line)) problems.push("tree repeats an operational field: " + line.trim());
    const leaf = line.match(/gates\/leaf-(\d+(?:\.\d+)+)\.md\s*$/);
    if (!leaf) continue;
    if (leaf[1] !== node[1]) problems.push("tree line " + node[1] + " points at leaf-" + leaf[1] + ".md");
    topologyLeaves.push(leaf[1]);
  }
  const tableLeaves = [...byId.keys()].sort();
  const treeLeaves = [...topologyLeaves].sort();
  if (new Set(topologyLeaves).size !== topologyLeaves.length) problems.push("tree repeats a leaf id");
  if (JSON.stringify(treeLeaves) !== JSON.stringify(tableLeaves)) {
    problems.push("tree/table leaf sets differ: tree=" + treeLeaves.join(",") + " table=" + tableLeaves.join(","));
  }

  if (lines.some((line) => line.trim() === "## Dispatch schedule")) problems.push("separate dispatch schedule is forbidden");
  if (lines.some((line) => /^\s*-\s*Wave\s+\d+/i.test(line))) problems.push("wave list duplicates Planned wave");
  return { problems, topologyIds };
}

// Pure reconciliation of a contract inventory. `owners` and `observations`
// are the live names; `coverage`, when given, maps an observation to the
// contract ids it demonstrably observes.
export function reviewContract(spec) {
  const gaps = [];
  const handoffs = [];
  const rows = new Map();
  for (const row of spec.rows) {
    if (rows.has(row.id)) gaps.push(row.id + ": duplicate row");
    rows.set(row.id, row);
  }
  const required = spec.required || [...rows.keys()];
  for (const id of required) {
    const row = rows.get(id);
    if (!row) { gaps.push(id + ": missing row"); continue; }
    if (row.revision !== spec.revision) gaps.push(id + ": stale revision");
    if (row.disposition === "REMOVED_BY_USER") {
      if (!spec.removedByUser.has(id)) gaps.push(id + ": removal lacks explicit user authority");
      continue;
    }
    if (row.disposition !== "ACTIVE") {
      handoffs.push(id + " (" + row.disposition + ")");
      continue;
    }
    if (!row.owner || !spec.owners.has(row.owner)) gaps.push(id + ": missing or stale owner");
    if (!row.observation || !spec.observations.has(row.observation)) {
      gaps.push(id + ": missing or stale observation");
    } else if (spec.coverage && spec.coverage.has(row.observation) && !spec.coverage.get(row.observation).has(id)) {
      gaps.push(id + ": observation does not cover outcome");
    }
  }
  return { gaps, handoffs };
}

// The ledgers beside a plan: GATES.md and gates/*.md, named by file stem the
// way gate-check qualifies ids.
function ledgerGateIds(planPath, problems) {
  const directory = dirname(planPath);
  const files = [];
  if (existsSync(join(directory, "GATES.md"))) files.push(join(directory, "GATES.md"));
  const gatesDir = join(directory, "gates");
  if (existsSync(gatesDir)) {
    for (const name of readdirSync(gatesDir).sort()) if (name.endsWith(".md")) files.push(join(gatesDir, name));
  }
  const ids = new Set();
  for (const file of files) {
    const stem = basename(file).replace(/\.md$/i, "");
    let doc;
    try {
      doc = parseGates(readStableRegularFile(file, { maxBytes: MAX_LEDGER_BYTES, label: "gate ledger" }));
    } catch (error) {
      problems.push("cannot read ledger " + stem + ": " + error.message);
      continue;
    }
    if (doc.errors.length) problems.push("ledger " + stem + " has " + doc.errors.length + " parse error(s); run gate-check.mjs --status on it");
    for (const gate of doc.gates) ids.add(stem + ":" + gate.id);
  }
  return ids;
}

export function contractProblems(source, { planPath = null, required = null } = {}) {
  const problems = [];
  const { lines, section } = sections(source);
  const block = section("Current contract inventory", problems);
  const revisionLine = block.find((line) => /Contract revision:/.test(line));
  const revisionMatch = revisionLine && revisionLine.match(/Contract revision:\s*([1-9]\d*)\b/);
  if (!revisionMatch) problems.push("contract inventory has no \"Contract revision: N\" line");
  const revision = revisionMatch ? Number(revisionMatch[1]) : null;
  const tableRows = readTable(block, CONTRACT_HEADER, "contract inventory", problems);

  const { topologyIds } = planStructureProblems(lines.join("\n"));
  // Owners are tree ids, bare or with the leaf-/node- ledger prefix, plus the
  // driver that owns root-level outcomes.
  const owners = new Set(["driver", "root"]);
  for (const id of topologyIds) for (const prefix of ["", "leaf-", "node-"]) owners.add(prefix + id);
  const observations = planPath ? ledgerGateIds(planPath, problems) : new Set();
  const removedByUser = new Set();
  const rows = [];
  for (const [id, outcome, owner, observation, disposition, revisionText] of tableRows) {
    if (!CONTRACT_ID_RE.test(id)) problems.push("invalid contract id: " + id);
    for (const [name, value] of [["outcome", outcome], ["owner", owner], ["observation", observation]]) {
      if (PLACEHOLDER_RE.test(value)) problems.push(id + ": unreplaced placeholder in " + name + ": " + value);
    }
    if (!DISPOSITIONS.has(disposition)) problems.push(id + ": invalid Disposition: " + disposition);
    if (!/^[1-9]\d*$/.test(revisionText)) problems.push(id + ": invalid Revision: " + revisionText);
    // A manual review is observed by its reviewer, not a ledger gate.
    if (/^manual:\s*\S/.test(observation)) observations.add(observation);
    if (disposition === "REMOVED_BY_USER" && /^user:\s*\S/.test(observation)) removedByUser.add(id);
    rows.push({ id, owner, observation, disposition, revision: Number(revisionText) });
  }
  const { gaps, handoffs } = reviewContract({
    rows, required, revision, owners, observations, removedByUser,
  });
  if (!planPath) {
    // Without the plan's location the ledgers cannot be read; report that
    // instead of calling every gate observation stale.
    return { problems: [...problems, ...gaps.filter((gap) => !gap.endsWith("missing or stale observation"))], handoffs };
  }
  return { problems: [...problems, ...gaps], handoffs };
}

// ------------------------------------------------------------------- CLI

const HELP = `usage: plan-check.mjs [--require IDS] [--json] PLAN.md

Validates an orchestrated PLAN.md without executing anything:
  - the leaf dispatch table: ids, Owns, Needs, Tier, Planned wave, State
  - the topology tree matches the table and repeats no operational field
  - the contract inventory: ids, revision, owners, dispositions, placeholders
  - each ACTIVE row names a live owner and an observation that exists:
    a qualified gate such as leaf-1.2.1:G3 in a ledger beside the plan, or
    "manual: <reviewer and evidence>"
  - a REMOVED_BY_USER row cites the user's words as "user: <quote>"

options:
  --require IDS   comma-separated contract ids from rereading the request;
                  without it, omitted rows cannot be detected
  --json          print one JSON result on stdout

exit codes: 0 PLAN OK; 1 findings or a non-ACTIVE row (handoff); 2 usage or read error`;

function finish(code, text) {
  process.stdout.write(text + "\n", () => process.exit(code));
}

function main(argv) {
  let json = false;
  let requireText = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return finish(0, HELP);
    if (arg === "--json") { json = true; continue; }
    if (arg === "--require" || arg.startsWith("--require=")) {
      requireText = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (requireText === undefined) return finish(2, "plan-check: --require needs comma-separated ids");
      continue;
    }
    if (arg.startsWith("-")) return finish(2, "plan-check: unknown option " + escapeTerminal(arg, MAX_FIELD_BYTES) + "\n" + HELP);
    files.push(arg);
  }
  if (files.length !== 1) return finish(2, "plan-check: name exactly one PLAN.md\n" + HELP);
  const required = requireText === null ? null
    : requireText.split(",").map((value) => value.trim()).filter(Boolean);
  if (required && (!required.length || required.some((id) => !CONTRACT_ID_RE.test(id)))) {
    return finish(2, "plan-check: --require needs comma-separated contract ids such as C1,C2");
  }

  const planPath = resolve(files[0]);
  let source;
  try {
    source = readStableRegularFile(planPath, { maxBytes: MAX_PLAN_BYTES, label: "plan" });
  } catch (error) {
    return finish(2, "plan-check: " + escapeTerminal(error.message, MAX_FIELD_BYTES));
  }
  const structure = planStructureProblems(source).problems;
  const contract = contractProblems(source, { planPath, required });
  const problems = [...structure, ...contract.problems];
  const code = problems.length || contract.handoffs.length ? 1 : 0;
  const verdict = problems.length ? "PLAN FINDINGS" : contract.handoffs.length ? "HANDOFF REQUIRED" : "PLAN OK";

  if (json) {
    return finish(code, terminalSafeJson({
      schema: 1, tool: "plan-check", verdict, denominator: required ? "required" : "table rows only",
      findings: problems, handoffs: contract.handoffs,
    }, 2));
  }
  const out = [];
  for (const problem of problems) out.push("FINDING " + escapeTerminal(problem, MAX_FIELD_BYTES));
  for (const handoff of contract.handoffs) out.push("HANDOFF " + escapeTerminal(handoff, MAX_FIELD_BYTES));
  if (!required) out.push("note: omitted contract rows are not detected without --require");
  out.push(verdict + " (" + problems.length + " finding(s), " + contract.handoffs.length + " handoff(s))");
  return finish(code, out.join("\n"));
}

// Compare real paths: the skill is usually reached through a symlinked skills
// directory, and Node reports the main module by its real path.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (invokedDirectly()) main(process.argv.slice(2));
