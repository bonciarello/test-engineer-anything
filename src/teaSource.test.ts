import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import {
  generateSourceTestArtifacts,
  planSourceTests,
  verifyGeneratedTests,
} from "./tea/index.js";

const PURE_MATH = `export function add(a: number, b: number): number {
  return a + b;
}

export const double = (n: number): number => n * 2;

export function classify(n: number): string {
  return n < 0 ? "neg" : "nonneg";
}

export const either = (a: boolean, b: boolean): boolean => a || b;

export function greet(name: string): string {
  return \`hi \${name}\`;
}
`;

const writePureRepo = async (dir: string): Promise<void> => {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "pure-lib", version: "1.0.0", type: "module" }),
  );
  await writeFile(join(dir, "src", "math.ts"), PURE_MATH);
};

describe("planSourceTests", () => {
  it("plans declaration and arrow functions across number/string/boolean with precomputed values", async () => {
    const root = await createTestTempDirectory("tea-source-plan-");
    await writePureRepo(root);
    const plan = await planSourceTests({ repoDir: root });

    const caseFor = (name: string, args: readonly unknown[]) =>
      plan.cases.find(
        (testCase) =>
          testCase.exportName === name &&
          JSON.stringify(testCase.args) === JSON.stringify(args),
      );

    expect(caseFor("add", [1, 0])?.expected).toBe(1);
    expect(caseFor("add", [0, 1])?.expected).toBe(1);
    expect(caseFor("add", [-1, 0])?.expected).toBe(-1);
    expect(caseFor("double", [1])?.expected).toBe(2);
    expect(caseFor("double", [-1])?.expected).toBe(-2);
    expect(caseFor("classify", [-1])?.expected).toBe("neg");
    expect(caseFor("classify", [0])?.expected).toBe("nonneg");
    expect(caseFor("either", [true, false])?.expected).toBe(true);
    expect(caseFor("either", [false, false])?.expected).toBe(false);
    expect(caseFor("greet", ["a"])?.expected).toBe("hi a");

    const add = caseFor("add", [1, 0]);
    expect(add?.evidence.confidence).toBe("derived");
    expect(add?.evidence.authority).toBe("shipped-artifact");
    expect(add?.evidence.limitations.join(" ")).toContain("regressions");
    expect(plan.sourceFiles.some((file) => file.endsWith("math.ts"))).toBe(
      true,
    );
  });

  it("excludes side-effectful, importing, calling, async, and unannotated functions with reasons", async () => {
    const root = await createTestTempDirectory("tea-source-exclude-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(root, "src", "side.ts"),
      'console.log("boom");\nexport const f = (a: number): number => a;\n',
    );
    await writeFile(
      join(root, "src", "imp.ts"),
      'import { x } from "./other";\nexport const f = (a: number): number => a;\n',
    );
    await writeFile(
      join(root, "src", "calls.ts"),
      "export const f = (a: number): number => a + Math.abs(a);\n",
    );
    await writeFile(
      join(root, "src", "async.ts"),
      "export async function f(a: number): Promise<number> { return a; }\n",
    );
    await writeFile(
      join(root, "src", "badparam.ts"),
      "export const f = (a) => a;\n",
    );
    const plan = await planSourceTests({ repoDir: root });
    const reasons = plan.excluded.map((entry) => entry.reason);
    expect(reasons).toContain("top-level expression statement");
    expect(reasons).toContain("module imports other modules");
    expect(reasons).toContain("unsupported expression CallExpression");
    expect(reasons).toContain("async functions are not supported");
    expect(reasons).toContain(
      'parameter "a" must be annotated number, string, or boolean',
    );
    expect(plan.cases.length).toBe(0);
  });

  it("caps generated cases per function", async () => {
    const root = await createTestTempDirectory("tea-source-cap-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(root, "src", "wide.ts"),
      "export function many(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): number {\n  return a + b;\n}\n",
    );
    const plan = await planSourceTests({ repoDir: root });
    const manyCases = plan.cases.filter(
      (testCase) => testCase.exportName === "many",
    );
    expect(manyCases.length).toBe(16);
  });

  it("evaluates unordered (NaN) relational comparisons as false like JavaScript", async () => {
    const root = await createTestTempDirectory("tea-source-nan-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(root, "src", "nan.ts"),
      [
        "export const le = (a: number, b: number): boolean => a / b <= 1;",
        "export const lt = (a: number, b: number): boolean => a / b < 1;",
        "export const gt = (a: number, b: number): boolean => a / b > 1;",
        "export const ge = (a: number, b: number): boolean => a / b >= 1;",
      ].join("\n"),
    );
    const plan = await planSourceTests({ repoDir: root });
    const caseFor = (name: string, args: readonly unknown[]) =>
      plan.cases.find(
        (testCase) =>
          testCase.exportName === name &&
          JSON.stringify(testCase.args) === JSON.stringify(args),
      );

    // 0 / 0 is NaN, so every relational comparison must be false.
    expect(caseFor("le", [0, 0])?.expected).toBe(false);
    expect(caseFor("lt", [0, 0])?.expected).toBe(false);
    expect(caseFor("gt", [0, 0])?.expected).toBe(false);
    expect(caseFor("ge", [0, 0])?.expected).toBe(false);

    // Non-NaN operands still follow ordinary JavaScript ordering.
    expect(caseFor("le", [1, 0])?.expected).toBe(false); // Infinity <= 1
    expect(caseFor("le", [-1, 0])?.expected).toBe(true); // -Infinity <= 1
    expect(caseFor("le", [0, 1])?.expected).toBe(true);
    expect(caseFor("lt", [1, 0])?.expected).toBe(false);
    expect(caseFor("lt", [0, 1])?.expected).toBe(true);
    expect(caseFor("gt", [1, 0])?.expected).toBe(true);
    expect(caseFor("gt", [0, 1])?.expected).toBe(false);
    expect(caseFor("ge", [1, 0])?.expected).toBe(true);
    expect(caseFor("ge", [0, 1])?.expected).toBe(false);
  });

  it("skips .ts files larger than maxSourceBytes without reading them", async () => {
    const root = await createTestTempDirectory("tea-source-large-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(root, "src", "big.ts"),
      `/* ${"x".repeat(1024 * 1024)} */\nexport const f = (a: number): number => a;\n`,
    );
    const plan = await planSourceTests({ repoDir: root });
    expect(plan.cases.length).toBe(0);
    const exclusion = plan.excluded.find((entry) =>
      entry.sourcePath.endsWith("big.ts"),
    );
    expect(exclusion?.reason).toContain("bytes");
    expect(
      plan.limitations.some(
        (entry) => entry.includes("big.ts") && entry.includes("bytes"),
      ),
    ).toBe(true);
  });
});

