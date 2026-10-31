import { spawn, type SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_OUTPUT_BYTES,
} from "./limits.js";
import type { VerifyInput, VerifyTestsResult } from "./types.js";
import { TeaError } from "./types.js";

/**
 * Run a generated contract test file with `node --test` against a validated
 * TEA_BASE_URL. The executed command never contains the base URL (it is passed
 * via the environment), so the reported command carries no secrets.
 */
export const verifyGeneratedTests = async (
  input: VerifyInput,
): Promise<VerifyTestsResult> => {
  const baseUrl = validateBaseUrl(input.baseUrl);
  const testFile = await resolveTestFile(input.testFile);
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TeaError("invalid_input", "timeoutMs must be a positive number");

  const command = [process.execPath, "--test", testFile];
  const started = performance.now();
  const outcome = await runBounded(
    command,
    { TEA_BASE_URL: baseUrl },
    timeoutMs,
  );
  const limitations: string[] = [];
  if (outcome.truncated)
    limitations.push(
      `captured output truncated at ${MAX_VERIFY_OUTPUT_BYTES} bytes`,
    );

  return {
    testFile,
    baseUrl: redactCredentials(baseUrl),
    command,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    passed: outcome.exitCode === 0,
    durationMs: Math.round(performance.now() - started),
    output: outcome.output,
    limitations,
  };
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
): Promise<CommandOutcome> =>
  new Promise((resolveOutcome) => {
    const executable = command[0];
    if (executable === undefined)
      throw new TeaError("internal", "empty command");
    const options: SpawnOptions = {
      shell: false,
      env: { ...process.env, ...env },
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
