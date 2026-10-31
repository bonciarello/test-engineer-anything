import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import {
  analyzeProduct,
  generateTestArtifacts,
  planContractTests,
  verifyGeneratedTests,
  TeaError,
} from "./tea/index.js";

const OPENAPI_FIXTURE = {
  openapi: "3.0.3",
  info: { title: "Fixture API", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
            example: 7,
          },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
        },
      },
      head: {
        operationId: "headUser",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: { "204": { description: "no content" } },
      },
      post: {
        operationId: "createUser",
        responses: { "201": { description: "created" } },
      },
    },
    "/search": {
      get: {
        operationId: "search",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["alpha", "beta"] },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/User" },
                },
              },
            },
          },
        },
      },
    },
    "/unresolvable/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/no-2xx": {
      get: { responses: { "404": { description: "not found" } } },
    },
    "/unsupported": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  patternProperties: { "^x": { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
      },
    },
  },
};

const YAML_FIXTURE = `openapi: 3.0.3
info:
  title: YAML API
  version: 1.0.0
paths:
  /ping:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [ok]
                properties:
                  ok:
                    type: boolean
`;

/** Write a representative Node repository with two specs and exclusions. */
const writeFixtureRepo = async (dir: string): Promise<void> => {
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-api", version: "2.3.4" }),
  );
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(
    join(dir, "node_modules", "ignored.ts"),
    "export const y = 1;\n",
  );
  await writeFile(join(dir, "dist", "built.js"), "export const z = 1;\n");
  await writeFile(
    join(dir, "openapi.json"),
    JSON.stringify(OPENAPI_FIXTURE, null, 2),
  );
  await writeFile(join(dir, "openapi.yaml"), YAML_FIXTURE);
};

describe("analyzeProduct", () => {
  it("reads package.json safely and builds a bounded inventory", async () => {
    const root = await createTestTempDirectory("tea-analyze-");
    await writeFixtureRepo(root);
    const analysis = await analyzeProduct(root);
    expect(analysis.product.name).toBe("fixture-api");
    expect(analysis.product.version).toBe("2.3.4");
    expect(analysis.product.packageJsonError).toBeNull();
    const names = analysis.inventory.sourceFiles.map((file) =>
      file.split("/").pop(),
    );
    expect(names).toContain("index.ts");
    expect(names).not.toContain("ignored.ts");
    expect(names).not.toContain("built.js");
    expect(analysis.specs.map((spec) => spec.path.split("/").pop())).toEqual([
      "openapi.json",
      "openapi.yaml",
    ]);
  });

  it("reports a malformed package.json without throwing", async () => {
    const root = await createTestTempDirectory("tea-bad-package-");
    await writeFile(join(root, "package.json"), "{ not json");
    const analysis = await analyzeProduct(root);
    expect(analysis.product.packageJsonError).not.toBeNull();
    expect(analysis.product.name).toBeNull();
  });

  it("rejects a missing repository", async () => {
    const root = await createTestTempDirectory("tea-missing-");
    await expect(
      analyzeProduct(join(root, "does-not-exist")),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("planContractTests", () => {
  it("plans GET/HEAD cases with evidence and excludes mutations", async () => {
    const root = await createTestTempDirectory("tea-plan-");
    await writeFixtureRepo(root);
    const plan = await planContractTests({ repoDir: root });
    const methods = new Set(plan.cases.map((testCase) => testCase.method));
    expect(methods).toEqual(new Set(["get", "head"]));

    const getUser = plan.cases.find(
      (testCase) => testCase.operationId === "getUser",
    );
    expect(getUser).toBeDefined();
    expect(getUser?.evidence.authority).toBe("shipped-artifact");
    expect(getUser?.evidence.confidence).toBe("observed");
    expect(getUser?.evidence.jsonPointer).toBe("/paths/~1users~1{id}/get");
    expect(getUser?.pathParams).toEqual({ id: "7" });
    expect(getUser?.expectedStatus).toEqual([200]);
    expect(getUser?.responses[0]?.schemaSupported).toBe(true);

    const search = plan.cases.find(
      (testCase) => testCase.operationId === "search",
    );
    expect(search?.queryParams).toEqual({ q: "alpha" });

    const postExclusion = plan.excluded.find(
      (entry) => entry.method === "post",
    );
    expect(postExclusion?.reason).toBe("mutating method");

    const reasons = plan.excluded.map((entry) => entry.reason);
    expect(reasons).toContain('unresolvable path parameter "id"');
    expect(reasons).toContain("no documented 2xx response");
  });

  it("falls back to status/content-type for unsupported schema keywords", async () => {
    const root = await createTestTempDirectory("tea-schema-fallback-");
    await writeFixtureRepo(root);
    const plan = await planContractTests({ repoDir: root });
    const unsupported = plan.cases.find((testCase) =>
      testCase.pathTemplate.includes("/unsupported"),
    );
    expect(unsupported?.responses[0]?.schemaSupported).toBe(false);
    expect(unsupported?.responses[0]?.unsupportedReason).toContain(
      "patternProperties",
    );
    expect(
      plan.limitations.some((entry) => entry.includes("patternProperties")),
    ).toBe(true);
  });
});

describe("generateTestArtifacts", () => {
  it("writes a standalone test file and tea-plan.json", async () => {
    const root = await createTestTempDirectory("tea-generate-");
    await writeFixtureRepo(root);
    const outputDir = join(root, "out");
    const result = await generateTestArtifacts({ repoDir: root, outputDir });
    expect(result.caseCount).toBeGreaterThan(0);
    expect(result.files.map((file) => file.kind).sort()).toEqual([
      "plan",
      "test",
    ]);

    const testContent = await readFile(
      join(outputDir, "tea-contract-tests.mjs"),
      "utf8",
    );
    expect(testContent).toContain("node:test");
    expect(testContent).toContain("TEA_BASE_URL");
    expect(testContent).toContain("fetch(");
    const planContent = JSON.parse(
      await readFile(join(outputDir, "tea-plan.json"), "utf8"),
    ) as { cases: unknown[] };
    expect(planContent.cases.length).toBe(result.caseCount);
  });

  it("refuses to overwrite without consent and honors the overwrite flag", async () => {
    const root = await createTestTempDirectory("tea-overwrite-");
    await writeFixtureRepo(root);
    const outputDir = join(root, "out");
    await generateTestArtifacts({ repoDir: root, outputDir });
    await expect(
      generateTestArtifacts({ repoDir: root, outputDir }),
    ).rejects.toMatchObject({ code: "already_exists" });
    await expect(
      generateTestArtifacts({ repoDir: root, outputDir, overwrite: true }),
    ).resolves.toMatchObject({ caseCount: 5 });
  });

  it("refuses to write through a symlinked output file", async () => {
    const root = await createTestTempDirectory("tea-symlink-");
    await writeFixtureRepo(root);
    const outputDir = join(root, "out");
    await mkdir(outputDir);
    await writeFile(join(root, "elsewhere.txt"), "do not clobber");
    await symlink(
      join(root, "elsewhere.txt"),
      join(outputDir, "tea-contract-tests.mjs"),
    );
    await expect(
      generateTestArtifacts({ repoDir: root, outputDir, overwrite: true }),
    ).rejects.toMatchObject({ code: "unsafe_output" });
  });
});

const writeVerifyRepo = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "verify-api", version: "1.0.0" }),
  );
  await writeFile(
    join(dir, "openapi.json"),
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Verify API", version: "1.0.0" },
      paths: {
        "/users/{id}": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "integer" },
                example: 1,
              },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
        "/health": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
      components: {
        schemas: {
          User: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "integer" }, name: { type: "string" } },
          },
        },
      },
    }),
  );
};

