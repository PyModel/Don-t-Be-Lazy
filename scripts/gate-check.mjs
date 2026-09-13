#!/usr/bin/env node
// Execute gate oracles, update evidence, coordinate scopes and leases, and
// manage approvals. Zero dependencies. Node 16+.

import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_AUTOMATIC_EVIDENCE_CHARS, MAX_CHECK_OUTPUT_BYTES, UNLAZY_DIR, appendStatus,
  automaticEvidencePrefix, claimLeases, describeLock, formatDocument, gateDefinitionDigest, gateState,
  insertLine, ledgerLabels, ledgerLockRoot, listScopes, lockOwnerText, parseGates,
  readStableRegularFile, releaseInvalidLeases, releaseLeases, resolveTarget, scopeRoot, sha256,
  validateScopeId, withFileLock, writeAtomic,
} from "./lib/gates.mjs";
import {
  TOKEN_RE, approvalDirectory, approvalKey, approvalOracle, approvalSignature, approvalStatus, approvalToken,
  directoryIdentity,
  indexApprovals, listApprovals, namedInputDigests, nearestPriorApproval, openApprovalStore,
  pruneApprovals, recordApproval, revokeApprovals,
} from "./lib/approval.mjs";
import { terminateProcessTree } from "./lib/process-tree.mjs";
import { dispatchStatus } from "./lib/dispatch.mjs";
import { escapeTerminal, terminalSafeJson } from "./lib/terminal.mjs";

const HELP = `usage: gate-check.mjs [options] [file ...]

run modes:
  (default)             run unmet runnable gates whose exact oracle is approved
  --status              report recorded ledger state; never resolve, execute, approve, or write
  --review              list each runnable oracle, its approval state, and its token; never execute or write
  --reverify            re-run every runnable gate, including met gates
  --approve TOKENS      approve the reviewed oracles named by comma-separated tokens, then run
  --jobs N              rolling concurrency, integer 1..64 (default 1)
  --timeout S           per-check timeout, integer seconds 1..86400 (default 120)
  --shell PATH          command shell (UNLAZY_SHELL, then platform default)
  --cwd DIR             default CHECK directory (explicit: file dir; discovered: --root)
  --show-path           list every PATH entry instead of its digest and entry count
  --json                print one JSON result on stdout; the transcript moves to stderr

approval store:
  --list-approvals      list stored approvals and their tokens
  --revoke TOKENS       delete stored approvals by comma-separated token
  --prune-approvals     delete corrupt, outdated, and orphaned approvals

pipeline actions:
  --claim --scope ID [--leaf NAME]   atomically claim the leaf's OWNS paths
  --release --scope ID [--leaf NAME] release serialized ownership leases
  --release-invalid                  delete lease records that fail validation
  --log TEXT --scope ID              append one status line
  --bind SESSION --scope ID          bind a session to one pipeline
  --list-scopes                      list .unlazy pipelines

targeting:
  --scope ID             use .unlazy/ID (or UNLAZY_SCOPE)
  --root DIR             repository/pipeline root (default current directory)
  file ...               explicit regular ledger files; each is honored once

A CHECK runs only under an approval bound to its exact runtime oracle.
SECURITY.md lists every bound field and what approval does not cover.

exit codes: 0 all met or action succeeded; 1 unmet or handoff; 2 usage, parse,
            or infrastructure; 3 lease conflict; 4 approval required;
            129, 130, 143 interrupted by SIGHUP, SIGINT, SIGTERM.`;

const FLAG_OPTIONS = new Set([
  "--status", "--review", "--reverify", "--claim", "--release", "--release-invalid", "--list-scopes",
  "--list-approvals", "--prune-approvals", "--show-path", "--json", "--help", "-h",
]);
const VALUE_OPTIONS = new Set([
  "--scope", "--leaf", "--timeout", "--jobs", "--cwd", "--root", "--log", "--bind", "--shell",
  "--approve", "--revoke",
]);
const MAX_OUTPUT_BYTES = MAX_CHECK_OUTPUT_BYTES;
const MAX_GATE_LEDGER_BYTES = 8 * 1024 * 1024;
const REGEX_TIMEOUT_MS = 250;
const REGEX_STARTUP_TIMEOUT_MS = 5000;
const MAX_REGEX_WORKERS = 4;
const DEFAULT_TIMEOUT_SECONDS = 120;
const CHECK_SUPERVISOR = fileURLToPath(new URL("./lib/check-supervisor.mjs", import.meta.url));
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// Repository-controlled titles, paths, commands, and output render with
// visible escapes at the final sink. Each console call keeps its newline.
const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
console.log = (...values) => rawLog(...values.map((value) => escapeTerminal(value)));
console.error = (...values) => rawError(...values.map((value) => escapeTerminal(value)));

function failUsage(message) {
  console.error("gate-check: " + message);
  console.error("run gate-check.mjs --help for usage");
  process.exit(2);
}

// Flush both streams before exiting so a large report is never truncated on
// an asynchronous pipe. The returned promise never settles; await it to stop.
function finish(code, payload) {
  const exit = () => process.stderr.write("", () => process.exit(code));
  if (payload !== undefined) process.stdout.write(terminalSafeJson(payload, 2) + "\n", exit);
  else process.stdout.write("", exit);
  return new Promise(() => {});
}

function parseArgs(argv) {
  const options = {};
  const files = [];
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!positional && arg === "--") { positional = true; continue; }
    if (!positional && FLAG_OPTIONS.has(arg)) {
      const key = arg.replace(/^-+/, "");
      if (options[key] !== undefined) return { error: "duplicate option " + arg };
      options[key] = true;
      continue;
    }
    if (!positional && arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (!VALUE_OPTIONS.has(name)) {
        return { error: FLAG_OPTIONS.has(name) ? name + " does not take a value" : "unknown option " + name };
      }
      const key = name.slice(2);
      if (options[key] !== undefined) return { error: "duplicate option " + name };
      const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "") {
        return {
          error: name === "--approve"
            ? "--approve needs the reviewed tokens: run --review, then --approve=<token>[,<token>...]"
            : name + " needs a value",
        };
      }
      options[key] = value;
      continue;
    }
    if (!positional && arg.startsWith("-")) return { error: "unknown option " + arg };
    files.push(arg);
  }
  return { options, files };
}

