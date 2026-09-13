#!/usr/bin/env node
// Install, verify, or remove unlazy's Claude Code Stop hook. Zero dependencies. Node 16+.

import {
  accessSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync,
  readFileSync, realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  sameFileIdentity, statCurrentNamedFile, validateScopeId, writeAtomic,
} from "./lib/gates.mjs";

const HELP = `usage: install-hooks.mjs [--scope ID] [--shared | --global] [--node PATH] [--uninstall | --verify]

  default       .claude/settings.local.json in the current project
  --shared      .claude/settings.json in the current project
  --global      ~/.claude/settings.json
  --scope ID    pin the hook to one validated .unlazy/ID pipeline
  --node PATH   Node executable the hook runs with (default: this Node)
  --uninstall   remove only unlazy handlers, preserving sibling handlers
  --verify      check that the installed handler's Node and hook script exist and run

The hook command records the skill path exactly as this installer was invoked,
so a symlinked skill directory keeps resolving through its link.`;

function usage(message) {
  console.error("install-hooks: " + message);
  console.error("run install-hooks.mjs --help for usage");
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Set(["--shared", "--global", "--uninstall", "--verify", "--help", "-h"]);
let scope = null;
let nodePath = null;
const seen = new Set();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--help" || arg === "-h") { console.log(HELP); process.exit(0); }
  if (arg === "--scope" || arg === "--node") {
    if (seen.has(arg)) usage("duplicate " + arg);
    seen.add(arg);
    const value = args[++index];
    if (!value) usage(arg + " needs a value");
    if (arg === "--scope") scope = value;
    else nodePath = value;
    continue;
  }
  if (!flags.has(arg)) usage("unknown option " + arg);
  if (seen.has(arg)) usage("duplicate " + arg);
  seen.add(arg);
}
const shared = seen.has("--shared");
const global = seen.has("--global");
const uninstall = seen.has("--uninstall");
const verify = seen.has("--verify");
if (shared && global) usage("--shared and --global are mutually exclusive");
if (uninstall && verify) usage("--uninstall and --verify are mutually exclusive");
if ((uninstall || verify) && (scope || nodePath)) usage("--scope and --node apply only to installation");
if (scope) {
  const error = validateScopeId(scope);
  if (error) usage(error);
}

// Lexical, not canonical: an install through ~/.claude/skills/unlazy keeps
// that link in the command so repointing the link repoints the hook.
const invokedScript = resolve(process.argv[1]);
const skillScripts = dirname(invokedScript);
const hookScript = join(skillScripts, "stop-hook.mjs");
const skillDir = dirname(skillScripts);
const MANAGED_MARKER = "--unlazy-hook-v2";

function resolveTarget() {
  const lexical = global
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", shared ? "settings.json" : "settings.local.json");
  // Resolve a symlinked settings directory or file once, then apply every
  // identity check to that one real target.
  let directory = dirname(lexical);
  try { directory = realpathSync(directory); } catch { /* created on first write */ }
  let target = join(directory, basename(lexical));
  let followed = null;
  try {
    if (lstatSync(target).isSymbolicLink()) {
      const real = realpathSync(target);
      followed = target + " -> " + real;
      target = real;
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      console.error("Refusing to touch " + target + ": cannot resolve it (" + (error && error.message) + ")");
      process.exit(1);
    }
  }
  return { target, followed };
}

const { target, followed } = resolveTarget();
const backup = target + ".unlazy.bak";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readSettings() {
  if (!existsSync(target)) return { raw: "", settings: {} };
  let fd = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0);
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0) | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    const named = statCurrentNamedFile(target, { label: "settings target" });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(opened, named)) {
      throw new Error("target must be one unchanged regular single-link file, not a hard link or directory");
    }
    const raw = readFileSync(fd, "utf8");
    const after = statCurrentNamedFile(target, { label: "settings target" });
    if (!sameFileIdentity(opened, after)) throw new Error("target changed while it was read");
    return { raw, settings: JSON.parse(raw) };
  } catch (error) {
    console.error("Refusing to touch " + target + ": " + error.message +
      (error instanceof SyntaxError ? " (fix the JSON, then run the installer again)" : ""));
    process.exit(1);
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* the read result is already decided */ }
  }
}