const startServer = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = createServer((req, res) => {
    handler(req, res);
  });
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
};

const generateForVerify = async (
  root: string,
): Promise<{ outputDir: string; testFile: string }> => {
  const outputDir = join(root, "out");
  await generateTestArtifacts({ repoDir: root, outputDir });
  return { outputDir, testFile: join(outputDir, "tea-contract-tests.mjs") };
};

describe("verifyGeneratedTests", () => {
  it("passes against a server honoring the contract", async () => {
    const root = await createTestTempDirectory("tea-verify-pass-");
    await writeVerifyRepo(root);
    const { testFile } = await generateForVerify(root);
    const server = await startServer((req, res) => {
      if (req.url === "/users/1") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: 1, name: "Ada" }));
        return;
      }
      if (req.url === "/health") {
        res.statusCode = 200;
        res.end("ok");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    try {
      const report = await verifyGeneratedTests({
        testFile,
        baseUrl: server.baseUrl,
        timeoutMs: 10_000,
      });
      expect(report.passed).toBe(true);
      expect(report.exitCode).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("fails with a nonzero exit code on a status mismatch", async () => {
    const root = await createTestTempDirectory("tea-verify-status-");
    await writeVerifyRepo(root);
    const { testFile } = await generateForVerify(root);
    const server = await startServer((req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    try {
      const report = await verifyGeneratedTests({
        testFile,
        baseUrl: server.baseUrl,
        timeoutMs: 10_000,
      });
      expect(report.passed).toBe(false);
      expect(report.exitCode).not.toBe(0);
      expect(report.output).toContain("expected status");
    } finally {
      await server.close();
    }
  });

  it("fails when the response body violates the documented schema", async () => {
    const root = await createTestTempDirectory("tea-verify-schema-");
    await writeVerifyRepo(root);
    const { testFile } = await generateForVerify(root);
    const server = await startServer((req, res) => {
      if (req.url === "/users/1") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ name: "missing id" }));
        return;
      }
      res.statusCode = 200;
      res.end("ok");
    });
    try {
      const report = await verifyGeneratedTests({
        testFile,
        baseUrl: server.baseUrl,
        timeoutMs: 10_000,
      });
      expect(report.passed).toBe(false);
      expect(report.exitCode).not.toBe(0);
      expect(report.output).toContain("required");
    } finally {
      await server.close();
    }
  });

  it("rejects a non-http base URL", async () => {
    const root = await createTestTempDirectory("tea-verify-url-");
    await writeVerifyRepo(root);
    const { testFile } = await generateForVerify(root);
    await expect(
      verifyGeneratedTests({ testFile, baseUrl: "ftp://example.com" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("surfaces TeaError codes instead of raw failures", async () => {
    await expect(
      verifyGeneratedTests({
        testFile: "/nope/missing.mjs",
        baseUrl: "http://localhost:1",
      }),
    ).rejects.toBeInstanceOf(TeaError);
  });
});
