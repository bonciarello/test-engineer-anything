import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { PACKAGE_METADATA } from "./generatedPackageMetadata.js";
import {
  analyzeProduct,
  evaluateSourceTests,
  generateSourceTestArtifacts,
  generateTestArtifacts,
  planContractTests,
  planSourceTests,
  verifyGeneratedTests,
} from "./tea/index.js";
import { TeaError, type PublicFailure } from "./tea/types.js";

const analyzeSchema = z.object({ repoDir: z.string().min(1) });
const planSchema = z.object({ repoDir: z.string().min(1) });
const generateSchema = z.object({
  repoDir: z.string().min(1),
  outputDir: z.string().min(1),
  overwrite: z.boolean().optional(),
});
const generateSourceSchema = z.object({
  repoDir: z.string().min(1),
  outputDir: z.string().min(1),
  overwrite: z.boolean().optional(),
});
const verifySchema = z.object({
  testFile: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  timeoutMs: z.number().positive().optional(),
});
const evaluateSchema = z.object({
  testFile: z.string().min(1),
  planFile: z.string().min(1).optional(),
  baselineTestFile: z.string().min(1).optional(),
  repetitions: z.number().int().min(1).max(10).optional(),
  mutationLimit: z.number().int().min(0).max(200).optional(),
  minimumMutationScore: z.number().min(0).max(1).optional(),
  timeoutMs: z.number().positive().optional(),
  coverage: z.boolean().optional(),
});

/** Build the TEA MCP server with all seven tools registered. */
export const createTeaMcpServer = (): McpServer => {
  const server = new McpServer(
    { name: "tea-agents", version: PACKAGE_METADATA.version },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "analyze_product",
    {
      title: "Analyze product",
      description:
        "Analyze a Node/TypeScript repository: package.json, source-file inventory, and OpenAPI 3 specs.",
      inputSchema: analyzeSchema,
    },
    (input) => handle(() => analyzeProduct(input.repoDir)),
  );

  server.registerTool(
    "plan_tests",
    {
      title: "Plan tests",
      description:
        "Plan contract tests for GET/HEAD OpenAPI operations, with evidence and exclusions.",
      inputSchema: planSchema,
    },
    (input) => handle(() => planContractTests({ repoDir: input.repoDir })),
  );

  server.registerTool(
    "plan_source_tests",
    {
      title: "Plan source tests",
      description:
        "Plan unit/regression tests from pure exported TypeScript functions, with evidence and exclusions.",
      inputSchema: planSchema,
    },
    (input) => handle(() => planSourceTests({ repoDir: input.repoDir })),
  );

  server.registerTool(
    "generate_tests",
    {
      title: "Generate tests",
      description:
        "Generate a standalone node:test .mjs file and tea-plan.json into an output directory.",
      inputSchema: generateSchema,
    },
    (input) =>
      handle(() =>
        generateTestArtifacts({
          repoDir: input.repoDir,
          outputDir: input.outputDir,
          ...(input.overwrite === undefined
            ? {}
            : { overwrite: input.overwrite }),
        }),
      ),
  );

  server.registerTool(
    "generate_source_tests",
    {
      title: "Generate source tests",
      description:
        "Generate tea-source-tests.mjs and tea-source-plan.json into an output directory.",
      inputSchema: generateSourceSchema,
    },
    (input) =>
      handle(() =>
        generateSourceTestArtifacts({
          repoDir: input.repoDir,
          outputDir: input.outputDir,
          ...(input.overwrite === undefined
            ? {}
            : { overwrite: input.overwrite }),
        }),
      ),
  );

  server.registerTool(
    "evaluate_source_tests",
    {
      title: "Evaluate source tests",
      description:
        "Measure source-test stability, mutation sensitivity, and coverage against an optional baseline.",
      inputSchema: evaluateSchema,
    },
    (input) => handle(() => evaluateSourceTests(input)),
  );

  server.registerTool(
    "verify_tests",
    {
      title: "Verify tests",
      description:
        "Run a generated test file, optionally against a live TEA_BASE_URL, and return a structured report.",
      inputSchema: verifySchema,
    },
    (input) =>
      handle(() =>
        verifyGeneratedTests({
          testFile: input.testFile,
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        }),
      ),
  );

  return server;
};

/**
 * Serve the TEA MCP server over stdio. Exported only — importing this module
 * has no side effects. Resolves once stdin closes (clean shutdown).
 */
export const runTeaMcpEntrypoint = async (): Promise<void> => {
  const handle = serveStdio(() => createTeaMcpServer());
  const shutdown = (): void => {
    void handle.close().catch(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      resolve();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
  });
  await handle.close().catch(() => undefined);
};

/** Wrap a tool operation, returning structuredContent on success and a stack-free failure on error. */
const handle = async <T>(
  operation: () => Promise<T>,
): Promise<CallToolResult> => {
  try {
    const result = await operation();
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (cause) {
    const failure = toPublicFailure(cause);
    return {
      content: [{ type: "text", text: failure.message }],
      structuredContent: { ok: false, error: failure },
      isError: true,
    };
  }
};

const toPublicFailure = (cause: unknown): PublicFailure => {
  if (cause instanceof TeaError)
    return { code: cause.code, message: cause.message };
  return { code: "internal", message: "unexpected failure" };
};
