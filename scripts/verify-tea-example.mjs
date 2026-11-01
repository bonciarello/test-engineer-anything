import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "scripts/tea.mjs");
const example = join(root, "examples/openapi-service");
const workspace = await mkdtemp(join(tmpdir(), "tea-example-"));
let server;

const run = (command, input) => {
  const result = spawnSync(process.execPath, [entry, command], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} exited with ${String(result.status)}: ${result.stderr || result.stdout}`,
    );
  return JSON.parse(result.stdout);
};

try {
  const analysis = run("analyze-product", { repoDir: example });
  const plan = run("plan-tests", { repoDir: example });
  if (analysis.specs.length !== 1 || plan.cases.length !== 1)
    throw new Error(
      "example did not produce exactly one planned contract test",
    );
  if (
    !plan.excluded.some(
      (item) =>
        item.method === "post" &&
        item.path === "/reset" &&
        item.reason === "mutating method",
    )
  )
    throw new Error("example did not exclude the mutating POST operation");

  const generated = run("generate-tests", {
    repoDir: example,
    outputDir: join(workspace, "generated"),
  });
  const testFile = generated.files.find((file) => file.kind === "test")?.path;
  if (testFile === undefined)
    throw new Error("generated test artifact is missing");

  const sourcePlan = run("plan-source-tests", { repoDir: example });
  if (
    sourcePlan.cases.length < 3 ||
    !sourcePlan.cases.every(
      (testCase) =>
        testCase.evidence.confidence === "derived" &&
        testCase.sourcePath.endsWith("calculations.ts"),
    )
  )
    throw new Error("example did not produce evidence-backed source tests");
  const sourceGenerated = run("generate-source-tests", {
    repoDir: example,
    outputDir: join(workspace, "source-generated"),
  });
  const sourceTestFile = sourceGenerated.files.find(
    (file) => file.kind === "test",
  )?.path;
  if (sourceTestFile === undefined)
    throw new Error("generated source-test artifact is missing");
  const sourceVerification = run("verify-tests", {
    testFile: sourceTestFile,
  });
  if (
    !sourceVerification.passed ||
    sourceVerification.exitCode !== 0 ||
    sourceVerification.baseUrl !== null
  )
    throw new Error(
      `generated source tests failed: ${sourceVerification.output}`,
    );
  const quality = run("evaluate-source-tests", {
    testFile: sourceTestFile,
    repetitions: 2,
    minimumMutationScore: 1,
  });
  if (!quality.passed || !quality.stable || quality.mutations.score !== 1)
    throw new Error(
      `source quality gate failed: ${JSON.stringify(quality.mutations)}`,
    );

  server = spawn(process.execPath, [join(example, "server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => rejectReady(new Error("example server startup timed out")),
      5_000,
    );
    server.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    server.once("error", (cause) => {
      clearTimeout(timer);
      rejectReady(cause);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(
        new Error(`example server exited with ${String(code)}: ${stderr}`),
      );
    });
  });

  const verification = run("verify-tests", { testFile, baseUrl });
  if (!verification.passed || verification.exitCode !== 0)
    throw new Error(`generated example tests failed: ${verification.output}`);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      plannedCases: plan.cases.length,
      excludedOperations: plan.excluded.length,
      verificationPassed: verification.passed,
      sourcePlannedCases: sourcePlan.cases.length,
      sourceVerificationPassed: sourceVerification.passed,
      sourceQualityPassed: quality.passed,
      mutationScore: quality.mutations.score,
      generatedLineCoverage: quality.coverage.generated?.lines ?? null,
    })}\n`,
  );
} finally {
  if (server !== undefined && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolveClose();
      }, 2_000);
      server.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
  await rm(workspace, { recursive: true, force: true });
}
