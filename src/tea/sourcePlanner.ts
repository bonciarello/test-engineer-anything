import { parse } from "@babel/parser";
import type {
  ArrowFunctionExpression,
  ClassDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  FunctionDeclaration,
  Node,
  Statement,
  TSModuleDeclaration,
  VariableDeclaration,
} from "@babel/types";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { canonicalDirectory, walkRepository } from "./analyze.js";
import { SOURCE_TEST_LIMITS, TEA_LIMITS } from "./limits.js";
import { createSourceMutations } from "./sourceMutations.js";
import {
  finalizeValue,
  generateCases,
  interpret,
  isSideEffectFree,
  validateExpression,
  validateFunction,
  type CandidateFunction,
  type InterpValue,
  type ValidatedFunction,
} from "./sourceInterpreter.js";
import type {
  ExcludedSourceExport,
  PlanSourceInput,
  SourceMutation,
  SourcePrimitiveValue,
  SourceTestCase,
  SourceTestPlan,
} from "./types.js";

interface CandidateExport {
  readonly name: string;
  readonly node: CandidateFunction;
  readonly idLoc: { readonly line: number; readonly column: number };
}

/**
 * Plan unit/regression tests from pure exported TypeScript functions. Parses
 * `.ts` sources with @babel/parser and interprets a bounded pure-expression
 * subset with a dedicated recursive interpreter — never `eval` or module
 * execution. Expected values are precomputed during planning.
 */
export const planSourceTests = async (
  input: PlanSourceInput,
): Promise<SourceTestPlan> => {
  const root = await canonicalDirectory(input.repoDir);
  const traversal = await walkRepository(root);
  const limitations: string[] = [];
  if (traversal.truncated)
    limitations.push(
      `repository traversal stopped after ${TEA_LIMITS.maxTraversedFiles} files`,
    );

  const tsFiles = traversal.sourceFiles
    .filter((file) => extname(file).toLowerCase() === ".ts")
    .sort();
  const considered = tsFiles.slice(0, SOURCE_TEST_LIMITS.maxSourceFiles);
  if (tsFiles.length > considered.length)
    limitations.push(
      `only the first ${SOURCE_TEST_LIMITS.maxSourceFiles} .ts source files were analyzed`,
    );

  const planner = new SourcePlanner(root, limitations);
  for (const file of considered) await planner.analyzeFile(file);
  return planner.finish(considered);
};

class SourcePlanner {
  private readonly cases: SourceTestCase[] = [];
  private readonly excluded: ExcludedSourceExport[] = [];
  private readonly mutations: SourceMutation[] = [];
  private readonly usedIds = new Map<string, number>();
  private functionCount = 0;

  constructor(
    private readonly repoDir: string,
    private readonly limitations: string[],
  ) {}

  finish(sourceFiles: readonly string[]): SourceTestPlan {
    return {
      repoDir: this.repoDir,
      sourceFiles,
      cases: this.cases,
      excluded: this.excluded,
      limitations: this.limitations,
      mutations: this.mutations,
    };
  }

  async analyzeFile(filePath: string): Promise<void> {
    let info;
    try {
      info = await stat(filePath);
    } catch (cause) {
      if (isMissing(cause)) return;
      throw cause;
    }
    if (info.size > SOURCE_TEST_LIMITS.maxSourceBytes) {
      this.limitations.push(
        `skipped ${filePath}: size ${info.size} bytes exceeds ${SOURCE_TEST_LIMITS.maxSourceBytes}`,
      );
      this.excluded.push(
        this.exclusion(
          filePath,
          null,
          { line: 0, column: 0 },
          `source file exceeds ${SOURCE_TEST_LIMITS.maxSourceBytes} bytes`,
        ),
      );
      return;
    }

    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (cause) {
      if (isMissing(cause)) return;
      throw cause;
    }

    let ast;
    try {
      ast = parse(text, { sourceType: "module", plugins: ["typescript"] });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.limitations.push(`skipped ${filePath}: parse error (${message})`);
      this.excluded.push(
        this.exclusion(
          filePath,
          null,
          { line: 0, column: 0 },
          `parse error: ${message}`,
        ),
      );
      return;
    }

    const { impurity, candidates, exclusions } = this.classifyStatements(
      ast.program.body,
      filePath,
    );
    this.excluded.push(...exclusions);
    if (impurity !== null) {
      this.excluded.push(
        this.exclusion(filePath, null, { line: 0, column: 0 }, impurity),
      );
      for (const candidate of candidates)
        this.excluded.push(
          this.exclusion(filePath, candidate.name, candidate.idLoc, impurity),
        );
      this.limitations.push(`skipped ${filePath}: ${impurity}`);
      return;
    }

    for (const candidate of candidates) {
      if (this.functionCount >= SOURCE_TEST_LIMITS.maxSourceFunctions) {
        this.limitations.push(
          `source-test function limit of ${SOURCE_TEST_LIMITS.maxSourceFunctions} reached`,
        );
        this.excluded.push(
          this.exclusion(
            filePath,
            candidate.name,
            candidate.idLoc,
            "function limit reached",
          ),
        );
        continue;
      }
      this.functionCount += 1;
      this.planFunction(filePath, candidate, text);
    }
  }

