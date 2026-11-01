# Changelog

## 0.4.0

### Features

- Add SHA-256 sidecar manifests for contract and source test artifacts.
- Require matching test and plan digests before public verification.
- Reject missing or malformed manifests, symlinked artifacts, and oversized inputs.
- Execute tests in a fresh temporary working directory with bounded cleanup.
- Replace ambient environment inheritance with a small platform allowlist; forward `TEA_BASE_URL` only as an explicit caller input.
- Report forwarded and explicit environment variable names without exposing their values.

### Validation

- Cover artifact tampering, missing and symlinked manifests, ambient-secret filtering, and temporary working-directory execution.

## 0.3.0

### Features

- Add source-test quality evaluation through `evaluate-source-tests` and `evaluate_source_tests`.
- Measure baseline stability with bounded repetitions, randomized test order, and deterministic seeds.
- Generate deterministic operator mutations and execute them only against temporary source copies.
- Report killed, survived, timed-out, and invalid mutants with a configurable mutation-score threshold.
- Measure line, branch, and function coverage with Node's native test coverage and compute deltas against an optional baseline suite.
- Verify exact test/plan artifact correspondence before quality evaluation.

### Validation

- Cover surviving mutants, stale mutation offsets, artifact tampering, absent baselines, coverage deltas, and preservation of original sources.
- Require a 100% mutation score in the bundled end-to-end example.

## 0.2.0

### Features

- Plan and generate source-derived regression tests for pure, annotated TypeScript functions.
- Precompute expected primitive values with a bounded AST interpreter; never execute target modules during analysis or generation.
- Add `plan-source-tests` and `generate-source-tests` to the CLI, plus `plan_source_tests` and `generate_source_tests` through MCP.
- Allow verification of source tests without a base URL while preserving OpenAPI contract verification.
- Add source-generation example coverage to the end-to-end CI workflow.

### Fixes

- Bound individual TypeScript source-file reads and match JavaScript relational semantics for unordered numeric operands.
- Canonicalize generated output roots so relative TypeScript imports remain valid below symlinked parent directories.
- Split source planning, interpretation, and rendering into cohesive modules.

## 0.1.0

### Features

- Introduce Test Engineer Anything as a downstream fork of REA.
- Add bounded Node.js/TypeScript repository and OpenAPI 3 discovery.
- Add evidence-backed GET/HEAD contract-test planning with explicit exclusions.
- Generate standalone `node:test` suites with status, content-type, and JSON Schema assertions.
- Add bounded test verification, four MCP tools, and the `tea`/`tea-agents` CLI entrypoints.
- Add an executable OpenAPI example and focused TEA CI.

The inherited REA changelog remains available in the Git history before the TEA 0.1.0 transformation.
