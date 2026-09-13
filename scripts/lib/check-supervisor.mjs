#!/usr/bin/env node
// Keep a stable process-group leader alive until CHECK stdio closes.
// Zero dependencies. Node 16+.

import { spawn } from "node:child_process";

const [shell, command, role] = process.argv.slice(2);
if (!shell || command === undefined) {
  console.error("unlazy-check-supervisor: expected resolved shell and CHECK command");
  process.exit(2);
}

let child;
let spawnError = null;
try {
  child = spawn(command, {
    cwd: process.cwd(),
    shell,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  console.error("unlazy-check-supervisor: could not start CHECK: " + error.message);
  process.exit(127);
}

// When this supervisor leads its own process group, terminate group members
// that outlived the CHECK's output streams, such as a daemon started with
// ignored stdio. The supervisor ignores that one SIGTERM itself. A process
// that deliberately starts a new group is outside this cleanup.
function signalLeftoverGroupMembers() {
  if (role !== "--group-leader" || process.platform === "win32") return;
  process.on("SIGTERM", () => {});
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch (error) {
    if (!error || error.code !== "ESRCH") {
      console.error("unlazy-check-supervisor: could not signal leftover process group members: " +
        (error && error.message));
    }
  }
}

// Pipe instead of inheriting descriptors directly. Node's `close` event then
// waits for descendants that inherited the shell's stdout or stderr, keeping
// this detached supervisor alive as the original process-group identity.
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.once("error", (error) => { spawnError = error; });
child.once("close", (code, signal) => {
  if (spawnError) {
    console.error("unlazy-check-supervisor: CHECK spawn failed: " + spawnError.message);
    process.exitCode = 127;
  } else if (Number.isInteger(code)) {
    process.exitCode = code;
  } else {
    console.error("unlazy-check-supervisor: CHECK ended by " + (signal || "unknown signal"));
    process.exitCode = 1;
  }
  signalLeftoverGroupMembers();
});
