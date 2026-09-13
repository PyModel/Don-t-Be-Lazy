// Approval identity, review tokens, and the owner-private approval store.
// Zero dependencies. Node 16+.
//
// An approval is consent to execute one exact runtime oracle. Its identity is
// a pure function of the oracle fields below, so tests can prove each binding
// without spawning a process.

import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, statSync, unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import {
  assertPrivateEntry, pathIsInside, privateDirectory, readStableRegularFile, sameFileIdentity, sha256,
  statCurrentNamedFile, unlazyStateHome, withFileLock, writeAtomic,
} from "./gates.mjs";

export const APPROVAL_SCHEMA = 2;
export const MAX_APPROVAL_BYTES = 256 * 1024;
export const MAX_NAMED_INPUTS = 16;
export const MAX_NAMED_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_STORE_SCAN = 4096;
export const TOKEN_RE = /^[a-f0-9]{16}$/;
const RECORD_NAME_RE = /^[a-f0-9]{64}\.json$/;
const SCRIPT_EXTENSION_RE = /\.(?:mjs|cjs|js|mts|cts|ts|py|sh|bash|zsh|ps1|rb|pl|php)$/i;
const SHELL_EXPANSION_RE = /[$*?`|;&<>()]/;
// Build output and dependency trees change without a reviewer editing them, so
// binding their bytes would only churn approvals. A CHECK that names a file
// inside one of these directories stays unbound; the INPUTS line lists only
// the files that are bound.
export const GENERATED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".cache",
  "vendor", ".venv", "venv", "__pycache__",
]);

function inGeneratedDirectory(relativePath) {
  return relativePath.split("/").slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment));
}

export function approvalDirectory() {
  const configured = process.env.UNLAZY_APPROVAL_DIR;
  return configured && configured.trim()
    ? { path: resolve(configured), source: "UNLAZY_APPROVAL_DIR" }
    : { path: join(unlazyStateHome(), "approved"), source: "default" };
}

export function directoryIdentity(path) {
  const info = statSync(path, { bigint: true });
  if (!info.isDirectory()) throw new Error("not a directory: " + path);
  return [String(info.dev), String(info.ino)];
}

// Words a shell would pass as file operands: quoted or bare tokens that look
// like a path or a script and carry no shell expansion characters.
export function commandInputCandidates(check) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(check))) !== null) {
    const token = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
    if (!token || token.startsWith("-") || SHELL_EXPANSION_RE.test(token)) continue;
    if (token.includes("/") || token.includes("\\") || SCRIPT_EXTENSION_RE.test(token)) tokens.push(token);
  }
  return tokens;
}

export function fileDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Bind the bytes of regular, single-link repository files named directly in
// CHECK. Imports, fixtures, and other transitive inputs of those files stay
// unbound; the review listing shows exactly which files are bound.
export function namedInputDigests(check, cwd, root) {
  let canonicalRoot;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch { return []; }
  const inputs = [];
  const seen = new Set();
  for (const candidate of commandInputCandidates(check)) {
    if (inputs.length >= MAX_NAMED_INPUTS) break;
    let canonical;
    try {
      const absolute = resolve(cwd, candidate);
      if (!lstatSync(absolute).isFile()) continue;
      canonical = realpathSync(absolute);
    } catch {
      continue;
    }
    if (seen.has(canonical) || !pathIsInside(canonicalRoot, canonical)) continue;
    const relativePath = relative(canonicalRoot, canonical).split(sep).join("/");
    if (inGeneratedDirectory(relativePath)) continue;
    let bytes;
    try {
      bytes = readStableRegularFile(canonical, {
        root: canonicalRoot, maxBytes: MAX_NAMED_INPUT_BYTES, label: "named input", raw: true,
      });
    } catch {
      continue;
    }
    seen.add(canonical);
    inputs.push([relativePath, fileDigest(bytes)]);
  }
  return inputs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

export function approvalOracle(fields) {
  return {
    schema: APPROVAL_SCHEMA,
    check: fields.check,
    expect: fields.expect,
    cwd: fields.cwd,
    cwdIdentity: fields.cwdIdentity,
    ledgerDirectoryIdentity: fields.ledgerDirectoryIdentity,
    shell: fields.shell,
    timeoutMs: fields.timeoutMs,
    maxOutputBytes: fields.maxOutputBytes,
    regexTimeoutMs: fields.regexTimeoutMs,
    regexStartupTimeoutMs: fields.regexStartupTimeoutMs,
    maxRegexWorkers: fields.maxRegexWorkers,
    platform: fields.platform,
    path: fields.path,
    inputs: fields.inputs,
  };
}

export const approvalSignature = (oracle) => sha256(JSON.stringify(oracle));
export const approvalKey = (ledger, gateId, oracle) =>
  sha256(String(ledger) + "\0" + String(gateId) + "\0" + approvalSignature(oracle));
export const approvalToken = (key) => String(key).slice(0, 16);

export function oracleDifferences(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return [...keys]
    .filter((key) => JSON.stringify(left && left[key]) !== JSON.stringify(right && right[key]))
    .sort();
}

function describeSource(configured) {
  return configured.source === "default"
    ? "the default store under " + unlazyStateHome()
    : "set by UNLAZY_APPROVAL_DIR";
}

// Open the store, refusing any location inside a tree whose ledgers it would
// authorize: a repository could otherwise ship its own approvals.
export function openApprovalStore({ create = false, forbiddenRoots = [] } = {}) {
  const configured = approvalDirectory();
  const refuse = (location, root) => new Error("approval store " + location + " (" + describeSource(configured) +
    ") is inside the ledger tree " + root + "; set UNLAZY_APPROVAL_DIR to a directory outside it");
  for (const root of forbiddenRoots) {
    if (pathIsInside(root, configured.path)) throw refuse(configured.path, root);
  }
  const store = privateDirectory(configured.path, { create });
  if (!store) return null;
  for (const root of forbiddenRoots) {
    let canonicalRoot;
    try { canonicalRoot = realpathSync(root); }
    catch { canonicalRoot = resolve(root); }
    if (pathIsInside(canonicalRoot, store.path)) throw refuse(store.path, canonicalRoot);
  }
  return { ...store, source: configured.source };
}

export function assertStoreUnchanged(store) {
  const current = lstatSync(store.path, { bigint: true });
  assertPrivateEntry(store.path, current, "directory");
  if (!sameFileIdentity(current, store)) throw new Error("approval directory changed during use: " + store.path);
}

function readRecordFile(path) {
  let fd = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0);
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0) | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    const named = statCurrentNamedFile(path, { maxBytes: MAX_APPROVAL_BYTES, label: "approval record" });
    assertPrivateEntry(path, opened, "file");
    if (opened.size > MAX_APPROVAL_BYTES) {
      throw new Error("approval record exceeds " + MAX_APPROVAL_BYTES + " bytes: " + path);
    }
    assertPrivateEntry(path, named, "file");
    if (opened.nlink !== 1n || !sameFileIdentity(named, opened)) {
      throw new Error("refusing linked or replaced approval record " + path);
    }
    const text = readFileSync(fd, "utf8");
    const after = statCurrentNamedFile(path, { maxBytes: MAX_APPROVAL_BYTES, label: "approval record" });
    assertPrivateEntry(path, after, "file");
    if (!sameFileIdentity(after, opened)) {
      throw new Error("approval record changed while it was read: " + path);
    }
    return text;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* the read result is already decided */ }
  }
}

export function readApproval(store, key) {
  const path = join(store.path, key + ".json");
  let text;
  try { text = readRecordFile(path); }
  catch (error) {
    if (error && error.code === "ENOENT") return { state: "missing", path };
    if (error && error.code === "ELOOP") throw new Error("refusing linked approval record " + path);
    throw error;
  }
  assertStoreUnchanged(store);
  let value;
  try { value = JSON.parse(text); }
  catch { return { state: "corrupt", path }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "corrupt", path };
  return { state: "present", path, value };
}

export function approvalStatus(store, ledger, gateId, oracle) {
  const key = approvalKey(ledger, gateId, oracle);
  const token = approvalToken(key);
  if (!store) return { approved: false, corrupt: false, key, token, path: null };
  const record = readApproval(store, key);
  if (record.state !== "present") {
    return { approved: false, corrupt: record.state === "corrupt", key, token, path: record.path };
  }
  const value = record.value;
  const approved = value.schema === APPROVAL_SCHEMA && value.file === ledger && value.gate === gateId &&
    value.signature === approvalSignature(oracle);
  return { approved, corrupt: !approved, key, token, path: record.path };
}

export async function recordApproval(store, ledger, gateId, oracle, extra = {}) {
  const key = approvalKey(ledger, gateId, oracle);
  const path = join(store.path, key + ".json");
  await withFileLock(null, path, () => {
    writeAtomic(path, JSON.stringify({
      schema: APPROVAL_SCHEMA,
      file: ledger,
      gate: gateId,
      token: approvalToken(key),
      signature: approvalSignature(oracle),
      oracle,
      approvedAt: new Date().toISOString(),
      ...extra,
    }, null, 2) + "\n");
    assertStoreUnchanged(store);
  }, { lockDir: join(store.path, "locks"), timeoutMs: 10000 });
  return { key, token: approvalToken(key), path };
}

function recordNames(store) {
  return readdirSync(store.path).filter((name) => RECORD_NAME_RE.test(name)).sort();
}

export function listApprovals(store, { limit = Infinity } = {}) {
  const names = recordNames(store);
  const records = [];
  for (const name of names.slice(0, limit)) {
    const key = name.slice(0, 64);
    const token = approvalToken(key);
    let record;
    try { record = readApproval(store, key); }
    catch (error) {
      records.push({ key, token, state: "unreadable", problem: error.message });
      continue;
    }
    const value = record.value;
    if (record.state !== "present" || value.schema !== APPROVAL_SCHEMA ||
        typeof value.file !== "string" || typeof value.gate !== "string") {
      records.push({ key, token, state: record.state === "present" ? "outdated" : record.state });
      continue;
    }
    let ledgerPresent = false;
    try { ledgerPresent = statSync(value.file).isFile(); } catch { ledgerPresent = false; }
    records.push({
      key, token, state: "valid", file: value.file, gate: value.gate,
      approvedAt: typeof value.approvedAt === "string" ? value.approvedAt : null,
      ledgerPresent, oracle: value.oracle,
    });
  }
  return { records, total: names.length };
}

function removeRecord(store, key) {
  const path = join(store.path, key + ".json");
  try {
    const info = lstatSync(path);
    if (info.isDirectory()) throw new Error("refusing to remove directory " + path);
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function revokeApprovals(store, tokens) {
  const names = recordNames(store);
  const removed = [];
  const unmatched = [];
  for (const token of tokens) {
    const matches = names.filter((name) => name.startsWith(token));
    if (!matches.length) unmatched.push(token);
    for (const name of matches) if (removeRecord(store, name.slice(0, 64))) removed.push(token);
  }
  assertStoreUnchanged(store);
  return { removed, unmatched };
}

// Remove records that can never authorize anything again: corrupt, outdated,
// unreadable, or naming a ledger file that no longer exists.
export function pruneApprovals(store) {
  const removed = [];
  for (const record of listApprovals(store).records) {
    if (record.state === "valid" && record.ledgerPresent) continue;
    if (removeRecord(store, record.key)) {
      removed.push({ token: record.token, reason: record.state === "valid" ? "ledger missing" : record.state });
    }
  }
  assertStoreUnchanged(store);
  return removed;
}

export function indexApprovals(store) {
  const index = new Map();
  if (!store) return index;
  for (const record of listApprovals(store, { limit: MAX_STORE_SCAN }).records) {
    if (record.state !== "valid") continue;
    const id = record.file + "\0" + record.gate;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(record);
  }
  return index;
}

// Find the stored approval for the same ledger gate whose oracle differs from
// the current one in the fewest fields, so a reviewer can see what changed.
export function nearestPriorApproval(index, ledger, gateId, oracle) {
  let best = null;
  for (const record of index.get(String(ledger) + "\0" + String(gateId)) || []) {
    const differences = oracleDifferences(record.oracle, oracle);
    if (!differences.length) continue;
    if (!best || differences.length < best.differences.length) {
      best = { token: record.token, differences, oracle: record.oracle };
    }
  }
  return best;
}