function validateSettings(value) {
  if (!isObject(value)) return "settings root must be a JSON object";
  if (value.hooks !== undefined && !isObject(value.hooks)) return "hooks must be a JSON object";
  if (value.hooks && value.hooks.Stop !== undefined && !Array.isArray(value.hooks.Stop)) return "hooks.Stop must be an array";
  const groups = (value.hooks && value.hooks.Stop) || [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (!isObject(group)) return "hooks.Stop[" + groupIndex + "] must be an object";
    if (!Array.isArray(group.hooks)) return "hooks.Stop[" + groupIndex + "].hooks must be an array";
    for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex++) {
      if (!isObject(group.hooks[hookIndex])) {
        return "hooks.Stop[" + groupIndex + "].hooks[" + hookIndex + "] must be an object";
      }
    }
  }
  return null;
}

const { raw, settings } = readSettings();
const shapeError = validateSettings(settings);
if (shapeError) {
  console.error("Refusing to touch " + target + ": " + shapeError + ".");
  process.exit(1);
}

const quote = (value) => {
  if (process.platform === "win32") return '"' + String(value).replace(/"/g, '""') + '"';
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
};

function splitCommand(command) {
  const parts = [];
  const pattern = process.platform === "win32" ? /"((?:[^"]|"")*)"|(\S+)/g : /'((?:[^']|'\\'')*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    parts.push(match[1] !== undefined
      ? (process.platform === "win32" ? match[1].replace(/""/g, '"') : match[1].replace(/'\\''/g, "'"))
      : match[2]);
  }
  return parts;
}

