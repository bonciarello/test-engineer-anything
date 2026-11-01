import type {
  BinaryExpression,
  Expression,
  LogicalExpression,
  Node,
} from "@babel/types";

import { SOURCE_TEST_LIMITS } from "./limits.js";
import type { SourceMutation } from "./types.js";

const REPLACEMENTS: Readonly<Record<string, string>> = {
  "+": "-",
  "-": "+",
  "*": "/",
  "/": "*",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
  "===": "!==",
  "!==": "===",
  "&&": "||",
  "||": "&&",
};

/** Derive bounded, non-overlapping operator edits from a validated expression. */
export const createSourceMutations = (
  sourceText: string,
  sourcePath: string,
  exportName: string,
  expression: Expression,
): readonly SourceMutation[] => {
  const mutations: SourceMutation[] = [];
  const visit = (node: Node): void => {
    if (mutations.length >= SOURCE_TEST_LIMITS.maxMutationsPerFunction) return;
    switch (node.type) {
      case "BinaryExpression":
      case "LogicalExpression": {
        addOperatorMutation(
          sourceText,
          sourcePath,
          exportName,
          node,
          mutations,
        );
        visit(node.left);
        visit(node.right);
        return;
      }
      case "ParenthesizedExpression":
        visit(node.expression);
        return;
      case "UnaryExpression":
        visit(node.argument);
        return;
      case "ConditionalExpression":
        visit(node.test);
        visit(node.consequent);
        visit(node.alternate);
        return;
      case "TemplateLiteral":
        node.expressions.forEach(visit);
        return;
      default:
        return;
    }
  };
  visit(expression);
  return mutations;
};

const addOperatorMutation = (
  sourceText: string,
  sourcePath: string,
  exportName: string,
  node: BinaryExpression | LogicalExpression,
  mutations: SourceMutation[],
): void => {
  const replacement = REPLACEMENTS[node.operator];
  if (
    replacement === undefined ||
    mutations.length >= SOURCE_TEST_LIMITS.maxMutationsPerFunction
  )
    return;
  const leftEnd = node.left.end;
  const rightStart = node.right.start;
  if (
    leftEnd === null ||
    leftEnd === undefined ||
    rightStart === null ||
    rightStart === undefined
  )
    return;
  const between = sourceText.slice(leftEnd, rightStart);
  const offset = between.indexOf(node.operator);
  if (offset < 0) return;
  const start = leftEnd + offset;
  const end = start + node.operator.length;
  const original = sourceText.slice(start, end);
  if (original !== node.operator) return;
  mutations.push({
    id: `${exportName}:operator:${start}`,
    sourcePath,
    exportName,
    kind: "operator",
    start,
    end,
    original,
    replacement,
  });
};