function boundedInteger(value, name, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(String(value)) || Number(value) > max) {
    failUsage(name + " needs an integer from 1 through " + max + ", got " + JSON.stringify(value));
  }
  return Number(value);
}

function tokenSet(value, name) {
  const tokens = String(value).split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) failUsage(name + " needs at least one token");
  const bad = tokens.find((token) => !TOKEN_RE.test(token));
  if (bad !== undefined) {
    failUsage("invalid " + name + " token " + JSON.stringify(bad) +
      "; tokens are the 16 hex characters printed by --review" +
      (/\.md$/i.test(bad) ? " (a ledger path followed " + name + "; write " + name + "=<tokens> <ledger>)" : ""));
  }
  return new Set(tokens);
}

function asDirectory(path, label) {
  try {
    if (!statSync(path).isDirectory()) failUsage(label + " is not a directory: " + path);
  } catch (error) {
    if (error.code === "ENOENT") failUsage(label + " does not exist: " + path);
    failUsage("cannot inspect " + label + " " + path + ": " + error.message);
  }
}

const parsedArgs = parseArgs(process.argv.slice(2));
if (parsedArgs.error) failUsage(parsedArgs.error);
const { options: opt, files: fileArgs } = parsedArgs;
if (opt.help || opt.h) {
  // HELP is a fixed local constant, so it keeps its layout.
  process.stdout.write(HELP + "\n");
  process.exit(0);
}
const jsonMode = Boolean(opt.json);
const say = (...values) => (jsonMode ? console.error : console.log)(...values);

const storeActions = ["list-approvals", "prune-approvals"].filter((key) => opt[key]);
if (opt.revoke !== undefined) storeActions.push("revoke");
const actionNames = [];
for (const key of ["claim", "release", "release-invalid", "list-scopes"]) if (opt[key]) actionNames.push("--" + key);
for (const key of ["log", "bind"]) if (opt[key] !== undefined) actionNames.push("--" + key);
const runModes = ["status", "review", "reverify"].filter((key) => opt[key]);
if (opt.approve !== undefined) runModes.push("approve");

if (storeActions.length > 1) failUsage("approval store actions are mutually exclusive");
if (actionNames.length > 1) failUsage("pipeline actions are mutually exclusive: " + actionNames.join(", "));
const action = actionNames[0] || null;
const storeAction = storeActions[0] || null;
if (storeAction && (action || runModes.length || fileArgs.length || opt.scope || opt.leaf)) {
  failUsage("--" + storeAction + " stands alone (only --json may accompany it)");
}
if (opt.status && runModes.length > 1) failUsage("--status cannot be combined with --review, --reverify, or --approve");
if (opt.review && (opt.reverify || opt.approve !== undefined)) failUsage("--review never runs or approves; drop --reverify and --approve");
if (action && runModes.length) failUsage(action + " cannot be combined with a run mode");
if (action && fileArgs.length) failUsage(action + " cannot be combined with explicit files");
if (fileArgs.length && opt.scope) failUsage("explicit files and --scope are mutually exclusive");
if (opt.leaf && !opt.claim && !opt.release) failUsage("--leaf is only valid with --claim or --release");
const nonExecuting = Boolean(action || storeAction || opt.status);
if ((opt.timeout || opt.shell || opt.cwd || opt["show-path"]) && nonExecuting) {
  failUsage("--timeout, --shell, --cwd, and --show-path apply only to --review and runs");
}
if (opt.jobs && (nonExecuting || opt.review)) failUsage("--jobs applies only to runs");

const approveTokens = opt.approve === undefined ? null : tokenSet(opt.approve, "--approve");
const root = resolve(opt.root || process.cwd());
asDirectory(root, "--root");
const timeoutSeconds = boundedInteger(opt.timeout, "--timeout", DEFAULT_TIMEOUT_SECONDS, 86400);
const jobs = boundedInteger(opt.jobs, "--jobs", 1, 64);
const defaultCwd = resolve(root, opt.cwd || ".");
if (!nonExecuting) asDirectory(defaultCwd, "--cwd");

// ---------------------------------------------------------- store actions

if (storeAction) {
  let store;
  try { store = openApprovalStore({ create: false }); }
  catch (error) {
    console.error("gate-check: cannot open approval store: " + error.message);
    process.exit(2);
  }
  const location = approvalDirectory().path;
  if (storeAction === "list-approvals") {
    const listing = store ? listApprovals(store) : { records: [], total: 0 };
    for (const record of listing.records) {
      say(record.token + "  " + record.state.toUpperCase() +
        (record.state === "valid"
          ? "  " + qualifyFile(record.file, record.gate) + "  approved " + (record.approvedAt || "unknown") +
            "  " + record.file + (record.ledgerPresent ? "" : "  (ledger missing)")
          : record.problem ? "  " + record.problem : ""));
    }
    say(listing.total + " approval record(s) in " + (store ? store.path : location + " (absent)"));
    await finish(0, jsonMode ? {
      schema: 1, tool: "gate-check", mode: "list-approvals", store: store ? store.path : location,
      approvals: listing.records.map(({ oracle, key, ...record }) => record),
    } : undefined);
  }
  if (storeAction === "revoke") {
    const tokens = [...tokenSet(opt.revoke, "--revoke")];
    const outcome = store ? revokeApprovals(store, tokens) : { removed: [], unmatched: tokens };
    for (const token of outcome.removed) say("REVOKED " + token);
    for (const token of outcome.unmatched) say("NO MATCH " + token);
    const code = outcome.unmatched.length ? 1 : 0;
    await finish(code, jsonMode ? { schema: 1, tool: "gate-check", mode: "revoke", ...outcome, exitCode: code } : undefined);
  }
  const removed = store ? pruneApprovals(store) : [];
  for (const item of removed) say("PRUNED " + item.token + " (" + item.reason + ")");
  say("pruned " + removed.length + " approval record(s)");
  await finish(0, jsonMode ? { schema: 1, tool: "gate-check", mode: "prune-approvals", removed } : undefined);
}

function qualifyFile(file, id) {
  return basename(String(file)).replace(/\.md$/i, "") + ":" + id;
}

// ------------------------------------------------------- pipeline actions

if (action === "--list-scopes") {
  const scopes = listScopes(root);
  if (scopes.length) for (const scope of scopes) say(scope);
  else say("(no pipelines under " + UNLAZY_DIR + "/)");
  process.exit(0);
}

