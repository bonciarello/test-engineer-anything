import { readFile } from "node:fs/promises";
import { z } from "zod";

import { PACKAGE_METADATA } from "./generatedPackageMetadata.js";
import {
  analyzeProduct,
  generateTestArtifacts,
  planContractTests,
  verifyGeneratedTests,
} from "./tea/index.js";
import { TeaError } from "./tea/types.js";

export const PRODUCT_NAME = "tea-agents";

const analyzeSchema = z.object({ repoDir: z.string().min(1) });
const planSchema = z.object({ repoDir: z.string().min(1) });
const generateSchema = z.object({
  repoDir: z.string().min(1),
  outputDir: z.string().min(1),
  overwrite: z.boolean().optional(),
});
const verifySchema = z.object({
  testFile: z.string().min(1),
  baseUrl: z.string().min(1),
  timeoutMs: z.number().positive().optional(),
});

type CommandHandler = (input: unknown) => Promise<unknown>;

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  "analyze-product": async (input) =>
    analyzeProduct(analyzeSchema.parse(input).repoDir),
  "plan-tests": async (input) =>
    planContractTests({ repoDir: planSchema.parse(input).repoDir }),
  "generate-tests": async (input) => {
    const parsed = generateSchema.parse(input);
    return generateTestArtifacts({
      repoDir: parsed.repoDir,
      outputDir: parsed.outputDir,
      ...(parsed.overwrite === undefined
        ? {}
        : { overwrite: parsed.overwrite }),
    });
  },
  "verify-tests": async (input) => {
    const parsed = verifySchema.parse(input);
    return verifyGeneratedTests({
      testFile: parsed.testFile,
      baseUrl: parsed.baseUrl,
      ...(parsed.timeoutMs === undefined
        ? {}
        : { timeoutMs: parsed.timeoutMs }),
    });
  },
};

const HELP_TEXT = `tea-agents — contract-test planner for Node/TypeScript OpenAPI services

Usage:
  tea <command> [--input <file>]

Commands:
  analyze-product    Analyze a repository: package.json, source inventory, OpenAPI specs
  plan-tests         Plan GET/HEAD contract tests from discovered OpenAPI 3 specs
  generate-tests     Generate a standalone node:test .mjs file and tea-plan.json
  verify-tests       Run a generated test file against a live TEA_BASE_URL

Each command reads one JSON document from stdin (or from --input <file>):

  analyze-product   { "repoDir": "/path/to/repo" }
  plan-tests        { "repoDir": "/path/to/repo" }
  generate-tests    { "repoDir": "...", "outputDir": "...", "overwrite": false }
  verify-tests      { "testFile": "...", "baseUrl": "http://localhost:3000", "timeoutMs": 30000 }

Options:
  --help, -h         Show this help
  --version, -v      Show the product name and version
`;

/**
 * Entry point invoked by the dispatcher. Returns the process exit code; writes
 * JSON results to stdout and JSON errors to stderr. Exported only — importing
 * this module has no side effects.
 */
export const runTeaCliEntrypoint = async (
  args: readonly string[],
): Promise<number> => {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${PRODUCT_NAME} ${PACKAGE_METADATA.version}\n`);
    return 0;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    writeError(
      "unknown_command",
      `unknown command: ${command}\n\n${HELP_TEXT}`,
    );
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const inputResult = await readInput(rest);
  if (!inputResult.ok) {
    writeError(inputResult.error.code, inputResult.error.message);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputResult.value) as unknown;
  } catch {
    writeError("invalid_input", "input is not valid JSON");
    return 2;
  }

  try {
    const result = await handler(parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (cause) {
    if (cause instanceof TeaError) {
      writeError(cause.code, cause.message);
      return 1;
    }
    if (cause instanceof z.ZodError) {
      writeError("invalid_input", issueMessage(cause));
      return 2;
    }
    writeError("internal", "unexpected failure");
    return 1;
  }
};

const readInput = async (
  rest: readonly string[],
): Promise<
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }
> => {
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === undefined) continue;
    if (argument === "--input") {
      const path = rest[index + 1];
      if (path === undefined || path.startsWith("-"))
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "--input requires a file path",
          },
        };
      return readFileInput(path);
    }
    if (argument.startsWith("--input="))
      return readFileInput(argument.slice("--input=".length));
    if (argument.startsWith("-"))
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: `unknown option: ${argument}`,
        },
      };
    return {
      ok: false,
      error: {
        code: "invalid_arguments",
        message: `unexpected argument: ${argument}`,
      },
    };
  }
  if (process.stdin.isTTY)
    return {
      ok: false,
      error: {
        code: "no_input",
        message: "pipe a JSON document to stdin or pass --input <file>",
      },
    };
  return { ok: true, value: await readStdin() };
};

const readFileInput = async (
  path: string,
): Promise<
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }
> => {
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch (cause) {
    if (isMissing(cause))
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `input file does not exist: ${path}`,
        },
      };
    throw cause;
  }
};

const readStdin = (): Promise<string> =>
  new Promise((resolveInput) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveInput(data));
    process.stdin.on("error", () => resolveInput(data));
  });

const issueMessage = (error: z.ZodError): string =>
  error.issues.map((issue) => issue.message).join("; ");

const writeError = (code: string, message: string): void => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
  );
};

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";
