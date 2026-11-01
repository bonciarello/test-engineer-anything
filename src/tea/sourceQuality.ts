import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";

import { SOURCE_TEST_LIMITS } from "./limits.js";
import { renderSourceTestFile } from "./sourceRender.js";
import type {
  CoverageDelta,
  CoverageSummary,
  EvaluateSourceTestsInput,
  MutationResult,
  MutationSummary,
  QualityRun,
  SourceMutation,
  SourceQualityReport,
  SourceTestCase,
  SourceTestPlan,
} from "./types.js";
import { TeaError } from "./types.js";
import { verifyGeneratedTests } from "./verify.js";

const primitiveSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const evidenceSchema = z.strictObject({
  sourcePath: z.string(),
  exportName: z.string(),
  line: z.number(),
  column: z.number(),
  confidence: z.literal("derived"),
  authority: z.literal("shipped-artifact"),
  limitations: z.array(z.string()),
});
const caseSchema = z.strictObject({
  id: z.string(),
  sourcePath: z.string(),
  exportName: z.string(),
  description: z.string(),
  args: z.array(primitiveSchema),
  expected: primitiveSchema,
  evidence: evidenceSchema,
});
const excludedSchema = z.strictObject({
  sourcePath: z.string(),
  exportName: z.string().nullable(),
  line: z.number(),
  column: z.number(),
  reason: z.string(),
});
const mutationSchema = z.strictObject({
  id: z.string(),
  sourcePath: z.string(),
  exportName: z.string(),
  kind: z.literal("operator"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  original: z.string().min(1),
  replacement: z.string().min(1),
});
const planSchema = z.strictObject({
  repoDir: z.string(),
  sourceFiles: z.array(z.string()),
  cases: z.array(caseSchema),
  excluded: z.array(excludedSchema),
  limitations: z.array(z.string()),
  mutations: z.array(mutationSchema).optional(),
});

/** Measure stability, mutation sensitivity, and coverage of a TEA source suite. */
export const evaluateSourceTests = async (
  input: EvaluateSourceTestsInput,
): Promise<SourceQualityReport> => {
  const repetitions = boundedInteger(
    input.repetitions,
    3,
    1,
    10,
    "repetitions",
  );
  const mutationLimit = boundedInteger(
    input.mutationLimit,
    50,
    0,
    SOURCE_TEST_LIMITS.maxSourceMutations,
    "mutationLimit",
  );
  const minimumScore = input.minimumMutationScore ?? 0.8;
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1)
    throw new TeaError(
      "invalid_input",
      "minimumMutationScore must be between 0 and 1",
    );
  const coverageRequested = input.coverage ?? true;
  const testFile = resolve(input.testFile);
  const planFile = resolve(
    input.planFile ?? join(dirname(testFile), "tea-source-plan.json"),
  );
  const plan = await readPlan(planFile);
  if (plan.cases.length === 0)
    throw new TeaError("invalid_plan", "source plan contains no test cases");
  const actualTest = await readFile(testFile, "utf8");
  const expectedTest = renderSourceTestFile(dirname(testFile), plan.cases);
  if (actualTest !== expectedTest)
    throw new TeaError(
      "artifact_mismatch",
      "test file does not match the source plan; regenerate both artifacts",
    );

  const sources = sourcePaths(plan.cases);
  assertSourcesInsideRepository(plan.repoDir, sources);
  const limitations: string[] = [];
  const baseline: QualityRun[] = [];
  let generatedCoverage: CoverageSummary | null = null;
  for (let index = 0; index < repetitions; index += 1) {
    const result = await verifyGeneratedTests({
      testFile,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(index === 0 ? {} : { randomSeed: 0x5eed + index }),
      ...(index === 0 && coverageRequested ? { coverageInclude: sources } : {}),
    });
    if (index === 0) generatedCoverage = result.coverage ?? null;
    limitations.push(...result.limitations);
    baseline.push(qualityRun(result));
  }
  const stable = baseline.every((run) => run.passed);

  let baselineCoverage: CoverageSummary | null = null;
  let baselineCoveragePassed = true;
  if (coverageRequested && input.baselineTestFile !== undefined) {
    const result = await verifyGeneratedTests({
      testFile: input.baselineTestFile,
      coverageInclude: sources,
      artifactPolicy: "trusted",
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    baselineCoverage = result.coverage ?? null;
    baselineCoveragePassed = result.passed;
    limitations.push(...result.limitations);
    if (!result.passed) limitations.push("baseline coverage test file failed");
  } else if (coverageRequested) {
    limitations.push(
      "coverage delta unavailable: baselineTestFile was not supplied",
    );
  }

  const mutations =
    stable && baselineCoveragePassed
      ? await runMutations({
          plan,
          sources,
          mutationLimit,
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
          limitations,
        })
      : emptyMutationSummary();
  if (!stable) limitations.push("mutations skipped: baseline is not stable");
  if (!baselineCoveragePassed)
    limitations.push("mutations skipped: baseline coverage suite failed");
  const denominator = mutations.killed + mutations.survived;
  const score = denominator === 0 ? null : mutations.killed / denominator;
  const scoredMutations = { ...mutations, score };
  const passed =
    stable &&
    baselineCoveragePassed &&
    mutations.invalid === 0 &&
    mutations.timedOut === 0 &&
    (score === null || score >= minimumScore);
  return {
    testFile,
    planFile,
    passed,
    minimumMutationScore: minimumScore,
    stable,
    baseline,
    mutations: scoredMutations,
    coverage: {
      generated: generatedCoverage,
      baseline: baselineCoverage,
      delta: coverageDelta(generatedCoverage, baselineCoverage),
    },
    limitations: [...new Set(limitations)],
  };
};

const readPlan = async (planFile: string): Promise<SourceTestPlan> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planFile, "utf8")) as unknown;
  } catch (cause) {
    if (isMissing(cause))
      throw new TeaError(
        "not_found",
        `source plan does not exist: ${planFile}`,
      );
    throw new TeaError("invalid_plan", "source plan is not valid JSON");
  }
  try {
    return planSchema.parse(raw);
  } catch (cause) {
    if (cause instanceof z.ZodError)
      throw new TeaError(
        "invalid_plan",
        cause.issues.map((issue) => issue.message).join("; "),
      );
    throw cause;
  }
};