if (action === "--release-invalid") {
  try {
    const removed = await releaseInvalidLeases(root);
    for (const name of removed) say("REMOVED invalid lease record " + name);
    say("removed " + removed.length + " invalid lease record(s)");
    process.exit(0);
  } catch (error) {
    console.error("gate-check: cannot remove invalid leases: " + error.message);
    process.exit(2);
  }
}

if (opt.scope) {
  const error = validateScopeId(opt.scope);
  if (error) failUsage(error);
}

let target = resolveTarget({ root, scope: opt.scope, files: fileArgs });
// A deleted/crashed pipeline can leave coordination leases behind after its
// ledger directory is gone. An explicit, validated release target must remain
// usable for that recovery path; claims still require a live exact ledger.
if (target.error && action === "--release" && opt.scope) {
  target = { mode: "scope", scope: opt.scope, files: [] };
} else if (target.error) failUsage(target.error);
const scope = target.scope;

if (action === "--log") {
  if (!scope) failUsage("--log needs --scope ID or exactly one discoverable pipeline");
  if (!String(opt.log).trim()) failUsage("--log needs non-blank text");
  try {
    const path = appendStatus(root, scope, opt.log);
    say("appended to " + path);
    process.exit(0);
  } catch (error) {
    console.error("gate-check: cannot append status: " + error.message);
    process.exit(2);
  }
}

if (action === "--bind") {
  if (!scope) failUsage("--bind needs --scope ID or exactly one discoverable pipeline");
  const session = String(opt.bind).trim();
  if (!session || session.length > 256 || /[\s]/.test(session)) {
    failUsage("--bind needs one printable session id without spaces, at most 256 characters");
  }
  const path = join(scopeRoot(root, scope), "session");
  try {
    writeAtomic(path, session + "\n", { root });
    say("bound session " + session + " to scope " + scope);
    process.exit(0);
  } catch (error) {
    console.error("gate-check: cannot bind session: " + error.message);
    process.exit(2);
  }
}

if (target.discoveryErrors && target.discoveryErrors.length && action !== "--release") {
  failUsage(target.discoveryErrors.join("; "));
}

if (!target.files.length && action !== "--release") {
  failUsage("no gate files found (looked for " + UNLAZY_DIR + "/<scope>/, then GATES.md and gates/*.md under " + root + ")");
}

const readLedgerFile = (file) => readStableRegularFile(file, {
  ...(target.mode === "explicit" ? {} : { root }),
  maxBytes: MAX_GATE_LEDGER_BYTES,
  label: "gate ledger",
});

for (const file of target.files) {
  try { readLedgerFile(file); }
  catch (error) {
    if (error.code === "ENOENT") failUsage("no such gate file: " + file);
    failUsage("cannot inspect gate file " + file + ": " + error.message);
  }
}

function loadLedger(file) {
  let text;
  try { text = readLedgerFile(file); }
  catch (error) { failUsage("cannot read " + file + ": " + error.message); }
  const doc = parseGates(text);
  for (const warning of doc.warnings) console.error("gate-check: " + file + ": warning: " + warning);
  if (doc.errors.length) {
    for (const error of doc.errors) console.error("gate-check: " + file + ": " + error);
    process.exit(2);
  }
  return { file, doc };
}

if (action === "--claim" || action === "--release") {
  if (!scope) failUsage(action + " needs --scope ID or exactly one discoverable pipeline");
  const stems = target.files.map((file) => basename(file).replace(/\.md$/i, ""));
  if (opt.leaf) {
    const error = validateScopeId(opt.leaf, "leaf");
    if (error) failUsage(error);
    if (stems.length && !stems.includes(opt.leaf)) failUsage("unknown --leaf " + opt.leaf + " (have: " + stems.join(", ") + ")");
  }
  if (action === "--release") {
    try {
      const count = await releaseLeases(root, { scope, leaf: opt.leaf || null });
      say("released " + count + " lease(s) for " + scope + (opt.leaf ? "/" + opt.leaf : ""));
      process.exit(0);
    } catch (error) {
      console.error("gate-check: cannot release leases: " + error.message);
      process.exit(2);
    }
  }

  const leaf = opt.leaf || (stems.length === 1 ? stems[0] : null);
  if (!leaf) failUsage("--claim needs --leaf NAME when a scope has several gate files");
  const selectedFile = target.files.find((file) => basename(file).replace(/\.md$/i, "") === leaf);
  const selected = loadLedger(selectedFile);
  if (!selected.doc.owns.length) failUsage(basename(selected.file) + " declares no OWNS paths");
  let result;
  try { result = await claimLeases(root, { scope, leaf, globs: selected.doc.owns }); }
  catch (error) {
    console.error("gate-check: cannot claim leases: " + error.message);
    process.exit(2);
  }
  if (!result.ok) {
    if (result.error) failUsage(result.error);
    for (const conflict of result.conflicts) {
      if (conflict.identity) {
        say("CONFLICT " + conflict.with + " already holds a live lease; release it before claiming again");
      } else if (conflict.invalid) {
        say("CONFLICT " + conflict.glob + " is blocked by invalid lease record " + conflict.with +
          "; inspect it, then remove it with --release-invalid");
      } else {
        say("CONFLICT " + conflict.glob + " overlaps " + conflict.theirGlob + " held by " + conflict.with);
      }
    }
    say("CLAIM REFUSED (" + result.conflicts.length + " conflict(s))");
    process.exit(3);
  }
  say("CLAIMED " + result.globs.length + " path(s) for " + scope + "/" + leaf + ": " + result.globs.join(", "));
  process.exit(0);
}

// ------------------------------------------------------------- ledgers

let ledgers = target.files.map(loadLedger);
const labels = ledgerLabels(target.files);
const label = (file, id) => labels.get(file) + ":" + id;
const resultKey = (file, id) => resolve(file) + "\0" + id;
const mode = opt.status ? "status" : opt.review ? "review" : opt.reverify ? "reverify" : "run";
if (target.duplicates) say("note: " + target.duplicates + " duplicate ledger argument(s) ignored");

function canonicalPath(file) {
  try { return realpathSync(file); }
  catch { return resolve(file); }
}

const canonicalHome = canonicalPath(homedir());

