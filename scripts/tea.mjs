#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// TEA dispatcher: routes `tea mcp` to the MCP stdio entry and every other
// argument list to the CLI entry. The compiled entries are export-only, so
// importing them never runs anything; this file owns execution.
const args = process.argv.slice(2);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMcp = args[0] === "mcp" || args[0] === "--mcp";

/** Exit status of a writer terminated by SIGPIPE (128 + 13). */
const SIGPIPE_EXIT_STATUS = 141;
let stdoutClosed = false;
process.stdout.on("error", (cause) => {
  if (cause?.code === "EPIPE") {
    stdoutClosed = true;
    process.exitCode = SIGPIPE_EXIT_STATUS;
    return;
  }
  if (process.stdout.listenerCount("error") === 1) throw cause;
});

const requiredFiles = isMcp ? ["dist/teaMcp.js"] : ["dist/teaCli.js"];
if (!(await compiledRuntimeExists(requiredFiles))) {
  process.stderr.write(
    `TEA's compiled runtime is missing (expected ${requiredFiles.join(", ")}).\nRun \`npm run build:cached\` in ${packageRoot}, then retry.\n`,
  );
  process.exitCode = 1;
} else if (isMcp) {
  try {
    const { runTeaMcpEntrypoint } = await import("../dist/teaMcp.js");
    await runTeaMcpEntrypoint();
  } catch (cause) {
    if (!stdoutClosed)
      process.stderr.write(
        `TEA MCP server failed to start: ${dispatchFailureText(cause)}\n`,
      );
    process.exitCode = stdoutClosed ? SIGPIPE_EXIT_STATUS : 1;
  }
} else {
  try {
    const { runTeaCliEntrypoint } = await import("../dist/teaCli.js");
    const status = await runTeaCliEntrypoint(args);
    process.exitCode = stdoutClosed ? SIGPIPE_EXIT_STATUS : status;
  } catch (cause) {
    if (stdoutClosed) {
      process.exitCode = SIGPIPE_EXIT_STATUS;
    } else {
      process.stderr.write(
        `TEA CLI failed to dispatch: ${dispatchFailureText(cause)}\n`,
      );
      process.exitCode = 1;
    }
  }
}

function dispatchFailureText(cause) {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
