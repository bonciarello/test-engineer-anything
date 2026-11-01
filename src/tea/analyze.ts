import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { asString, isJsonObject } from "./json.js";
import {
  EXCLUDED_DIRECTORIES,
  SOURCE_EXTENSIONS,
  SPEC_EXTENSIONS,
  TEA_LIMITS,
} from "./limits.js";
import { countOperations, parseSpecDocument } from "./specs.js";
import type { AnalyzeProductResult, AnalyzedSpec } from "./types.js";
import { TeaError } from "./types.js";

export interface TraversalAccumulator {
  readonly sourceFiles: string[];
  readonly specCandidates: string[];
  readonly visited: number;
  readonly truncated: boolean;
}

/**
 * Analyze a Node/TypeScript repository: read its package.json safely, build a
 * bounded source-file inventory, and discover OpenAPI 3 specs. Never follows
 * symlinks and never descends into .git/node_modules/dist/build/coverage.
 */
export const analyzeProduct = async (
  repoDir: string,
): Promise<AnalyzeProductResult> => {
  const root = await canonicalDirectory(repoDir);
  const [product, traversal] = await Promise.all([
    readProductMetadata(root),
    walkRepository(root),
  ]);

  const specs: AnalyzedSpec[] = [];
  const limitations: string[] = [];
  if (traversal.truncated)
    limitations.push(
      `repository traversal stopped after ${TEA_LIMITS.maxTraversedFiles} files`,
    );

  for (const candidate of traversal.specCandidates.slice(
    0,
    TEA_LIMITS.maxSpecCandidates,
  )) {
    try {
      const info = await stat(candidate);
      if (info.size > TEA_LIMITS.maxSpecBytes) {
        limitations.push(
          `skipped spec ${candidate}: size ${info.size} bytes exceeds ${TEA_LIMITS.maxSpecBytes}`,
        );
        continue;
      }
    } catch (cause) {
      if (isMissing(cause)) continue;
      throw cause;
    }
    const parsed = parseSpecDocument(await readFile(candidate, "utf8"));
    if (parsed.kind === "openapi3") {
      specs.push({
        path: candidate,
        format: parsed.format,
        openapiVersion: parsed.version,
        title: parsed.title,
        operationCounts: countOperations(parsed.document),
      });
    } else if (parsed.kind === "swagger2") {
      limitations.push(
        `skipped ${candidate}: OpenAPI 2.0 (swagger) is not supported`,
      );
    }
  }
  if (traversal.specCandidates.length > TEA_LIMITS.maxSpecCandidates)
    limitations.push(
      `only the first ${TEA_LIMITS.maxSpecCandidates} spec candidates were analyzed`,
    );

  return {
    repoDir: root,
    product,
    inventory: {
      sourceFiles: traversal.sourceFiles,
      truncated: traversal.truncated,
    },
    specs,
    limitations,
  };
};

/** Resolve a caller-provided repository path to a real directory. */
export const canonicalDirectory = async (repoDir: string): Promise<string> => {
  if (typeof repoDir !== "string" || repoDir.trim() === "")
    throw new TeaError("invalid_input", "repoDir must be a non-empty path");
  let real: string;
  try {
    real = await realpath(resolve(repoDir));
  } catch (cause) {
    if (isMissing(cause))
      throw new TeaError("not_found", `repository does not exist: ${repoDir}`);
    throw new TeaError(
      "invalid_input",
      `cannot resolve repository: ${repoDir}`,
    );
  }
  const info = await lstat(real);
  if (!info.isDirectory())
    throw new TeaError(
      "invalid_input",
      `repository is not a directory: ${repoDir}`,
    );
  return real;
};

/** Read package.json without ever throwing on malformed or missing content. */
const readProductMetadata = async (
  root: string,
): Promise<AnalyzeProductResult["product"]> => {
  const packageJsonPath = join(root, "package.json");
  let text: string;
  try {
    text = await readFile(packageJsonPath, "utf8");
  } catch (cause) {
    if (isMissing(cause))
      return {
        name: null,
        version: null,
        packageJsonPath: null,
        packageJsonError: null,
      };
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    return {
      name: null,
      version: null,
      packageJsonPath,
      packageJsonError:
        cause instanceof Error ? cause.message : "invalid package.json",
    };
  }
  if (!isJsonObject(parsed))
    return {
      name: null,
      version: null,
      packageJsonPath,
      packageJsonError: "package.json is not an object",
    };
  return {
    name: asString(parsed.name),
    version: asString(parsed.version),
    packageJsonPath,
    packageJsonError: null,
  };
};

/** Bounded, symlink-safe directory walk collecting source files and spec candidates. */
export const walkRepository = async (
  root: string,
): Promise<TraversalAccumulator> => {
  const sourceFiles: string[] = [];
  const specCandidates: string[] = [];
  let visited = 0;
  let truncated = false;
  const pending: string[] = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abort the whole walk
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      visited += 1;
      if (visited > TEA_LIMITS.maxTraversedFiles) {
        truncated = true;
        break;
      }
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink())
        continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (
          SOURCE_EXTENSIONS.has(extension) &&
          sourceFiles.length < TEA_LIMITS.maxInventoryFiles
        )
          sourceFiles.push(fullPath);
        if (SPEC_EXTENSIONS.has(extension)) specCandidates.push(fullPath);
      }
    }
    if (truncated) break;
  }
  return { sourceFiles, specCandidates, visited, truncated };
};

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";