// The tree a ledger's commands, named inputs, and evidence paths belong to:
// --root or the discovery root, else the nearest ancestor of an explicit
// ledger that holds .git, else that ledger's lock root.
function repositoryRootFor(file) {
  if (target.mode !== "explicit" || opt.root) return canonicalPath(root);
  let directory = dirname(canonicalPath(file));
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return ledgerLockRoot(file);
    directory = parent;
  }
}

function resolvedGateCwd(gate, file) {
  // Explicit ledgers are self-contained: absent --cwd, relative commands and
  // CWD attributes anchor beside that ledger instead of wherever the caller
  // happened to launch the checker. Scoped and legacy discovery anchor at root.
  const base = opt.cwd ? defaultCwd : (target.mode === "explicit" ? dirname(resolve(file)) : root);
  return gate.cwd ? resolve(base, gate.cwd) : base;
}

function stateReason(state) {
  return state === "unmet" ? "unchecked"
    : state === "unmet-no-evidence" ? "checked but EVIDENCE pending"
      : "checked but automatic evidence is stale or unbound";
}

// ------------------------------------------------------------- runtime

function executableCandidates(name) {
  if (process.platform !== "win32") return [name];
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [name, ...extensions.map((extension) => name + extension.toLowerCase()), ...extensions.map((extension) => name + extension.toUpperCase())];
}

function resolveShell(raw) {
  const requested = raw || process.env.UNLAZY_SHELL || (process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh");
  const containsSeparator = requested.includes("/") || requested.includes("\\") || isAbsolute(requested);
  const candidates = [];
  let relativeEntries = 0;
  if (containsSeparator) candidates.push(resolve(process.cwd(), requested));
  else {
    for (const directory of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
      // A relative PATH entry resolves against whatever directory the checker
      // was launched from, so it never selects the shell.
      if (!isAbsolute(directory)) { relativeEntries++; continue; }
      for (const name of executableCandidates(requested)) candidates.push(join(directory, name));
    }
  }
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      if (relativeEntries) console.error("gate-check: warning: ignored " + relativeEntries + " relative PATH entr" + (relativeEntries === 1 ? "y" : "ies") + " while resolving the shell");
      return resolve(candidate);
    } catch { /* not an executable regular file; keep looking */ }
  }
  failUsage("cannot resolve an executable command shell " + JSON.stringify(requested) +
    (containsSeparator ? "" : " from absolute PATH entries"));
}

// Status is a pure function of ledger text: no shell, PATH, or approval store.
const shell = opt.status ? null : resolveShell(opt.shell);
const pathValue = opt.status ? null : String(process.env.PATH || "");
const pathEntries = opt.status ? [] : (pathValue ? pathValue.split(delimiter) : []);
const pathDigest = opt.status ? null : sha256(pathValue).slice(0, 12);
const pathEvidence = opt.status ? null : pathDigest + "/" + pathEntries.length + " entries";

function oracleFor(gate, file) {
  const cwd = resolvedGateCwd(gate, file);
  const ledger = canonicalPath(file);
  const inputRoot = repositoryRootFor(file);
  const oracle = approvalOracle({
    check: gate.check,
    expect: gate.expect,
    cwd,
    cwdIdentity: directoryIdentity(cwd),
    ledgerDirectoryIdentity: directoryIdentity(dirname(ledger)),
    shell,
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    regexTimeoutMs: REGEX_TIMEOUT_MS,
    regexStartupTimeoutMs: REGEX_STARTUP_TIMEOUT_MS,
    maxRegexWorkers: MAX_REGEX_WORKERS,
    platform: process.platform,
    path: pathValue,
    inputs: namedInputDigests(gate.check, cwd, inputRoot),
  });
  return { cwd, ledger, inputRoot, oracle };
}

const tasks = [];
if (!opt.status) {
  for (const ledger of ledgers) {
    for (const gate of ledger.doc.gates) {
      if (ledger.doc.abandoned.has(gate.id) || !gate.check) continue;
      const state = gateState(gate, ledger.doc.abandoned);
      const task = {
        file: ledger.file,
        gate,
        label: label(ledger.file, gate.id),
        key: resultKey(ledger.file, gate.id),
        startingState: state,
        wasMet: state === "met",
        scheduled: opt.review ? false : (opt.reverify || state !== "met"),
        definitionDigest: gateDefinitionDigest(gate),
      };
      try {
        Object.assign(task, oracleFor(gate, ledger.file));
        task.approvalSignature = approvalSignature(task.oracle);
      } catch (error) {
        const cwd = resolvedGateCwd(gate, ledger.file);
        task.cwd = cwd;
        task.unresolved = error && error.code === "ENOENT"
          ? "CWD does not exist: " + cwd
          : "cannot resolve the oracle for " + cwd + ": " + (error && error.message);
      }
      tasks.push(task);
    }
  }
}

// The approval store must not sit inside a tree whose ledgers it authorizes.
// The user's home directory is not such a tree even when it holds a ledger.
const forbiddenRoots = [...new Set(target.files.map(repositoryRootFor)
  .concat(target.mode === "explicit" && !opt.root ? [] : [canonicalPath(root)]))]
  .filter((item) => item !== canonicalHome);

let store = null;
let approvalIndex = null;
let approvalInfrastructureFailures = 0;
if (!opt.status && tasks.length) {
  try { store = openApprovalStore({ create: false, forbiddenRoots }); }
  catch (error) {
    console.error("gate-check: could not validate approvals: " + error.message);
    process.exit(2);
  }
  for (const task of tasks) {
    if (task.unresolved) continue;
    task.token = approvalToken(approvalKey(task.ledger, task.gate.id, task.oracle));
    try {
      const status = approvalStatus(store, task.ledger, task.gate.id, task.oracle);
      task.approved = status.approved;
      if (status.corrupt) {
        console.error("gate-check: approval record " + status.path + " for " + task.label +
          " is corrupt or does not match its oracle; run --prune-approvals");
      }
    } catch (error) {
      console.error("gate-check: could not validate approval for " + task.label + ": " + error.message);
      task.approvalError = error.message;
      approvalInfrastructureFailures++;
    }
  }
}

