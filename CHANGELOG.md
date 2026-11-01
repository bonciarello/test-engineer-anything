# Changelog

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
