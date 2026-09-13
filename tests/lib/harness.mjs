// Shared test runner and process helpers. Zero dependencies. Node 16+.

import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_TEST_TIMEOUT_MS = 120000;

export class SkipError extends Error {}
export function skip(reason) { throw new SkipError(reason); }

let fifoSupport = null;
// Probe once for a working mkfifo instead of assuming every POSIX host has it.
export function requireFifo() {
  if (process.platform === "win32") skip("FIFOs are POSIX only");
  if (fifoSupport === null) {
    const directory = mkdtempSync(join(tmpdir(), "unlazy-fifo-probe-"));
    try {
      const made = spawnSync("mkfifo", [join(directory, "probe")], { encoding: "utf8" });
      fifoSupport = made.status === 0;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (!fifoSupport) skip("mkfifo is unavailable");
}

// Tests must not inherit a developer's UNLAZY_* configuration, or the project
// directory of a Claude Code session that happens to run the suite.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("UNLAZY_") && key !== "CLAUDE_PROJECT_DIR") env[key] = value;
  }
  return { ...env, ...extra };
}

export function runNode(script, args, options = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [...(options.nodeArgs || []), script, ...args], {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      env: cleanEnv(options.env),
      timeout: options.timeoutMs,
    }, (error, stdout, stderr) => {
      done({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        out: (stdout || "") + (stderr || ""),
        stdout: stdout || "",
        stderr: stderr || "",
        timedOut: Boolean(error && error.killed),
      });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

const NON_RUN_FLAGS = new Set([
  "--status", "--review", "--claim", "--release", "--release-invalid", "--list-scopes", "--log", "--bind",
  "--list-approvals", "--prune-approvals", "--revoke", "--help", "-h",
]);
const RUN_ONLY_VALUE_OPTIONS = new Set(["--jobs"]);
const RUN_ONLY_FLAGS = new Set(["--reverify", "--json"]);

export function tokensFrom(output) {
  return [...new Set([...String(output).matchAll(/TOKEN: ([a-f0-9]{16})/g)].map((match) => match[1]))];
}

// Review the same target first, then approve exactly the tokens the review
// printed. This is the documented two-step flow; tests never use a bypass.
export async function reviewAndRun(gateCheck, args, options = {}) {
  if (args.some((arg) => NON_RUN_FLAGS.has(arg.split("=")[0])) || args.some((arg) => arg.startsWith("--approve"))) {
    return runNode(gateCheck, args, options);
  }
  const reviewArgs = [];
  for (let index = 0; index < args.length; index++) {
    const name = args[index].split("=")[0];
    if (RUN_ONLY_FLAGS.has(name)) continue;
    if (RUN_ONLY_VALUE_OPTIONS.has(name)) {
      if (!args[index].includes("=")) index++;
      continue;
    }
    reviewArgs.push(args[index]);
  }
  const review = await runNode(gateCheck, ["--review", ...reviewArgs], options);
  const needed = [...String(review.out).matchAll(/APPROVAL REQUIRED \S+\n(?:    .*\n)*?    TOKEN: ([a-f0-9]{16})/g)]
    .map((match) => match[1]);
  // A review that asks for approval but yields no parsable token means the
  // review format drifted; fail loudly instead of running unapproved.
  const requested = (String(review.out).match(/^APPROVAL REQUIRED \S+$/gm) || []).length;
  if (requested !== needed.length) {
    throw new Error("review listed " + requested + " oracle(s) needing approval but " + needed.length +
      " token(s) parsed:\n" + review.out);
  }
  if (!needed.length) return runNode(gateCheck, args, options);
  return runNode(gateCheck, ["--approve=" + needed.join(","), ...args], options);
}

function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("test exceeded " + ms + "ms: " + name)), ms);
    }),
  ]);
}

// Run every test, report PASS, SKIP, and FAIL separately with full stacks, and
// never count a skipped test as a pass.
export async function runSuite(tests, { filter = "", timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  const selected = tests.filter((item) => item.name.includes(filter));
  let passed = 0;
  const skipped = [];
  const failures = [];
  for (const item of selected) {
    try {
      await withTimeout(Promise.resolve().then(() => item.fn()), item.timeoutMs || timeoutMs, item.name);
      passed++;
      console.log("ok   " + item.name);
    } catch (error) {
      if (error instanceof SkipError) {
        skipped.push(item.name);
        console.log("SKIP " + item.name + " (" + error.message + ")");
        continue;
      }
      failures.push(item.name);
      const detail = error && error.stack ? error.stack : String(error);
      console.log("FAIL " + item.name + "\n     " + detail.split("\n").join("\n     "));
    }
  }
  const ran = selected.length - skipped.length;
  console.log("\n" + passed + "/" + ran + " passed" + (skipped.length ? ", " + skipped.length + " skipped" : "") +
    " (" + selected.length + " selected)");
  if (failures.length) console.log("failed: " + failures.join(", "));
  return failures.length ? 1 : 0;
}