function printOracle(task, prefix) {
  say(prefix + " " + task.label);
  say("    CHECK: " + task.gate.check);
  say("    EXPECT: " + task.gate.expect);
  say("    CWD: " + task.cwd);
  say("    SHELL: " + shell);
  if (opt["show-path"]) {
    say("    PATH: " + pathEntries.length + " entries");
    for (const entry of pathEntries) say("      " + entry);
  } else {
    say("    PATH: sha256:" + pathDigest + " (" + pathEntries.length + " entries); --show-path lists them");
  }
  say("    INPUTS: " + (task.oracle.inputs.length
    ? task.oracle.inputs.map(([path, digest]) => path + " sha256:" + digest.slice(0, 12)).join(", ")
    : "(none bound: CHECK names no repository script outside generated directories)"));
  if (!task.approved && store) {
    if (!approvalIndex) approvalIndex = indexApprovals(store);
    const prior = nearestPriorApproval(approvalIndex, task.ledger, task.gate.id, task.oracle);
    if (prior) {
      const details = prior.differences.map((field) => {
        if (field !== "path" || typeof prior.oracle.path !== "string") return field;
        const before = new Set(prior.oracle.path.split(delimiter));
        const after = new Set(pathEntries);
        const added = [...after].filter((entry) => !before.has(entry)).length;
        const removed = [...before].filter((entry) => !after.has(entry)).length;
        return "path (+" + added + "/-" + removed + " entries)";
      });
      say("    PRIOR: approval " + prior.token + " for this gate differs only in " + details.join(", "));
    }
  }
  say("    TOKEN: " + task.token);
}

// ----------------------------------------------------------------- review

if (opt.review) {
  const needed = [];
  let unresolved = 0;
  for (const task of tasks) {
    if (task.unresolved) {
      unresolved++;
      say("UNRESOLVED " + task.label + ": " + task.unresolved);
      continue;
    }
    if (task.approvalError) continue;
    printOracle(task, task.approved ? "APPROVED" : "APPROVAL REQUIRED");
    if (!task.approved) needed.push(task);
  }
  const approvedCount = tasks.filter((task) => task.approved).length;
  say("REVIEW: " + tasks.length + " runnable oracle(s): " + approvedCount + " approved, " +
    needed.length + " need approval, " + unresolved + " unresolved");
  if (needed.length) say("  approve after reading each oracle above: --approve=" + needed.map((task) => task.token).join(","));
  const code = approvalInfrastructureFailures ? 2 : needed.length ? 4 : unresolved ? 1 : 0;
  await finish(code, jsonMode ? {
    schema: 1, tool: "gate-check", mode: "review", measuredAt: new Date().toISOString(), scope,
    oracles: tasks.map((task) => ({
      id: task.label, approved: Boolean(task.approved), token: task.token || null,
      check: task.gate.check, expect: task.gate.expect, cwd: task.cwd, shell,
      path: { sha256: pathDigest, entries: pathEntries.length },
      inputs: task.oracle ? task.oracle.inputs.map(([path, digest]) => ({ path, sha256: digest })) : [],
      error: task.unresolved || task.approvalError || null,
    })),
    exitCode: code,
  } : undefined);
}

// ------------------------------------------------------- approve and run

if (approveTokens) {
  const known = new Set(tasks.filter((task) => task.token).map((task) => task.token));
  const unknown = [...approveTokens].filter((token) => !known.has(token));
  if (unknown.length) {
    failUsage("approval token(s) " + unknown.join(", ") + " match no current oracle; the ledger, CWD, shell, " +
      "PATH, timeout, or a named script changed since review. Run --review again");
  }
}

// Probe each ledger lock before any execution: a lock whose recorded owner is
// not running would otherwise discard finished results after a long wait.
if (!opt.status) {
  for (const file of [...new Set(tasks.filter((task) => task.scheduled).map((task) => task.file))]) {
    const info = describeLock(ledgerLockRoot(file), file);
    if (info.exists && info.alive === false) {
      console.error("gate-check: ledger lock " + info.path + " for " + file + " is stale (" + lockOwnerText(info) +
        "); remove that lock file, then run again");
      process.exit(2);
    }
  }
}

const runnable = [];
const approvalRequired = [];
const precomputed = [];
if (!opt.status) {
  for (const task of tasks) {
    if (task.approvalError) continue;
    if (task.unresolved) {
      if (task.scheduled) precomputed.push(task);
      continue;
    }
    if (!task.approved && approveTokens && approveTokens.has(task.token)) {
      try {
        if (!store) store = openApprovalStore({ create: true, forbiddenRoots });
        await recordApproval(store, task.ledger, task.gate.id, task.oracle, {
          reviewedPathForm: opt["show-path"] ? "entries" : "digest",
        });
        task.approved = true;
        say("APPROVED " + task.label + " token " + task.token);
      } catch (error) {
        console.error("gate-check: could not record approval for " + task.label + ": " + error.message);
        approvalInfrastructureFailures++;
        continue;
      }
    }
    if (!task.scheduled) continue;
    if (!task.approved) {
      printOracle(task, "APPROVAL REQUIRED");
      say("    NOT RUN: read this oracle, then re-run with --approve=" + task.token);
      approvalRequired.push(task);
      continue;
    }
    runnable.push(task);
  }
}
if (approvalInfrastructureFailures && !runnable.length && !precomputed.length) {
  console.error("gate-check: infrastructure failure prevented " + approvalInfrastructureFailures + " approval(s)");
  process.exit(2);
}

for (const task of runnable) {
  say("  RUN  " + task.label + " shell=" + shell + " cwd=" + task.cwd + " path=sha256:" + pathEvidence);
}

let activeRegexWorkers = 0;
const regexWaiters = [];

function acquireRegexWorker() {
  if (activeRegexWorkers < MAX_REGEX_WORKERS) {
    activeRegexWorkers++;
    return Promise.resolve();
  }
  return new Promise((done) => regexWaiters.push(done));
}

function releaseRegexWorker() {
  const next = regexWaiters.shift();
  if (next) next();
  else activeRegexWorkers--;
}

