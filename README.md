# Test Engineer Anything

**Analyze a product. Preserve the evidence. Generate executable tests.**

TEA is a downstream fork of [REA](https://github.com/morluto/rea), repurposed for test engineering. The first vertical slice analyzes Node.js/TypeScript repositories and OpenAPI 3 specifications, plans non-mutating HTTP contract tests, generates a standalone test suite, and executes it against a running product.

> **Status: 0.1.0 MVP.** The implemented workflow is deterministic and does not require an LLM. Source-level unit-test generation, browser exploration, and AI-assisted scenario synthesis are roadmap items, not features claimed by this release.

## What works today

- Bounded repository inventory and OpenAPI 3 JSON/YAML discovery.
- A test plan with source evidence, limitations, and explicit exclusions.
- Contract tests for documented **GET** and **HEAD** operations only.
- Documented status, JSON content-type, and response-schema assertions.
- Standalone generated tests using `node:test` and `fetch`; the target project needs no extra test dependency.
- Safe output handling, bounded verification, CLI, and four MCP tools.
- No HTTP requests during analysis, planning, or generation.

## Requirements

- Node.js `24.22.1` for development (see `.nvmrc`).
- An OpenAPI 3 specification in the target repository.
- A running HTTP product only for the verification step.

## Build and run from this checkout

```bash
npm ci
npm run build:cached
node scripts/tea.mjs --help
```

Each CLI command accepts one JSON document through stdin or `--input <file>`.

### 1. Analyze a product

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product"}' \
  | node scripts/tea.mjs analyze-product
```

The result contains package metadata, a bounded source inventory, discovered specifications, and analysis limitations.

### 2. Produce a test plan

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product"}' \
  | node scripts/tea.mjs plan-tests
```

Every planned case points to its OpenAPI operation. Mutating methods and operations without a usable documented success response are excluded with a reason.

### 3. Generate tests

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product","outputDir":"/absolute/path/to/generated-tests"}' \
  | node scripts/tea.mjs generate-tests
```

TEA writes:

- `tea-contract-tests.mjs` — executable tests;
- `tea-plan.json` — the evidence-backed plan.

Existing files are not replaced unless `"overwrite": true` is explicitly supplied. Analysis and generation do not contact the product.

### 4. Verify against a running product

```bash
printf '%s' '{"testFile":"/absolute/path/to/generated-tests/tea-contract-tests.mjs","baseUrl":"http://127.0.0.1:3000","timeoutMs":30000}' \
  | node scripts/tea.mjs verify-tests
```

Verification runs the selected JavaScript test file with the current user's permissions. Use a controlled product instance. TEA is not a sandbox.

## Included example

The `examples/openapi-service` directory contains a dependency-free product and specification.

Terminal 1:

```bash
node examples/openapi-service/server.mjs
```

Terminal 2:

```bash
printf '%s' '{"repoDir":"examples/openapi-service","outputDir":".tea/example","overwrite":true}' \
  | node scripts/tea.mjs generate-tests

printf '%s' '{"testFile":".tea/example/tea-contract-tests.mjs","baseUrl":"http://127.0.0.1:3000"}' \
  | node scripts/tea.mjs verify-tests
```

## MCP

Run the local stdio server:

```bash
node /absolute/path/to/test-engineer-anything/scripts/tea.mjs mcp
```

It exposes:

| Tool              | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `analyze_product` | Inspect repository metadata and discover OpenAPI specifications |
| `plan_tests`      | Produce cases, evidence, exclusions, and limitations            |
| `generate_tests`  | Write the standalone suite and machine-readable plan            |
| `verify_tests`    | Execute the suite against a caller-selected HTTP base URL       |

Example local client configuration:

```json
{
  "mcpServers": {
    "tea": {
      "command": "node",
      "args": [
        "/absolute/path/to/test-engineer-anything/scripts/tea.mjs",
        "mcp"
      ]
    }
  }
}
```

## Evidence and correctness

TEA distinguishes documented behavior from guesses. Planned assertions currently use `confidence: "observed"` and `authority: "shipped-artifact"`, with a specification path and JSON pointer.

A documented response is a contract, not proof that every untested behavior is correct. Unsupported schema features produce an explicit limitation and a weaker status/content-type assertion rather than a misleading validator. The current suite is a **contract regression suite**, not a complete correctness proof.

## Architecture

```text
scripts/tea.mjs
  ├── src/teaCli.ts ───────┐
  └── src/teaMcp.ts ───────┤
                           ▼
                      src/tea/
          analyze → plan → generate → verify
```

The new TEA workflow is isolated from REA's MCP catalog. The fork temporarily retains inherited infrastructure and source while product-specific functionality is migrated incrementally.

## Development checks

```bash
npm run typecheck
npm run test:local -- src/teaCore.test.ts src/teaMcp.test.ts
npm run build:cached
npm run verify:tea
```

The tests use temporary repositories and local HTTP servers; they do not require external services. Only `.github/workflows/tea-ci.yml` is active; inherited REA workflows are preserved under `.github/upstream-workflows/` without being executed by GitHub Actions.

## Current limits

- OpenAPI 3.x only; Swagger/OpenAPI 2 is not implemented.
- Only GET and HEAD operations are planned.
- Required path/query parameters use examples, defaults, enums, or deterministic placeholders; generated values may still be unknown to the product.
- Header/cookie authentication and external `$ref` documents are not exercised.
- Response validation supports a declared JSON Schema subset and fails closed to weaker assertions for unsupported features.
- Verification executes JavaScript with caller authority; review generated artifacts and use controlled environments.

## Roadmap

1. Source-derived unit and integration tests for TypeScript domain code.
2. OpenAPI authentication, setup/teardown, and explicitly authorized state-changing workflows.
3. Browser observation and Playwright E2E generation.
4. Flakiness detection, coverage deltas, and mutation-based validation of generated tests.
5. AI-assisted risk analysis and scenario synthesis with independent oracles.

## Upstream and license

TEA is a GitHub fork of [`morluto/rea`](https://github.com/morluto/rea). The upstream project and its contributors retain their copyright and license notices. Inherited third-party material remains subject to `THIRD_PARTY_NOTICES.md` and the `licenses/` inventory.

The project is distributed under the [MIT License](LICENSE). It is not an official REA release.
