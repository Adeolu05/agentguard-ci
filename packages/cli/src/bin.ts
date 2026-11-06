#!/usr/bin/env node
import { main } from "./main.js";

// If stdout is closed early (e.g. `drainproof test | head`), stop writing but let the
// run finish so the report is still saved and the exit code is still correct.
let stdoutClosed = false;
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") stdoutClosed = true;
  else throw err;
});

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const code = await main(process.argv.slice(2), {
  stdout: (s) => {
    if (!stdoutClosed) process.stdout.write(s);
  },
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
  env: process.env,
  color,
});
process.exitCode = code;