async function safeRegexMatch(expectation, output) {
  if (expectation.kind === "text") return { matched: output.includes(expectation.value) };
  await acquireRegexWorker();
  try {
    return await new Promise((done) => {
      let worker;
      let settled = false;
      let startupTimer = null;
      let matchTimer = null;
      const finishMatch = (value) => {
        if (settled) return;
        settled = true;
        if (startupTimer) clearTimeout(startupTimer);
        if (matchTimer) clearTimeout(matchTimer);
        if (worker) worker.terminate().catch(() => {});
        done(value);
      };
      try { worker = new Worker(new URL("./lib/regex-worker.mjs", import.meta.url)); }
      catch (error) {
        finishMatch({ matched: false, error: "EXPECT worker could not start: " + error.message });
        return;
      }
      startupTimer = setTimeout(() => finishMatch({
        matched: false,
        error: "EXPECT worker startup exceeded " + REGEX_STARTUP_TIMEOUT_MS + "ms",
      }), REGEX_STARTUP_TIMEOUT_MS);
      worker.once("online", () => {
        if (settled) return;
        clearTimeout(startupTimer);
        startupTimer = null;
        // The catastrophic-backtracking budget starts only after the worker is
        // online; process startup and a busy --jobs queue are not regex time.
        matchTimer = setTimeout(() => finishMatch({
          matched: false,
          error: "EXPECT regex exceeded " + REGEX_TIMEOUT_MS + "ms",
        }), REGEX_TIMEOUT_MS);
        try { worker.postMessage({ source: expectation.source, flags: expectation.flags, output }); }
        catch (error) { finishMatch({ matched: false, error: error.message }); }
      });
      worker.once("message", (message) => finishMatch(message));
      worker.once("error", (error) => finishMatch({ matched: false, error: error.message }));
      worker.once("exit", (code) => {
        finishMatch({ matched: false, error: "EXPECT worker exited " + code + " without a result" });
      });
    });
  } finally {
    releaseRegexWorker();
  }
}

function outputFingerprint(output) {
  const value = String(output);
  return { sha256: sha256(value), bytes: Buffer.byteLength(value, "utf8") };
}

const activeStops = new Set();
let interrupted = null;

function unexecuted(task, error) {
  return {
    ...task, ok: false, output: "", outputFingerprint: outputFingerprint(""),
    exitCode: null, signal: null, matched: false, error,
  };
}

function runCheck(task) {
  return new Promise((done) => {
    if (interrupted) {
      done({ ...unexecuted(task, "not started: interrupted by " + interrupted), interrupted: true });
      return;
    }
    // Re-check the approved identity immediately before spawning, closing the
    // gap between approval lookup and execution, including a --jobs queue.
    let identity = null;
    try { identity = directoryIdentity(task.cwd); } catch { identity = null; }
    if (!identity || identity.join("\0") !== task.oracle.cwdIdentity.join("\0")) {
      done(unexecuted(task, "CWD changed identity after approval: " + task.cwd + "; run --review again"));
      return;
    }
    if (JSON.stringify(namedInputDigests(task.gate.check, task.cwd, task.inputRoot)) !==
        JSON.stringify(task.oracle.inputs)) {
      done(unexecuted(task, "a repository script named in CHECK changed after approval; run --review again"));
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let rawOverflow = false;
    let timedOut = false;
    let spawnError = null;
    let closed = false;
    let closeStreamsTimer = null;
    let forceSettleTimer = null;
    let timeoutTimer = null;
    let cleanupDiagnostic = null;
    let child;

    const settle = async (exitCode, signal) => {
      if (closed) return;
      closed = true;
      activeStops.delete(stopChild);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (closeStreamsTimer) clearTimeout(closeStreamsTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      const output = stdout + (stdout && stderr ? "\n" : "") + stderr;
      // EXPECT and persisted fingerprints both use this exact combined string.
      // Keep its UTF-8 representation within the same 1 MiB ceiling as raw
      // capture: invalid byte replacement and the stream separator can expand
      // it even when the child emitted exactly MAX_OUTPUT_BYTES raw bytes.
      const fingerprint = outputFingerprint(output);
      const normalizedOverflow = fingerprint.bytes > MAX_OUTPUT_BYTES;
      const overflow = rawOverflow || normalizedOverflow;
      const stoppedByInterrupt = Boolean(interrupted);
      const match = timedOut || overflow || spawnError || stoppedByInterrupt
        ? { matched: false }
        : await safeRegexMatch(task.gate.expectation, output);
      const cleanupSuffix = cleanupDiagnostic ? "; cleanup: " + cleanupDiagnostic : "";
      const error = stoppedByInterrupt ? "stopped: interrupted by " + interrupted + cleanupSuffix
        : timedOut ? "timed out after " + timeoutSeconds + "s" + cleanupSuffix
          : overflow ? "output exceeded " + MAX_OUTPUT_BYTES + " bytes" +
            (rawOverflow ? "" : " after stdout/stderr UTF-8 combination") + cleanupSuffix
            : spawnError ? spawnError.message
              : match.error || null;
      done({
        ...task, output, outputFingerprint: fingerprint,
        exitCode, signal, matched: Boolean(match.matched), error,
        interrupted: stoppedByInterrupt,
        ok: !error && exitCode === 0 && Boolean(match.matched),
      });
    };

    function stopChild() {
      if (closeStreamsTimer) return;
      const cleanup = terminateProcessTree(child);
      cleanupDiagnostic = cleanup.diagnostic;
      // A descendant that escaped the shell can otherwise keep inherited pipes
      // open forever. We still settle through the child's close event, after
      // giving stdio a short grace period to drain.
      closeStreamsTimer = setTimeout(() => {
        try { child.stdout.destroy(); } catch { /* already closed */ }
        try { child.stderr.destroy(); } catch { /* already closed */ }
      }, 1000);
      // A successful signal request is not proof that a child closed or that
      // every pipe-holding descendant exited. Settle independently after the
      // bounded helper attempt for every cleanup outcome, while retaining any
      // explicit cleanup failure in the result.
      forceSettleTimer = setTimeout(() => {
        try { child.stdout.destroy(); } catch { /* already closed */ }
        try { child.stderr.destroy(); } catch { /* already closed */ }
        try { child.unref(); } catch { /* unavailable */ }
        settle(null, null);
      }, 1500);
    }

    const capture = (stream, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining > 0) chunks[stream].push(buffer.subarray(0, remaining));
      bytes += buffer.length;
      if (bytes > MAX_OUTPUT_BYTES && !rawOverflow) {
        rawOverflow = true;
        stopChild();
      }
    };

    const groupLeader = process.platform !== "win32";
    try {
      child = spawn(process.execPath, [CHECK_SUPERVISOR, shell, task.gate.check, groupLeader ? "--group-leader" : "--single"], {
        cwd: task.cwd,
        shell: false,
        windowsHide: true,
        detached: groupLeader,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      done(unexecuted(task, error.message));
      return;
    }
    activeStops.add(stopChild);
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.once("error", (error) => { spawnError = error; });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutSeconds * 1000);
    child.once("close", settle);
  });
}

function failureOutput(output, max = 480) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 8) return (lines.join(" | ") || "(no output)").slice(0, max);
  const summary = [...lines.slice(0, 6), "...", ...lines.slice(-2)].join(" | ");
  return summary.slice(0, max);
}

