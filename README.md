# Test Engineer Anything

**Analyze a product. Preserve the evidence. Generate executable tests.**

TEA is a downstream fork of [REA](https://github.com/morluto/rea), repurposed for test engineering. It analyzes Node.js/TypeScript repositories and OpenAPI 3 specifications, plans non-mutating HTTP contract tests and source-derived regression tests, generates standalone suites, and executes them against the selected product or modules.

> **Status: 0.4.0 MVP.** The implemented workflows are deterministic and do not require an LLM. Browser exploration and AI-assisted scenario synthesis are roadmap items, not features claimed by this release.

## What works today

- Bounded repository inventory and OpenAPI 3 JSON/YAML discovery.
- Test plans with source evidence, limitations, and explicit exclusions.
- Contract tests for documented **GET** and **HEAD** operations only.
- Documented status, JSON content-type, and response-schema assertions.
- Source-derived regression tests for pure, annotated TypeScript functions.
- Expected values precomputed by a bounded AST interpreter, never by executing the target during analysis or generation.
- Standalone generated tests using `node:test`; the target project needs no extra test dependency.
- Safe output handling, bounded verification, CLI, and seven MCP tools.
- Stability checks with randomized test order and deterministic seeds.
- Mutation testing on copied sources, with killed/survived/invalid outcomes and a configurable quality threshold.
- Native Node coverage for generated suites and optional deltas against an existing suite.
- SHA-256 manifests and digest admission for generated tests and plans.
- Temporary working directories and allowlisted child-process environments without ambient credential inheritance.
- No HTTP requests during analysis, planning, or generation.

## Requirements

- Node.js `24.22.1` for development and generated TypeScript imports (see `.nvmrc`).
- An OpenAPI 3 specification for HTTP contract tests.
- Pure exported `.ts` functions with primitive annotations for source-derived tests.
- A running HTTP product only for contract-test verification.

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

### 2. Produce an HTTP contract-test plan

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product"}' \
  | node scripts/tea.mjs plan-tests
```

Every planned case points to its OpenAPI operation. Mutating methods and operations without a usable documented success response are excluded with a reason.

### 3. Generate HTTP contract tests

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product","outputDir":"/absolute/path/to/generated-tests"}' \
  | node scripts/tea.mjs generate-tests
```

TEA writes:

- `tea-contract-tests.mjs` — executable tests;
- `tea-plan.json` — the evidence-backed plan;
- `tea-contract-tests.mjs.manifest.json` — SHA-256 identity for both artifacts.

Existing files are not replaced unless `"overwrite": true` is explicitly supplied. Analysis and generation do not contact the product.

### 4. Verify contract tests against a running product

```bash
printf '%s' '{"testFile":"/absolute/path/to/generated-tests/tea-contract-tests.mjs","baseUrl":"http://127.0.0.1:3000","timeoutMs":30000}' \
  | node scripts/tea.mjs verify-tests
```

Verification requires the sidecar manifest and matching test/plan digests; regenerate pre-0.4 artifacts. Tests run in a temporary working directory with an allowlisted environment, but still execute JavaScript with the current user's filesystem and network permissions. Use a controlled product instance: TEA is not a sandbox.

### 5. Generate source-derived regression tests

Plan cases from pure exported TypeScript functions:

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product"}' \
  | node scripts/tea.mjs plan-source-tests
```

Generate `tea-source-tests.mjs`, `tea-source-plan.json`, and `tea-source-tests.mjs.manifest.json`:

```bash
printf '%s' '{"repoDir":"/absolute/path/to/product","outputDir":"/absolute/path/to/generated-source-tests"}' \
  | node scripts/tea.mjs generate-source-tests
```

Run them without a base URL:

```bash
printf '%s' '{"testFile":"/absolute/path/to/generated-source-tests/tea-source-tests.mjs"}' \
  | node scripts/tea.mjs verify-tests
```

The current analyzer supports named function declarations and arrow functions with required `number`, `string`, or `boolean` parameters and a single pure return expression. Unsupported functions are excluded with a reason rather than guessed.

### 6. Evaluate source-test quality

```bash
printf '%s' '{"testFile":"/absolute/path/to/generated-source-tests/tea-source-tests.mjs","repetitions":3,"minimumMutationScore":0.8}' \
  | node scripts/tea.mjs evaluate-source-tests
```

The report contains baseline stability, mutation score and individual outcomes, plus line/branch/function coverage. TEA validates both the manifest digests and exact test/plan correspondence, then applies deterministic operator mutations only to temporary source copies. Original sources are never edited by the quality runner.

Mutation score is `killed / (killed + survived)`; invalid and timed-out mutations are reported separately and fail the gate. To compare coverage with an existing suite, provide `"baselineTestFile":"/absolute/path/to/existing-tests.mjs"`. Without it, the delta is explicitly `null`, not an assumed improvement from zero.

## Included example

The `examples/openapi-service` directory contains a dependency-free HTTP product, an OpenAPI specification, and pure TypeScript functions.

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

printf '%s' '{"repoDir":"examples/openapi-service","outputDir":".tea/source-example","overwrite":true}' \
  | node scripts/tea.mjs generate-source-tests

printf '%s' '{"testFile":".tea/source-example/tea-source-tests.mjs"}' \
  | node scripts/tea.mjs verify-tests

printf '%s' '{"testFile":".tea/source-example/tea-source-tests.mjs","minimumMutationScore":1}' \
  | node scripts/tea.mjs evaluate-source-tests
```

The complete example is also checked with `npm run verify:tea`.

## MCP

Run the local stdio server:

```bash
node /absolute/path/to/test-engineer-anything/scripts/tea.mjs mcp
```

It exposes:

| Tool                    | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `analyze_product`       | Inspect repository metadata and discover OpenAPI specifications |
| `plan_tests`            | Produce HTTP cases, evidence, exclusions, and limitations       |
| `generate_tests`        | Write the standalone HTTP suite and machine-readable plan       |
| `plan_source_tests`     | Derive regression cases from pure TypeScript exports            |
| `generate_source_tests` | Write source-derived tests and their evidence-backed plan       |
| `evaluate_source_tests` | Measure stability, mutation sensitivity, and coverage/delta     |
| `verify_tests`          | Execute a generated suite, with an optional HTTP base URL       |

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

TEA distinguishes documented behavior, source-derived expectations, and guesses:

- HTTP cases use `confidence: "observed"`, a specification path, and a JSON pointer.
- Source cases use `confidence: "derived"`, an export name, and a source location.
- Both use `authority: "shipped-artifact"` and explicit limitations.

A documented response is a contract, not proof of complete correctness. Likewise, a source-derived expected value demonstrates regression sensitivity, not that the current expression matches the intended business rule.

Unsupported OpenAPI schema features produce an explicit limitation and a weaker status/content-type assertion. Unsupported TypeScript constructs are excluded. Neither workflow silently invents an oracle.

The quality report adds empirical evidence: repeated runs assess stability, mutation results show whether source changes are detected, and coverage is measured by Node. These signals still do not prove functional correctness; equivalent or untested mutants and missing oracles remain explicit limits.

## Architecture

```text
scripts/tea.mjs
  ├── src/teaCli.ts ───────┐
  └── src/teaMcp.ts ───────┤
                           ▼
                      src/tea/
       analyze → plan → generate → verify
                         │
          OpenAPI planner + TypeScript source planner
          schema validator + bounded AST interpreter
          manifest admission + bounded test runner
```

The new TEA workflow is isolated from REA's MCP catalog. The fork temporarily retains inherited infrastructure and source while product-specific functionality is migrated incrementally.

## Development checks

```bash
npm run typecheck
npm run test:local -- src/teaCore.test.ts src/teaMcp.test.ts src/teaSource.test.ts src/teaQuality.test.ts src/teaArtifact.test.ts
npm run build:cached
npm run verify:tea
```

The tests use temporary repositories and local HTTP servers; they do not require external services. Only `.github/workflows/tea-ci.yml` is active; inherited REA workflows are preserved under `.github/upstream-workflows/` without being executed by GitHub Actions.

## Current limits

- OpenAPI 3.x only; Swagger/OpenAPI 2 is not implemented.
- Only GET and HEAD HTTP operations are planned.
- Required path/query parameters use examples, defaults, enums, or deterministic placeholders; generated values may still be unknown to the product.
- Header/cookie authentication and external `$ref` documents are not exercised.
- Response validation supports a declared JSON Schema subset and fails closed to weaker assertions for unsupported features.
- Source analysis supports a deliberately small expression subset, named exports, primitive annotations, and side-effect-free `.ts` modules; classes, async functions, imports, calls, closures, `.tsx`, and non-erasable TypeScript are excluded.
- Deterministic source inputs use bounded one-factor-at-a-time variation, not exhaustive or property-based generation.
- Generated source tests rely on Node's TypeScript type stripping.
- Mutation candidates currently cover a bounded set of operator replacements; they do not represent every possible fault and some may be equivalent.
- Stability checks repeat tests with randomized order, but cannot detect every time-, network-, or environment-dependent flake.
- Coverage deltas require a caller-supplied baseline suite and use Node's built-in V8 coverage.
- Verification executes JavaScript with caller authority; temporary cwd and environment filtering reduce ambient exposure but do not isolate filesystem or network access.
- Manifest digests detect accidental or incomplete artifact changes; they are not signatures and do not establish publisher authenticity against a malicious author who can replace all artifacts.

## Roadmap

1. Broader source-derived integration and property-based tests with independent oracles.
2. OpenAPI authentication, setup/teardown, and explicitly authorized state-changing workflows.
3. Browser observation and Playwright E2E generation.
4. Optional container-backed execution for stronger isolation.
5. AI-assisted risk analysis and scenario synthesis with independent oracles.
6. TEA-only build and progressive removal of unused REA infrastructure.

## Upstream and license

TEA is a GitHub fork of [`morluto/rea`](https://github.com/morluto/rea). The upstream project and its contributors retain their copyright and license notices. Inherited third-party material remains subject to `THIRD_PARTY_NOTICES.md` and the `licenses/` inventory.

The project is distributed under the [MIT License](LICENSE). It is not an official REA release.
