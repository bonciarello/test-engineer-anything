/**
 * Domain types for the TEA vertical slice. These are intentionally small and
 * self-contained: the slice owns its own contracts instead of borrowing the
 * REA domain layer, so it can be exercised and reasoned about in isolation.
 */

/** JSON value shape used for parsed OpenAPI documents and embedded schemas. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** Expected failures thrown across the public API boundary. */
export class TeaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TeaError";
    this.code = code;
  }
}

/** Error projection safe to return to callers (no stack, no internals). */
export interface PublicFailure {
  readonly code: string;
  readonly message: string;
}

/** Provenance required on every planned case and exclusion. */
export interface TeaEvidence {
  readonly specPath: string;
  /** JSON pointer to the operation, e.g. `/paths/~1users~1{id}/get`. */
  readonly jsonPointer: string;
  readonly confidence: "observed";
  readonly authority: "shipped-artifact";
  readonly limitations: readonly string[];
}

/** Assertions to run for one documented 2xx response. */
export interface ResponseAssertion {
  /** Concrete status code, or null for a `2XX` wildcard response. */
  readonly status: number | null;
  /** Documented media type, or null when the response has no body. */
  readonly contentType: string | null;
  /** True when the response documents a JSON body (`application/json`/`*+json`). */
  readonly jsonContentType: boolean;
  /** JSON pointer to the response schema, or null when none is documented. */
  readonly schemaPointer: string | null;
  /** False when the schema uses features the generated validator cannot trust. */
  readonly schemaSupported: boolean;
  readonly unsupportedReason: string | null;
}

/** A single GET/HEAD contract test case. */
export interface ContractTestCase {
  readonly id: string;
  readonly method: "get" | "head";
  readonly pathTemplate: string;
  readonly operationId: string | null;
  readonly summary: string | null;
  readonly evidence: TeaEvidence;
  readonly expectedStatus: readonly number[];
  /** True when a `2XX` wildcard response was documented. */
  readonly any2xx: boolean;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly queryParams: Readonly<Record<string, string>>;
  readonly responses: readonly ResponseAssertion[];
}

/** An operation that was deliberately not turned into a test case. */
export interface ExcludedOperation {
  readonly method: string;
  readonly path: string;
  readonly jsonPointer: string;
  readonly reason: string;
  readonly evidence: TeaEvidence;
}

/** The contract-test plan shared by generate and verify workflows. */
export interface TestPlan {
  readonly repoDir: string;
  /** Absolute paths to every OpenAPI 3 spec the plan is derived from. */
  readonly specs: readonly string[];
  readonly cases: readonly ContractTestCase[];
  readonly excluded: readonly ExcludedOperation[];
  readonly limitations: readonly string[];
}

export interface AnalyzedSpec {
  readonly path: string;
  readonly format: "json" | "yaml";
  readonly openapiVersion: string;
  readonly title: string | null;
  readonly operationCounts: {
    readonly get: number;
    readonly head: number;
    readonly mutating: number;
    readonly other: number;
    readonly total: number;
  };
}

export interface AnalyzeProductResult {
  readonly repoDir: string;
  readonly product: {
    readonly name: string | null;
    readonly version: string | null;
    readonly packageJsonPath: string | null;
    readonly packageJsonError: string | null;
  };
  readonly inventory: {
    readonly sourceFiles: readonly string[];
    readonly truncated: boolean;
  };
  readonly specs: readonly AnalyzedSpec[];
  readonly limitations: readonly string[];
}

export interface GeneratedFile {
  readonly path: string;
  readonly kind: "test" | "plan";
}

export interface GenerateTestsResult {
  readonly outputDir: string;
  readonly files: readonly GeneratedFile[];
  readonly caseCount: number;
  readonly excludedCount: number;
  readonly limitations: readonly string[];
}

export interface VerifyTestsResult {
  readonly testFile: string;
  /** Null when no base URL was supplied (source tests do not need one). */
  readonly baseUrl: string | null;
  /** Executed command; never contains the base URL or other secrets. */
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly limitations: readonly string[];
}

export interface PlanInput {
  readonly repoDir: string;
  readonly analysis?: AnalyzeProductResult;
}

export interface GenerateInput {
  readonly repoDir: string;
  readonly outputDir: string;
  readonly overwrite?: boolean;
  readonly plan?: TestPlan;
}

export interface VerifyInput {
  readonly testFile: string;
  /** Optional: source tests do not need a base URL; contract tests do. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/** Primitive TypeScript parameter/return types accepted by source tests. */
export type SourcePrimitive = "number" | "string" | "boolean";

/** Runtime values a source-test interpreter can produce or consume. */
export type SourcePrimitiveValue = number | string | boolean;

/** Provenance required on every planned source-test case. */
export interface SourceEvidence {
  /** Absolute path of the analyzed `.ts` source file. */
  readonly sourcePath: string;
  readonly exportName: string;
  readonly line: number;
  readonly column: number;
  readonly confidence: "derived";
  readonly authority: "shipped-artifact";
  readonly limitations: readonly string[];
}

/** A single unit/regression case derived from a pure exported function. */
export interface SourceTestCase {
  readonly id: string;
  readonly sourcePath: string;
  readonly exportName: string;
  readonly description: string;
  readonly args: readonly SourcePrimitiveValue[];
  readonly expected: SourcePrimitiveValue;
  readonly evidence: SourceEvidence;
}

/** An exported symbol that was deliberately not turned into a source test. */
export interface ExcludedSourceExport {
  readonly sourcePath: string;
  /** Null for module-level exclusions without a specific export name. */
  readonly exportName: string | null;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
}

/** The source-test plan shared by generate and verify workflows. */
export interface SourceTestPlan {
  readonly repoDir: string;
  /** Absolute paths of every `.ts` source file considered. */
  readonly sourceFiles: readonly string[];
  readonly cases: readonly SourceTestCase[];
  readonly excluded: readonly ExcludedSourceExport[];
  readonly limitations: readonly string[];
}

export interface PlanSourceInput {
  readonly repoDir: string;
  readonly analysis?: AnalyzeProductResult;
}

export interface GenerateSourceInput {
  readonly repoDir: string;
  readonly outputDir: string;
  readonly overwrite?: boolean;
  readonly plan?: SourceTestPlan;
}

export interface GenerateSourceResult {
  readonly outputDir: string;
  readonly files: readonly GeneratedFile[];
  readonly caseCount: number;
  readonly excludedCount: number;
  readonly limitations: readonly string[];
}