function evidenceFor(result) {
  const clean = (value) => escapeTerminal(value).replace(/[\r\n\t]+/g, " ");
  const fingerprint = result.outputFingerprint;
  // Compare canonical forms: a lexical alias such as /var versus /private/var
  // would otherwise make an in-repository CWD look outside and leak its path.
  const base = canonicalPath(result.inputRoot || root);
  const relativeCwd = relative(base, canonicalPath(result.cwd));
  const cwdText = relativeCwd === "" ? "." : relativeCwd.startsWith("..") || isAbsolute(relativeCwd)
    ? result.cwd : relativeCwd.split("\\").join("/");
  const inputsText = result.oracle.inputs.length
    ? "; inputs=" + result.oracle.inputs.map(([path, digest]) =>
      encodeURI(path).replace(/[,;@]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase()) +
      "@" + digest.slice(0, 12)).join(",")
    : "";
  // Keep the definition binding and successful-output fingerprint ahead of
  // machine-specific fields so the evidence cap can truncate only transcript
  // detail, never the structural currentness or deciding output identity.
  return (automaticEvidencePrefix(result.definitionDigest) +
    " exit=0; EXPECT=matched; output-sha256=" + fingerprint.sha256 +
    "; output-bytes=" + fingerprint.bytes + "; shell=" + clean(shell) +
    "; cwd=" + clean(cwdText) + "; path=" + pathEvidence + inputsText).slice(0, MAX_AUTOMATIC_EVIDENCE_CHARS);
}

function insertOrUpdateEvidence(doc, gate, value) {
  if (gate.evidenceLine !== -1) {
    const indent = (doc.lines[gate.evidenceLine].match(/^\s*/) || ["  "])[0];
    doc.lines[gate.evidenceLine] = indent + "EVIDENCE: " + value;
    return;
  }
  let line = gate.line + 1;
  while (line < doc.lines.length && /^\s+(CHECK|EXPECT|EVIDENCE|CWD):/.test(doc.lines[line])) line++;
  insertLine(doc, line, "  EVIDENCE: " + value);
}

const confirmed = new Set();
const staleResults = new Map();
let writeFailures = 0;

async function writeResult(result) {
  if (result.interrupted) return;
  try {
    await withFileLock(ledgerLockRoot(result.file), result.file, () => {
      const doc = parseGates(readLedgerFile(result.file));
      if (doc.errors.length) throw new Error("fresh ledger became invalid: " + doc.errors.join("; "));
      const fresh = doc.gates.find((gate) => gate.id === result.gate.id);
      let changed = !fresh || gateDefinitionDigest(fresh) !== result.definitionDigest;
      if (!changed && result.oracle) {
        try { changed = approvalSignature(oracleFor(fresh, result.file).oracle) !== result.approvalSignature; }
        catch { changed = true; }
      }
      if (changed) {
        staleResults.set(result.key, result.label);
        say("  STALE " + result.label + ": definition or runtime approval oracle changed; result not written");
        return;
      }
      if (gateState(fresh, doc.abandoned) === "abandoned") return;
      const mustWriteFailure = result.startingState === "stale-unmet" ||
        (opt.reverify && result.wasMet) || fresh.checked;
      if (!result.ok && !mustWriteFailure) return;
      if (result.ok) {
        doc.lines[fresh.line] = doc.lines[fresh.line].replace(/^- \[( |x|X)\]/, "- [x]");
        insertOrUpdateEvidence(doc, fresh, evidenceFor(result));
      } else {
        doc.lines[fresh.line] = doc.lines[fresh.line].replace(/^- \[(x|X)\]/, "- [ ]");
        insertOrUpdateEvidence(doc, fresh, "pending");
      }
      writeAtomic(result.file, formatDocument(doc));
      if (result.ok) confirmed.add(result.key);
    });
  } catch (error) {
    console.error("gate-check: cannot update " + result.file + ": " + error.message);
    writeFailures++;
  }
}

function printResult(result) {
  if (result.interrupted) {
    say("  STOPPED " + result.label + ": " + result.error);
    return;
  }
  const fingerprint = result.outputFingerprint;
  const outputSummary = result.ok
    ? "sha256=" + fingerprint.sha256 + "; bytes=" + fingerprint.bytes
    : failureOutput(result.output);
  const outcome = "exit=" + (result.exitCode === null ? "none" : result.exitCode) +
    (result.signal ? " signal=" + result.signal : "") +
    "; EXPECT=" + (result.matched ? "matched" : "not matched") +
    "; output=" + outputSummary;
  say("  " + (result.ok ? "PASS " : "FAIL ") + result.label + ": " + result.gate.title);
  say("       " + (!result.ok && result.error ? result.error + "; " : "") + outcome);
}

// Results print in ledger order but are written as each check settles, so an
// interruption keeps every result that already finished.
async function runAll() {
  const ordered = [
    ...precomputed.map((task) => ({ task, immediate: unexecuted(task, task.unresolved) })),
    ...runnable.map((task) => ({ task })),
  ];
  const results = new Array(ordered.length);
  let printed = 0;
  let next = 0;
  let writeQueue = Promise.resolve();
  const settled = (index, result) => {
    results[index] = result;
    writeQueue = writeQueue.then(() => writeResult(result));
    while (printed < results.length && results[printed]) printResult(results[printed++]);
  };
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    console.error("gate-check: " + signal + " received; stopping " + activeStops.size + " running check(s)");
    for (const stop of [...activeStops]) stop();
  };
  const signals = Object.keys(SIGNAL_EXIT_CODES);
  for (const signal of signals) process.on(signal, onSignal);
  try {
    async function worker() {
      for (;;) {
        const index = next++;
        if (index >= ordered.length) return;
        const item = ordered[index];
        settled(index, item.immediate || await runCheck(item.task));
      }
    }
    const workers = [];
    for (let index = 0; index < Math.min(jobs, ordered.length); index++) workers.push(worker());
    await Promise.all(workers);
    await writeQueue;
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
  return results;
}

const results = opt.status ? [] : await runAll();