const sourcePaths = (cases: readonly SourceTestCase[]): string[] => [
  ...new Set(cases.map((testCase) => testCase.sourcePath)),
];

const assertSourcesInsideRepository = (
  repoDir: string,
  sources: readonly string[],
): void => {
  const root = resolve(repoDir);
  for (const source of sources) {
    const path = resolve(source);
    const rel = relative(root, path);
    if (
      rel === "" ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    )
      throw new TeaError(
        "invalid_plan",
        `source path escapes plan repository: ${source}`,
      );
  }
};

const qualityRun = (result: {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly randomSeed?: number;
  readonly output: string;
}): QualityRun => ({
  passed: result.passed,
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  durationMs: result.durationMs,
  randomSeed: result.randomSeed ?? null,
  ...(result.passed ? {} : { output: result.output.slice(0, 2_000) }),
});

interface MutationRunInput {
  readonly plan: SourceTestPlan;
  readonly sources: readonly string[];
  readonly mutationLimit: number;
  readonly timeoutMs?: number;
  readonly limitations: string[];
}

const runMutations = async (
  input: MutationRunInput,
): Promise<MutationSummary> => {
  const candidates = input.plan.mutations ?? [];
  if (input.plan.mutations === undefined)
    input.limitations.push(
      "source plan has no mutation metadata; regenerate it with the current TEA version",
    );
  if (candidates.length === 0)
    input.limitations.push("source plan contains no mutation candidates");
  const selected = candidates.slice(0, input.mutationLimit);
  if (candidates.length > selected.length)
    input.limitations.push(
      `mutation run limited to ${selected.length} of ${candidates.length} candidates`,
    );
  if (selected.length === 0) return emptyMutationSummary();

  const workspace = await mkdtemp(join(tmpdir(), "tea-quality-"));
  const originalTexts = new Map<string, string>();
  const mappedSources = new Map<string, string>();
  try {
    for (const [index, source] of input.sources.entries()) {
      const text = await readFile(source, "utf8");
      if (Buffer.byteLength(text, "utf8") > SOURCE_TEST_LIMITS.maxSourceBytes)
        throw new TeaError(
          "invalid_plan",
          `source file exceeds ${SOURCE_TEST_LIMITS.maxSourceBytes} bytes: ${source}`,
        );
      const mapped = join(workspace, "sources", `${index}-${basename(source)}`);
      await mkdir(dirname(mapped), { recursive: true });
      await writeFile(mapped, text);
      originalTexts.set(source, text);
      mappedSources.set(source, mapped);
    }
    const mappedCases = input.plan.cases.map((testCase) => ({
      ...testCase,
      sourcePath: mappedSources.get(testCase.sourcePath) ?? testCase.sourcePath,
    }));
    const workspaceTest = join(workspace, "tea-source-tests.mjs");
    await writeFile(
      workspaceTest,
      renderSourceTestFile(workspace, mappedCases),
    );
    const workspaceBaseline = await verifyGeneratedTests({
      testFile: workspaceTest,
      artifactPolicy: "trusted",
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (!workspaceBaseline.passed)
      throw new TeaError(
        "workspace_baseline_failed",
        "copied source suite failed before mutation",
      );

    const results: MutationResult[] = [];
    for (const mutation of selected) {
      const mapped = mappedSources.get(mutation.sourcePath);
      const originalText = originalTexts.get(mutation.sourcePath);
      if (mapped === undefined || originalText === undefined) {
        results.push(
          invalidMutation(mutation, "mutation source has no test cases"),
        );
        continue;
      }
      if (
        mutation.end < mutation.start ||
        mutation.end > originalText.length ||
        originalText.slice(mutation.start, mutation.end) !== mutation.original
      ) {
        results.push(
          invalidMutation(
            mutation,
            "source text or offsets changed; regenerate the source plan",
          ),
        );
        continue;
      }
      const mutated =
        originalText.slice(0, mutation.start) +
        mutation.replacement +
        originalText.slice(mutation.end);
      await writeFile(mapped, mutated);
      try {
        const result = await verifyGeneratedTests({
          testFile: workspaceTest,
          artifactPolicy: "trusted",
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        });
        results.push({
          id: mutation.id,
          sourcePath: mutation.sourcePath,
          exportName: mutation.exportName,
          original: mutation.original,
          replacement: mutation.replacement,
          status: result.timedOut
            ? "timed_out"
            : result.passed
              ? "survived"
              : "killed",
          durationMs: result.durationMs,
        });
      } finally {
        await writeFile(mapped, originalText);
      }
    }
    return summarizeMutations(results);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

const invalidMutation = (
  mutation: SourceMutation,
  limitation: string,
): MutationResult => ({
  id: mutation.id,
  sourcePath: mutation.sourcePath,
  exportName: mutation.exportName,
  original: mutation.original,
  replacement: mutation.replacement,
  status: "invalid",
  durationMs: 0,
  limitation,
});

const summarizeMutations = (
  results: readonly MutationResult[],
): MutationSummary => ({
  total: results.length,
  killed: results.filter((result) => result.status === "killed").length,
  survived: results.filter((result) => result.status === "survived").length,
  timedOut: results.filter((result) => result.status === "timed_out").length,
  invalid: results.filter((result) => result.status === "invalid").length,
  score: null,
  results,
});

const emptyMutationSummary = (): MutationSummary => ({
  total: 0,
  killed: 0,
  survived: 0,
  timedOut: 0,
  invalid: 0,
  score: null,
  results: [],
});

const coverageDelta = (
  generated: CoverageSummary | null,
  baseline: CoverageSummary | null,
): CoverageDelta | null =>
  generated === null || baseline === null
    ? null
    : {
        lines: generated.lines - baseline.lines,
        branches: generated.branches - baseline.branches,
        functions: generated.functions - baseline.functions,
      };

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new TeaError(
      "invalid_input",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  return result;
};

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";