describe("generateSourceTestArtifacts", () => {
  it("writes a standalone .mjs with a relative .ts import and a plan JSON", async () => {
    const root = await createTestTempDirectory("tea-source-generate-");
    await writePureRepo(root);
    const plan = await planSourceTests({ repoDir: root });
    const outputDir = join(root, "out");
    const result = await generateSourceTestArtifacts({
      repoDir: root,
      outputDir,
      plan,
    });
    expect(result.caseCount).toBe(plan.cases.length);
    expect(result.files.map((file) => file.kind).sort()).toEqual([
      "manifest",
      "plan",
      "test",
    ]);

    const testContent = await readFile(
      join(outputDir, "tea-source-tests.mjs"),
      "utf8",
    );
    expect(testContent).toContain('from "../src/math.ts"');
    expect(testContent).toContain("node:test");
    expect(testContent).not.toContain("TEA_BASE_URL");
    expect(testContent).not.toContain("eval");

    const planContent = JSON.parse(
      await readFile(join(outputDir, "tea-source-plan.json"), "utf8"),
    ) as { cases: unknown[]; excluded: unknown[] };
    expect(planContent.cases.length).toBe(result.caseCount);
    expect(Array.isArray(planContent.excluded)).toBe(true);
  });

  it("refuses to overwrite without consent and honors the overwrite flag", async () => {
    const root = await createTestTempDirectory("tea-source-overwrite-");
    await writePureRepo(root);
    const outputDir = join(root, "out");
    await generateSourceTestArtifacts({ repoDir: root, outputDir });
    await expect(
      generateSourceTestArtifacts({ repoDir: root, outputDir }),
    ).rejects.toMatchObject({ code: "already_exists" });
    await expect(
      generateSourceTestArtifacts({
        repoDir: root,
        outputDir,
        overwrite: true,
      }),
    ).resolves.toMatchObject({ caseCount: 17 });
  });

  it("canonicalizes an output directory below a symlinked parent", async () => {
    const root = await createTestTempDirectory("tea-source-parent-link-");
    await writePureRepo(root);
    const actualParent = join(root, "deep", "actual");
    await mkdir(actualParent, { recursive: true });
    const alias = join(root, "alias");
    await symlink(actualParent, alias);
    const outputDir = join(alias, "generated");

    const generated = await generateSourceTestArtifacts({
      repoDir: root,
      outputDir,
    });
    expect(generated.outputDir).toBe(await realpath(outputDir));
    const passing = await verifyGeneratedTests({
      testFile: join(generated.outputDir, "tea-source-tests.mjs"),
    });
    expect(passing.passed).toBe(true);
  });

  it("refuses to write through a symlinked output file", async () => {
    const root = await createTestTempDirectory("tea-source-symlink-");
    await writePureRepo(root);
    const outputDir = join(root, "out");
    await mkdir(outputDir);
    await writeFile(join(root, "elsewhere.txt"), "do not clobber");
    await symlink(
      join(root, "elsewhere.txt"),
      join(outputDir, "tea-source-tests.mjs"),
    );
    await expect(
      generateSourceTestArtifacts({
        repoDir: root,
        outputDir,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "unsafe_output" });
  });
});

describe("source-test end to end", () => {
  it("plans, generates, verifies, and fails when the source expression changes without regeneration", async () => {
    const root = await createTestTempDirectory("tea-source-e2e-");
    await writePureRepo(root);
    const outputDir = join(root, "out");
    const plan = await planSourceTests({ repoDir: root });
    expect(plan.cases.length).toBeGreaterThan(0);

    await generateSourceTestArtifacts({ repoDir: root, outputDir });
    const testFile = join(outputDir, "tea-source-tests.mjs");

    const passing = await verifyGeneratedTests({ testFile });
    expect(passing.passed).toBe(true);
    expect(passing.exitCode).toBe(0);
    expect(passing.baseUrl).toBeNull();

    const mathPath = join(root, "src", "math.ts");
    const original = await readFile(mathPath, "utf8");
    try {
      await writeFile(
        mathPath,
        original.replace("return a + b;", "return a - b;"),
      );
      const failing = await verifyGeneratedTests({ testFile });
      expect(failing.passed).toBe(false);
      expect(failing.exitCode).not.toBe(0);
    } finally {
      await writeFile(mathPath, original);
    }
  });
});