const isOurHandler = (handler) => {
  if (!isObject(handler) || typeof handler.command !== "string") return false;
  const value = handler.command;
  const token = (name) => new RegExp("(?:^|\\s)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)").test(value);
  // An exact foreign --unlazy-* option is positive evidence that this is not
  // our legacy entry, even when it happens to invoke the same script path.
  const foreignUnlazyOption = value.split(/\s+/).some((part) => {
    const quoted = part.length >= 2 &&
      ((part[0] === '"' && part[part.length - 1] === '"') ||
       (part[0] === "'" && part[part.length - 1] === "'"));
    const option = quoted ? part.slice(1, -1) : part;
    return option.startsWith("--unlazy-") && option !== MANAGED_MARKER;
  });
  if (foreignUnlazyOption) return false;
  if (token(MANAGED_MARKER)) return true;
  // Migrate v2.0/v2.1 handlers only when both the exact old marker and the
  // packaged scripts/stop-hook.mjs shape are present. Substrings such as
  // --unlazy-helper and unrelated same-named scripts are never ownership.
  const packagedStopHook = /(?:^|[\s"'])[^\s"']*[\\/]scripts[\\/]stop-hook\.mjs(?=$|[\s"'])/i.test(value);
  const namedLegacyInstall = /[\\/]unlazy[\\/]scripts[\\/]stop-hook\.mjs(?=$|[\s"'])/i.test(value);
  // Upstream v2.0 shipped before any marker and is recognizable only at its
  // conventional Claude skill location.
  const conventionalV2Path = /[\\/]\.claude[\\/]skills[\\/]unlazy[\\/]scripts[\\/]stop-hook\.mjs(?=$|[\s"'])/i.test(value);
  return value.includes(hookScript) || conventionalV2Path ||
    (token("--unlazy") && (namedLegacyInstall || packagedStopHook));
};

const originalGroups = (settings.hooks && settings.hooks.Stop) || [];
const ours = [];
originalGroups.forEach((group, groupIndex) => group.hooks.forEach((handler, hookIndex) => {
  if (isOurHandler(handler)) ours.push({ groupIndex, hookIndex, handler });
}));

// ---------------------------------------------------------------- verify

if (verify) {
  if (!ours.length) {
    console.log("NOT INSTALLED: no unlazy Stop hook in " + target);
    process.exit(1);
  }
  let failures = 0;
  for (const { handler } of ours) {
    const [node, script] = splitCommand(handler.command);
    const problems = [];
    try { accessSync(node, fsConstants.X_OK); } catch { problems.push("Node executable is missing or not executable: " + node); }
    if (!script || !existsSync(script)) problems.push("hook script is missing: " + script);
    if (handler.type !== "command" || handler.timeout !== 20) problems.push("managed type or timeout drifted; run the installer again");
    if (!problems.length) {
      const probe = spawnSync(node, [script], { input: "{}", cwd: tmpdir(), encoding: "utf8", timeout: 15000 });
      if (probe.status !== 0) problems.push("hook exited " + probe.status + (probe.stderr ? ": " + probe.stderr.trim().slice(0, 200) : ""));
    }
    if (problems.length) {
      failures++;
      console.log("BROKEN " + handler.command);
      for (const problem of problems) console.log("  " + problem);
    } else {
      console.log("OK " + handler.command);
    }
  }
  process.exit(failures ? 1 : 0);
}

// ------------------------------------------------------------ install/remove

function nextSettings(groups) {
  const result = { ...settings };
  const hooks = { ...(settings.hooks || {}) };
  if (groups.length) hooks.Stop = groups;
  else delete hooks.Stop;
  if (Object.keys(hooks).length) result.hooks = hooks;
  else delete result.hooks;
  return result;
}

function persist(value) {
  try {
    // Refuse a lost update: settings edited between read and write win.
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== raw) {
      console.error("Refusing to overwrite " + target + ": it changed while the installer ran; run the installer again");
      process.exit(1);
    }
    let backupNote = "not needed for a new file";
    if (raw) {
      // Keep the oldest backup: it is the settings file as it was before unlazy.
      if (existsSync(backup)) backupNote = backup + " (existing backup kept)";
      else {
        writeAtomic(backup, raw);
        backupNote = backup;
      }
    }
    writeAtomic(target, JSON.stringify(value, null, 2) + "\n");
    return backupNote;
  } catch (error) {
    console.error("Could not update " + target + ": " + error.message);
    process.exit(1);
  }
}

function withoutOurs(groups) {
  const kept = [];
  for (const group of groups) {
    const hooks = group.hooks.filter((handler) => !isOurHandler(handler));
    if (hooks.length) kept.push({ ...group, hooks });
  }
  return kept;
}

if (uninstall) {
  if (!ours.length) {
    console.log("Nothing to remove: no unlazy Stop hook found in " + target);
    process.exit(0);
  }
  persist(nextSettings(withoutOurs(originalGroups)));
  console.log("Removed unlazy Stop hook (" + ours.length + " handler(s)) from " + target + ". Sibling handlers were preserved.");
  process.exit(0);
}

const node = nodePath ? resolve(nodePath) : process.execPath;
try { accessSync(node, fsConstants.X_OK); } catch { usage("--node is not an executable file: " + node); }
const command = quote(node) + " " + quote(hookScript) + " " + MANAGED_MARKER + (scope ? " --scope " + scope : "");
const entry = { type: "command", command, timeout: 20 };

const alreadyCurrent = ours.length === 1 && ours[0].handler.command === command &&
  ours[0].handler.type === "command" && ours[0].handler.timeout === 20;
if (alreadyCurrent) {
  console.log("Already installed in " + target + " (idempotent, nothing changed).");
  process.exit(0);
}

// Replace the first existing handler in place so hook ordering is preserved;
// otherwise append a new group.
let groups;
if (ours.length) {
  const first = ours[0];
  groups = originalGroups.map((group, groupIndex) => ({
    ...group,
    hooks: group.hooks.flatMap((handler, hookIndex) => {
      if (groupIndex === first.groupIndex && hookIndex === first.hookIndex) return [entry];
      return isOurHandler(handler) ? [] : [handler];
    }),
  })).filter((group) => group.hooks.length);
} else {
  groups = [...originalGroups, { hooks: [entry] }];
}

const warnings = [];
if (/[\\/](?:\.nvm|\.volta|\.fnm|\.asdf|nodenv|n)[\\/]|[\\/]versions[\\/]node[\\/]/.test(node)) {
  warnings.push("the hook pins a version-managed Node binary (" + node + "); removing that version breaks the hook. Pass --node with a stable path to avoid it.");
}
const git = (gitArgs) => spawnSync("git", ["-C", skillDir, ...gitArgs], { encoding: "utf8", timeout: 5000 });
const status = git(["status", "--porcelain"]);
if (status.status === 0) {
  if (status.stdout.trim()) warnings.push("the skill checkout at " + skillDir + " has uncommitted changes; the hook runs whatever that directory holds.");
  const tag = git(["describe", "--tags", "--exact-match", "HEAD"]);
  if (tag.status !== 0) warnings.push("the skill checkout at " + skillDir + " is not at a tagged release; pin installs to a tag or a dedicated worktree.");
}
if (shared) warnings.push("shared settings contain this machine's absolute Node and skill paths.");

const backupNote = persist(nextSettings(groups));
console.log("Installed unlazy Stop hook into " + target + "\n" +
  (followed ? "  followed: " + followed + "\n" : "") +
  "  command: " + command + "\n" +
  "  scope:   " + (scope ? scope : "resolved per session and pipeline") + "\n" +
  "  backup:  " + backupNote + "\n" +
  "  state:   per-session progress lives under ~/.unlazy/hook-state; keep .unlazy/ in the project's ignore rules" +
  warnings.map((warning) => "\n  warning: " + warning).join(""));
