/**
 * Explicit resource bounds for repository analysis. Every bound is fail-closed:
 * once a limit is reached the analysis stops expanding and records a
 * limitation instead of silently growing without bound.
 */
export const TEA_LIMITS = {
  /** Maximum filesystem entries visited during traversal. */
  maxTraversedFiles: 1000,
  /** Maximum source files retained in the inventory. */
  maxInventoryFiles: 500,
  /** Maximum OpenAPI spec candidates parsed. */
  maxSpecCandidates: 20,
  /** Maximum bytes read for any single spec candidate. */
  maxSpecBytes: 2 * 1024 * 1024,
  /** Maximum source inventory/spec candidate extensions handled. */
  maxFileNameLength: 512,
} as const;

/** Explicit resource bounds for source-test planning and interpretation. */
export const SOURCE_TEST_LIMITS = {
  /** Maximum `.ts` source files parsed during source-test planning. */
  maxSourceFiles: 200,
  /** Maximum bytes read for any single `.ts` source file. */
  maxSourceBytes: 1024 * 1024,
  /** Maximum exported functions planned across all files. */
  maxSourceFunctions: 100,
  /** Maximum generated cases for a single exported function. */
  maxCasesPerFunction: 16,
  /** Maximum AST nodes visited while validating or interpreting one expression. */
  maxInterpreterSteps: 2_000,
} as const;

/** Default verify timeout in milliseconds. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;

/** Maximum captured subprocess output bytes before truncation. */
export const MAX_VERIFY_OUTPUT_BYTES = 64 * 1024;

/** Directory names that are never descended into during traversal. */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

/** Source file extensions retained in the inventory. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".yaml",
  ".yml",
]);

/** Extensions considered as OpenAPI spec candidates. */
export const SPEC_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json",
  ".yaml",
  ".yml",
]);

/** HTTP methods that mutate state and are never contract-tested by TEA. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "post",
  "put",
  "patch",
  "delete",
]);

/** All methods recognized as OpenAPI path item keys. */
export const PATH_ITEM_METHODS: readonly string[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;