  private classifyStatements(
    body: readonly Statement[],
    filePath: string,
  ): {
    readonly impurity: string | null;
    readonly candidates: CandidateExport[];
    readonly exclusions: ExcludedSourceExport[];
  } {
    const candidates: CandidateExport[] = [];
    const exclusions: ExcludedSourceExport[] = [];
    let impurity: string | null = null;

    const visit = (statement: Statement, exported: boolean): void => {
      if (impurity !== null) return;
      switch (statement.type) {
        case "ImportDeclaration":
          impurity = "module imports other modules";
          return;
        case "ExportAllDeclaration":
          impurity = "module re-exports other modules";
          return;
        case "ExportNamedDeclaration": {
          const decl = statement as ExportNamedDeclaration;
          if (decl.source != null) {
            impurity = "module re-exports other modules";
            return;
          }
          if (decl.declaration == null) return;
          visit(decl.declaration, true);
          return;
        }
        case "ExportDefaultDeclaration": {
          const decl = statement as ExportDefaultDeclaration;
          const declaration = decl.declaration;
          if (
            declaration.type === "FunctionDeclaration" ||
            declaration.type === "ClassDeclaration"
          ) {
            exclusions.push(
              this.exclusion(
                filePath,
                null,
                locationOf(declaration),
                "default exports are not supported",
              ),
            );
            return;
          }
          impurity = "top-level default export expression";
          return;
        }
        case "TSImportEqualsDeclaration":
          impurity = "module imports other modules";
          return;
        case "TSExportAssignment":
          impurity =
            "CommonJS export assignment is not erasable by Node type stripping";
          return;
        case "TSEnumDeclaration":
          impurity = "TypeScript enum is not erasable by Node type stripping";
          return;
        case "TSModuleDeclaration": {
          const decl = statement as TSModuleDeclaration;
          if (!decl.declare)
            impurity =
              "TypeScript namespace is not erasable by Node type stripping";
          return;
        }
        case "ExpressionStatement":
          impurity = "top-level expression statement";
          return;
        case "FunctionDeclaration": {
          const fn = statement as FunctionDeclaration;
          if (exported) {
            const name = fn.id?.name;
            if (name === undefined) {
              impurity = "anonymous exported function";
              return;
            }
            candidates.push({ name, node: fn, idLoc: locationOf(fn.id) });
          }
          return;
        }
        case "ClassDeclaration": {
          if (exported) {
            const cls = statement as ClassDeclaration;
            exclusions.push(
              this.exclusion(
                filePath,
                cls.id?.name ?? null,
                locationOf(cls.id),
                "class exports are not supported",
              ),
            );
          }
          return;
        }
        case "VariableDeclaration": {
          const decl = statement as VariableDeclaration;
          for (const declarator of decl.declarations) {
            const id = declarator.id;
            if (id.type !== "Identifier") {
              impurity = `top-level ${id.type} binding`;
              return;
            }
            const init = declarator.init;
            if (init == null) continue;
            if (init.type === "ArrowFunctionExpression") {
              if (exported)
                candidates.push({
                  name: id.name,
                  node: init as ArrowFunctionExpression,
                  idLoc: locationOf(id),
                });
            } else if (init.type === "FunctionExpression") {
              if (exported)
                exclusions.push(
                  this.exclusion(
                    filePath,
                    id.name,
                    locationOf(id),
                    "function expression exports are not supported",
                  ),
                );
            } else if (!isSideEffectFree(init)) {
              impurity = "top-level variable initializer has side effects";
              return;
            }
          }
          return;
        }
        case "TSInterfaceDeclaration":
        case "TSTypeAliasDeclaration":
        case "TSDeclareFunction":
        case "EmptyStatement":
          return;
        default:
          impurity = `unsupported top-level statement ${statement.type}`;
          return;
      }
    };

    for (const statement of body) visit(statement, false);
    return { impurity, candidates, exclusions };
  }

