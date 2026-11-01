import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import { artifactManifestPath } from "./tea/artifact.js";
import {
  generateSourceTestArtifacts,
  verifyGeneratedTests,
} from "./tea/index.js";

const generate = async (root: string) => {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "artifact-fixture", type: "module" }),
  );
  await writeFile(
    join(root, "src", "math.ts"),
    "export const add = (a: number, b: number): number => a + b;\n",
  );
  const outputDir = join(root, "generated");
  const result = await generateSourceTestArtifacts({
    repoDir: root,
    outputDir,
  });
  return {
    result,
    testFile: join(outputDir, "tea-source-tests.mjs"),
  };
};

describe("TEA artifact admission", () => {
  it("writes and accepts a matching source manifest", async () => {
    const root = await createTestTempDirectory("tea-artifact-pass-");
    const { result, testFile } = await generate(root);
    const manifestFile = result.files.find((file) => file.kind === "manifest");
    expect(manifestFile?.path).toBe(artifactManifestPath(testFile));
    const manifest = JSON.parse(
      await readFile(artifactManifestPath(testFile), "utf8"),
    ) as { kind?: string; formatVersion?: number };
    expect(manifest.kind).toBe("source");
    expect(manifest.formatVersion).toBe(1);

    const verification = await verifyGeneratedTests({ testFile });
    expect(verification.passed).toBe(true);
    expect(verification.environment.inheritedAmbient).toBe(false);
  });

  it("rejects a test modified after manifest generation", async () => {
    const root = await createTestTempDirectory("tea-artifact-tamper-");
    const { testFile } = await generate(root);
    await writeFile(
      testFile,
      `${await readFile(testFile, "utf8")}// tampered\n`,
    );
    await expect(verifyGeneratedTests({ testFile })).rejects.toMatchObject({
      code: "artifact_digest_mismatch",
    });
  });

  it("requires the manifest and rejects a symlinked manifest", async () => {
    const root = await createTestTempDirectory("tea-artifact-manifest-");
    const { testFile } = await generate(root);
    const manifestPath = artifactManifestPath(testFile);
    const backup = join(root, "manifest-backup.json");
    await copyFile(manifestPath, backup);
    await unlink(manifestPath);
    await expect(verifyGeneratedTests({ testFile })).rejects.toMatchObject({
      code: "artifact_manifest_missing",
    });
    await symlink(backup, manifestPath);
    await expect(verifyGeneratedTests({ testFile })).rejects.toMatchObject({
      code: "unsafe_artifact",
    });
  });
});

describe("TEA child process environment", () => {
  it("filters ambient secrets, forwards only declared values, and uses a temporary cwd", async () => {
    const root = await createTestTempDirectory("tea-environment-");
    const testFile = join(root, "environment.mjs");
    await writeFile(
      testFile,
      `import { test } from "node:test";
import assert from "node:assert/strict";
test("bounded environment", () => {
  assert.equal(process.env.TEA_TEST_SECRET, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.TEA_BASE_URL, "http://127.0.0.1:3000");
  assert.notEqual(process.cwd(), ${JSON.stringify(process.cwd())});
});
`,
    );
    const previousSecret = process.env.TEA_TEST_SECRET;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.TEA_TEST_SECRET = "do-not-forward";
    process.env.NODE_OPTIONS = "--inspect";
    try {
      const report = await verifyGeneratedTests({
        testFile,
        baseUrl: "http://127.0.0.1:3000",
        artifactPolicy: "trusted",
      });
      expect(report.passed).toBe(true);
      expect(report.environment.forwardedVariables).not.toContain(
        "TEA_TEST_SECRET",
      );
      expect(report.environment.forwardedVariables).not.toContain(
        "NODE_OPTIONS",
      );
      expect(report.environment.explicitVariables).toEqual(["TEA_BASE_URL"]);
    } finally {
      if (previousSecret === undefined) delete process.env.TEA_TEST_SECRET;
      else process.env.TEA_TEST_SECRET = previousSecret;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });
});
