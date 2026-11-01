import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../tests/fixtures/temporaryDirectory.js";
import { createTeaMcpServer } from "./teaMcp.js";

const connect = async (): Promise<{
  server: ReturnType<typeof createTeaMcpServer>;
  client: Client;
}> => {
  const server = createTeaMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tea-test-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
};

describe("tea MCP server", () => {
  it("advertises the six tools", async () => {
    const { server, client } = await connect();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "analyze_product",
        "generate_source_tests",
        "generate_tests",
        "plan_source_tests",
        "plan_tests",
        "verify_tests",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("plans source tests through plan_source_tests", async () => {
    const root = await createTestTempDirectory("tea-mcp-source-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "mcp-source", version: "1.0.0", type: "module" }),
    );
    await writeFile(
      join(root, "src.ts"),
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    const { server, client } = await connect();
    try {
      const result = await client.callTool({
        name: "plan_source_tests",
        arguments: { repoDir: root },
      });
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        cases?: unknown[];
        repoDir?: string;
      };
      expect(Array.isArray(structured.cases)).toBe(true);
      expect((structured.cases ?? []).length).toBeGreaterThan(0);
      expect(structured.repoDir).toBe(root);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns analysis through structuredContent", async () => {
    const root = await createTestTempDirectory("tea-mcp-analyze-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "mcp-fixture", version: "1.0.0" }),
    );
    await writeFile(
      join(root, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "MCP", version: "1.0.0" },
        paths: {},
      }),
    );
    const { server, client } = await connect();
    try {
      const result = await client.callTool({
        name: "analyze_product",
        arguments: { repoDir: root },
      });
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        product?: { name?: string };
      };
      expect(structured.product?.name).toBe("mcp-fixture");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports tool failures as errors without leaking stacks", async () => {
    const { server, client } = await connect();
    try {
      const result = await client.callTool({
        name: "analyze_product",
        arguments: { repoDir: "/does/not/exist" },
      });
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as {
        error?: { code?: string; message?: string };
      };
      expect(structured.error?.code).toBe("not_found");
      expect(structured.error?.message).not.toContain("at ");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