  private planFunction(
    filePath: string,
    candidate: CandidateExport,
    sourceText: string,
  ): void {
    const validated = validateFunction(candidate.node);
    if (!validated.ok) {
      this.excluded.push(
        this.exclusion(
          filePath,
          candidate.name,
          candidate.idLoc,
          validated.reason,
        ),
      );
      return;
    }
    const fn = validated.value;
    const paramNames = new Set(fn.params.map((param) => param.name));
    const structural = validateExpression(fn.body, paramNames, {
      steps: SOURCE_TEST_LIMITS.maxInterpreterSteps,
    });
    if (structural !== null) {
      this.excluded.push(
        this.exclusion(filePath, candidate.name, candidate.idLoc, structural),
      );
      return;
    }

    const planned: SourceTestCase[] = [];
    const skipped: string[] = [];
    for (const args of generateCases(fn.params.map((param) => param.type))) {
      const env = new Map<string, InterpValue>();
      fn.params.forEach((param, index) => {
        const value = args[index];
        if (value !== undefined) env.set(param.name, value);
      });
      const result = interpret(fn.body, env, {
        steps: SOURCE_TEST_LIMITS.maxInterpreterSteps,
      });
      if (!result.ok) {
        skipped.push(`args ${JSON.stringify(args)}: ${result.reason}`);
        continue;
      }
      const finalized = finalizeValue(result.value, fn.returnType);
      if (!finalized.ok) {
        skipped.push(`args ${JSON.stringify(args)}: ${finalized.reason}`);
        continue;
      }
      planned.push(
        this.makeCase(filePath, candidate, fn, args, finalized.value),
      );
    }
    for (const skip of skipped)
      this.limitations.push(
        `${filePath}:${candidate.name} excluded case ${skip}`,
      );
    if (planned.length === 0) {
      this.excluded.push(
        this.exclusion(
          filePath,
          candidate.name,
          candidate.idLoc,
          "no executable cases could be derived",
        ),
      );
      return;
    }
    this.cases.push(...planned);
    const mutations = createSourceMutations(
      sourceText,
      filePath,
      candidate.name,
      fn.body,
    );
    const remaining = Math.max(
      0,
      SOURCE_TEST_LIMITS.maxSourceMutations - this.mutations.length,
    );
    this.mutations.push(...mutations.slice(0, remaining));
    if (mutations.length > remaining)
      this.limitations.push(
        `source mutation limit of ${SOURCE_TEST_LIMITS.maxSourceMutations} reached`,
      );
  }

  private makeCase(
    filePath: string,
    candidate: CandidateExport,
    fn: ValidatedFunction,
    args: readonly SourcePrimitiveValue[],
    expected: SourcePrimitiveValue,
  ): SourceTestCase {
    return {
      id: this.uniqueId(candidate.name),
      sourcePath: filePath,
      exportName: candidate.name,
      description: `${candidate.name}(${args.map(formatArg).join(", ")})`,
      args,
      expected,
      evidence: {
        sourcePath: filePath,
        exportName: candidate.name,
        line: candidate.idLoc.line,
        column: candidate.idLoc.column,
        confidence: "derived",
        authority: "shipped-artifact",
        limitations: [
          `the expected value for ${fn.returnType} is derived from the current source expression and demonstrates regressions, not functional intent`,
        ],
      },
    };
  }

  private uniqueId(exportName: string): string {
    const base = `source_${exportName.replace(/[^A-Za-z0-9_]/gu, "_")}`;
    const count = this.usedIds.get(base) ?? 0;
    this.usedIds.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  }

  private exclusion(
    sourcePath: string,
    exportName: string | null,
    loc: { readonly line: number; readonly column: number },
    reason: string,
  ): ExcludedSourceExport {
    return {
      sourcePath,
      exportName,
      line: loc.line,
      column: loc.column,
      reason,
    };
  }
}

const locationOf = (
  node: Node | null | undefined,
): { line: number; column: number } => {
  const start = node?.loc?.start;
  if (start === null || start === undefined) return { line: 0, column: 0 };
  return { line: start.line, column: start.column };
};

const formatArg = (value: SourcePrimitiveValue): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";
