import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import {
  evaluateSourceTests,
  generateSourceTestArtifacts,
} from "./tea/index.js";

const writeRepository = async (
  root: string,
  source: string,
): Promise<string> => {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "quality-fixture", type: "module" }),
  );
  const sourcePath = join(root, "src", "math.ts");
  await writeFile(sourcePath, source);
  return sourcePath;
};

const generate = async (root: string) => {
  const outputDir = join(root, "generated");
  await generateSourceTestArtifacts({ repoDir: root, outputDir });
  return join(outputDir, "tea-source-tests.mjs");
};

describe("evaluateSourceTests", () => {
  it("measures stable runs, kills deterministic mutants, parses coverage, and preserves sources", async () => {
    const root = await createTestTempDirectory("tea-quality-pass-");
    const sourcePath = await writeRepository(
      root,
      `export function add(a: number, b: number): number { return a + b; }
export const positive = (n: number): boolean => n > 0;
`,
    );
    const original = await readFile(sourcePath, "utf8");
    const testFile = await generate(root);

    const report = await evaluateSourceTests({
      testFile,
      repetitions: 2,
      mutationLimit: 10,
      minimumMutationScore: 1,
    });

    expect(report.stable).toBe(true);
    expect(report.baseline).toHaveLength(2);
    expect(report.baseline[0]?.randomSeed).toBeNull();
    expect(report.baseline[1]?.randomSeed).not.toBeNull();
    expect(report.mutations.total).toBe(2);
    expect(report.mutations.killed).toBe(2);
    expect(report.mutations.survived).toBe(0);
    expect(report.mutations.score).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.coverage.generated).not.toBeNull();
    expect(report.coverage.baseline).toBeNull();
    expect(report.coverage.delta).toBeNull();
    expect(report.limitations.join(" ")).toContain(
      "baselineTestFile was not supplied",
    );
    expect(await readFile(sourcePath, "utf8")).toBe(original);
  });

  it("reports a surviving equivalent mutant instead of treating green tests as sufficient", async () => {
    const root = await createTestTempDirectory("tea-quality-survivor-");
    await writeRepository(
      root,
      "export const addZero = (a: number): number => a + 0;\n",
    );
    const testFile = await generate(root);

    const report = await evaluateSourceTests({
      testFile,
      repetitions: 1,
      coverage: false,
      minimumMutationScore: 1,
    });

    expect(report.mutations.survived).toBe(1);
    expect(report.mutations.killed).toBe(0);
    expect(report.mutations.score).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("rejects a generated test that no longer matches its plan", async () => {
    const root = await createTestTempDirectory("tea-quality-mismatch-");
    await writeRepository(
      root,
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    const testFile = await generate(root);
    await writeFile(testFile, `${await readFile(testFile, "utf8")}// edited\n`);

    await expect(
      evaluateSourceTests({ testFile, coverage: false }),
    ).rejects.toMatchObject({ code: "artifact_mismatch" });
  });

  it("computes coverage delta only against an explicitly supplied baseline", async () => {
    const root = await createTestTempDirectory("tea-quality-delta-");
    await writeRepository(
      root,
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    const testFile = await generate(root);

    const report = await evaluateSourceTests({
      testFile,
      baselineTestFile: testFile,
      repetitions: 1,
      mutationLimit: 0,
    });

    expect(report.coverage.generated).not.toBeNull();
    expect(report.coverage.baseline).not.toBeNull();
    expect(report.coverage.delta).toEqual({
      lines: 0,
      branches: 0,
      functions: 0,
    });
  });

  it("marks stale mutation offsets invalid and leaves the changed source untouched", async () => {
    const root = await createTestTempDirectory("tea-quality-stale-");
    const sourcePath = await writeRepository(
      root,
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    const testFile = await generate(root);
    await writeFile(
      sourcePath,
      `// harmless shift\n${await readFile(sourcePath, "utf8")}`,
    );
    const shifted = await readFile(sourcePath, "utf8");

    const report = await evaluateSourceTests({
      testFile,
      repetitions: 1,
      coverage: false,
    });

    expect(report.mutations.invalid).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.mutations.results[0]?.limitation).toContain("regenerate");
    expect(await readFile(sourcePath, "utf8")).toBe(shifted);
  });

  it("validates quality-run bounds before touching artifacts", async () => {
    await expect(
      evaluateSourceTests({ testFile: "/unused", repetitions: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      evaluateSourceTests({ testFile: "/unused", mutationLimit: -1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
