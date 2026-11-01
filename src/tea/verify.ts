import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_OUTPUT_BYTES,
} from "./limits.js";
import { admitGeneratedArtifact } from "./artifact.js";
import type {
  CoverageSummary,
  VerifyInput,
  VerifyTestsResult,
} from "./types.js";
import { TeaError } from "./types.js";

/**
 * Run a generated TEA test file with `node --test`: contract tests against a
 * validated TEA_BASE_URL, or source tests without a base URL. The executed
 * command never contains the base URL (it is passed via the environment), so
 * the reported command carries no secrets.
 */
export const verifyGeneratedTests = async (
  input: VerifyInput,
): Promise<VerifyTestsResult> => {
  const baseUrl =
    input.baseUrl === undefined ? null : validateBaseUrl(input.baseUrl);
  const testFile = await resolveTestFile(input.testFile);
  if ((input.artifactPolicy ?? "required") === "required")
    await admitGeneratedArtifact(testFile);
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TeaError("invalid_input", "timeoutMs must be a positive number");

  const randomSeed = input.randomSeed;
  if (
    randomSeed !== undefined &&
    (!Number.isInteger(randomSeed) || randomSeed < 0)
  )
    throw new TeaError(
      "invalid_input",
      "randomSeed must be a non-negative integer",
    );
  const coverageRequested = (input.coverageInclude?.length ?? 0) > 0;
  const command = [process.execPath, "--test"];
  if (randomSeed !== undefined)
    command.push("--test-randomize", `--test-random-seed=${randomSeed}`);
  if (coverageRequested) {
    command.push("--experimental-test-coverage");
    for (const sourcePath of input.coverageInclude ?? [])
      command.push(`--test-coverage-include=${sourcePath}`);
  }
  command.push(testFile);
  const environment = createChildEnvironment(baseUrl);
  const workingDirectory = await mkdtemp(join(tmpdir(), "tea-run-"));
  const started = performance.now();
  let outcome: CommandOutcome;
  try {
    outcome = await runBounded(
      command,
      environment.values,
      timeoutMs,
      workingDirectory,
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
  const limitations: string[] = [];
  if (outcome.truncated)
    limitations.push(
      `captured output truncated at ${MAX_VERIFY_OUTPUT_BYTES} bytes`,
    );
  const coverage = coverageRequested
    ? parseCoverageSummary(outcome.output)
    : null;
  if (coverageRequested && coverage === null)
    limitations.push("Node coverage summary could not be parsed");

  return {
    testFile,
    baseUrl: baseUrl === null ? null : redactCredentials(baseUrl),
    command,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    passed: outcome.exitCode === 0,
    durationMs: Math.round(performance.now() - started),
    output: outcome.output,
    limitations,
    environment: {
      inheritedAmbient: false,
      forwardedVariables: environment.forwardedVariables,
      explicitVariables: environment.explicitVariables,
    },
    ...(randomSeed === undefined ? {} : { randomSeed }),
    ...(coverageRequested ? { coverage } : {}),
  };
};

const parseCoverageSummary = (output: string): CoverageSummary | null => {
  const match =
    /all files\s+\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/u.exec(
      output,
    );
  if (match === null) return null;
  const lines = Number(match[1]);
  const branches = Number(match[2]);
  const functions = Number(match[3]);
  return Number.isFinite(lines) &&
    Number.isFinite(branches) &&
    Number.isFinite(functions)
    ? { lines, branches, functions }
    : null;
};

const validateBaseUrl = (value: string): string => {
  if (typeof value !== "string" || value.trim() === "")
    throw new TeaError("invalid_input", "baseUrl must be a non-empty string");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TeaError(
      "invalid_input",
      "baseUrl must be a valid http/https URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new TeaError("invalid_input", "baseUrl must use http or https");
  return value;
};

const resolveTestFile = async (testFile: string): Promise<string> => {
  if (typeof testFile !== "string" || testFile.trim() === "")
    throw new TeaError("invalid_input", "testFile must be a non-empty path");
  const resolved = resolve(testFile);
  let info;
  try {
    info = await stat(resolved);
  } catch (cause) {
    if (isMissing(cause))
      throw new TeaError("not_found", `test file does not exist: ${testFile}`);
    throw cause;
  }
  if (!info.isFile())
    throw new TeaError("invalid_input", `test file is not a file: ${testFile}`);
  return resolved;
};

interface ChildEnvironment {
  readonly values: Record<string, string>;
  readonly forwardedVariables: readonly string[];
  readonly explicitVariables: readonly string[];
}

const createChildEnvironment = (baseUrl: string | null): ChildEnvironment => {
  const ambientNames =
    process.platform === "win32"
      ? [
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "SYSTEMDRIVE",
          "WINDIR",
          "COMSPEC",
          "TEMP",
          "TMP",
          "NUMBER_OF_PROCESSORS",
        ]
      : ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP"];
  const values: Record<string, string> = {};
  const forwardedVariables: string[] = [];
  for (const name of ambientNames) {
    const value = process.env[name];
    if (value === undefined) continue;
    values[name] = value;
    forwardedVariables.push(name);
  }
  const explicitVariables: string[] = [];
  if (baseUrl !== null) {
    values.TEA_BASE_URL = baseUrl;
    explicitVariables.push("TEA_BASE_URL");
  }
  return { values, forwardedVariables, explicitVariables };
};

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly truncated: boolean;
}

const runBounded = (
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  workingDirectory: string,
): Promise<CommandOutcome> =>
  new Promise((resolveOutcome) => {
    const executable = command[0];
    if (executable === undefined)
      throw new TeaError("internal", "empty command");
    const options: SpawnOptions = {
      shell: false,
      env,
      cwd: workingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(executable, command.slice(1), options);
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer | string): void => {
      if (truncated) return;
      output += chunk.toString();
      if (output.length > MAX_VERIFY_OUTPUT_BYTES) {
        output = output.slice(0, MAX_VERIFY_OUTPUT_BYTES);
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (cause) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveOutcome({
        exitCode: null,
        timedOut: false,
        output:
          output + (cause instanceof Error ? cause.message : String(cause)),
        truncated,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveOutcome({
        exitCode:
          code === null ? (timedOut || signal !== null ? null : 1) : code,
        timedOut,
        output,
        truncated,
      });
    });
  });

/** Remove `user:password@` from a URL for reporting. */
const redactCredentials = (url: string): string =>
  url.replace(/\/\/[^/@]+@/u, "//***@");

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";