// --------------------------------------------------------------- summary

ledgers = target.files.map(loadLedger);
const met = [];
const selfCertified = [];
const unmet = [];
const handoffs = [];
const gateRows = [];
const approvalNeededKeys = new Set(approvalRequired.map((task) => task.key));
let hasRunnableMet = false;

for (const ledger of ledgers) {
  for (const gate of ledger.doc.gates) {
    const id = label(ledger.file, gate.id);
    const key = resultKey(ledger.file, gate.id);
    const runnableGate = Boolean(gate.check);
    let state = gateState(gate, ledger.doc.abandoned);
    let reason = null;
    if (state === "abandoned") {
      const kind = ledger.doc.handoffKinds.get(gate.id) || "ABANDONED";
      handoffs.push({ id, kind });
      gateRows.push({ id, state: kind.toLowerCase(), runnable: runnableGate, title: gate.title });
      continue;
    }
    if (state === "met" && runnableGate && opt.reverify && !confirmed.has(key)) {
      state = "unmet";
      reason = staleResults.has(key) ? "stale result discarded"
        : approvalNeededKeys.has(key) ? "reverify not run: approval required"
          : "reverify not run";
    }
    if (state === "met") {
      met.push(id);
      if (runnableGate) hasRunnableMet = true;
      else selfCertified.push(id);
      gateRows.push({ id, state: runnableGate ? "met" : "self-certified", runnable: runnableGate, title: gate.title });
    } else {
      reason = reason || stateReason(state);
      unmet.push({ id, reason, title: gate.title });
      gateRows.push({ id, state: "unmet", reason, runnable: runnableGate, title: gate.title });
    }
  }
  say(basename(ledger.file) + ": " + ledger.doc.gates.length + " gates");
}

// A scoped pipeline is complete only when both its ledgers and its native
// dispatch waves are resolved, independent of the optional Stop hook.
const aggregateDispatch = dispatchStatus(root, scope);
if (aggregateDispatch.errors.length) {
  for (const error of aggregateDispatch.errors) console.error("gate-check: " + error);
  process.exit(2);
}
for (const id of aggregateDispatch.blocking) unmet.push({ id, reason: "dispatch wave incomplete", title: "" });
for (const id of aggregateDispatch.abandoned) handoffs.push({ id, kind: "ABANDONED" });

for (const item of unmet) say("  UNMET " + item.id + (item.reason ? " (" + item.reason + ")" : "") + (item.title ? ": " + item.title : ""));
for (const item of handoffs) say("  HANDOFF " + item.id + " (" + item.kind + ")");
for (const id of selfCertified) say("  SELF-CERTIFIED " + id + " (manual gate; evidence written by hand)");

const where = scope ? " [scope " + scope + "]" : "";
const reverified = results.filter((result) => result.wasMet && confirmed.has(result.key)).length;
const verifyNote = opt.reverify
  ? ", reran: " + results.filter((result) => !result.interrupted && result.oracle).length +
    ", previously met reverified: " + reverified
  : "";
const certifiedNote = selfCertified.length ? ", " + selfCertified.length + " self-certified manual" : "";
const kindCounts = new Map();
for (const item of handoffs) kindCounts.set(item.kind, (kindCounts.get(item.kind) || 0) + 1);

if (interrupted) {
  say("INTERRUPTED by " + interrupted + ": results that finished before the signal were written; run again to finish");
} else if (!unmet.length && !handoffs.length && !approvalRequired.length) {
  say("ALL MET (" + met.length + " met" + certifiedNote + verifyNote + ")" + where);
} else {
  if (handoffs.length) {
    const onlyAbandoned = kindCounts.size === 1 && kindCounts.has("ABANDONED");
    say("HANDOFF REQUIRED: " + (onlyAbandoned
      ? handoffs.length + " abandoned"
      : handoffs.length + " handoff(s): " + [...kindCounts].map(([kind, count]) =>
        count + " " + kind.toLowerCase().replace("_", " ")).join(", ")) +
      " (met: " + met.length + (unmet.length ? ", unmet: " + unmet.length : "") + verifyNote + ")" + where);
  }
  if (unmet.length) {
    say("UNMET: " + unmet.length + " (met: " + met.length + (handoffs.length ? ", handoffs: " + handoffs.length : "") +
      verifyNote + ")" + where);
  }
  if (approvalRequired.length) {
    say("APPROVAL REQUIRED: " + approvalRequired.length + " oracle(s) not run; read each oracle above, then run with --approve=" +
      approvalRequired.map((task) => task.token).join(","));
  }
}
if (opt.status && hasRunnableMet) {
  say("note: --status reads recorded evidence only; run --reverify before reporting or committing");
}
const measuredAt = new Date().toISOString();
say("measured at " + measuredAt);

let exitCode;
if (writeFailures || approvalInfrastructureFailures) {
  if (approvalInfrastructureFailures) {
    console.error("gate-check: infrastructure failure prevented " + approvalInfrastructureFailures + " approval(s)");
  }
  exitCode = 2;
} else if (interrupted) exitCode = SIGNAL_EXIT_CODES[interrupted];
else if (approvalRequired.length) exitCode = 4;
else if (unmet.length || handoffs.length) exitCode = 1;
else exitCode = 0;

await finish(exitCode, jsonMode ? {
  schema: 1,
  tool: "gate-check",
  mode,
  measuredAt,
  root,
  scope,
  ledgers: ledgers.map((ledger) => ({ file: ledger.file, label: labels.get(ledger.file), gates: ledger.doc.gates.length })),
  counts: {
    met: met.length,
    selfCertified: selfCertified.length,
    unmet: unmet.length,
    handoffs: handoffs.length,
    approvalRequired: approvalRequired.length,
    rerun: results.filter((result) => !result.interrupted && result.oracle).length,
    reverified,
  },
  gates: gateRows,
  unmet,
  handoffs,
  selfCertified,
  approvalRequired: approvalRequired.map((task) => ({ id: task.label, token: task.token })),
  dispatch: { blocking: aggregateDispatch.blocking, abandoned: aggregateDispatch.abandoned },
  results: results.map((result) => ({
    id: result.label, ok: result.ok, exitCode: result.exitCode, signal: result.signal,
    matched: result.matched, error: result.error, interrupted: Boolean(result.interrupted),
  })),
  interrupted,
  exitCode,
} : undefined);
