"use strict";
// Preloaded (NODE_OPTIONS=--require) into the runner and every worker process when `run.js profile` runs a suite.
// Like --cpu-prof, but it also writes the profile when the process is ended by SIGTERM/SIGINT or exits through
// process.exit(), which is how Vitest's and Jest's pools stop their workers; --cpu-prof only writes on a normal exit,
// so it silently loses the workers, where the test files actually run.
const fs = require("node:fs");
const path = require("node:path");
const inspector = require("node:inspector");

const dir = process.env.REAL_SUITES_PROFILE_DIR;
const intervalUs = Number(process.env.REAL_SUITES_PROFILE_INTERVAL_US ?? 500);
const session = new inspector.Session();
session.connect();
// Inspector messages on the main thread's own session are dispatched synchronously, so the profile can be stopped
// and written from an 'exit' handler.
session.post("Profiler.enable");
session.post("Profiler.setSamplingInterval", { interval: intervalUs });
session.post("Profiler.start");

let written = false;
function write() {
  if (written) {
    return;
  }
  written = true;
  session.post("Profiler.stop", (err, result) => {
    if (!err) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${process.pid}-${Date.now()}.cpuprofile`), JSON.stringify(result.profile));
    }
  });
}

process.on("exit", write);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    write();
    process.kill(process.pid, signal);
  });
}
