import type {
  ArrowFunctionExpression,
  BinaryExpression,
  BooleanLiteral,
  ConditionalExpression,
  Expression,
  FunctionDeclaration,
  Identifier,
  LogicalExpression,
  Node,
  NumericLiteral,
  ParenthesizedExpression,
  ReturnStatement,
  StringLiteral,
  TemplateLiteral,
  UnaryExpression,
} from "@babel/types";

import { SOURCE_TEST_LIMITS } from "./limits.js";
import type { SourcePrimitive, SourcePrimitiveValue } from "./types.js";

const NUMBER_VALUES = [0, 1, -1] as const;
const STRING_VALUES = ["", "a", "ab"] as const;
const BOOLEAN_VALUES = [false, true] as const;

const UNARY_OPERATORS: ReadonlySet<string> = new Set(["-", "+", "!"]);
const ARITHMETIC_BINARY_OPERATORS: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
]);
const COMPARISON_BINARY_OPERATORS: ReadonlySet<string> = new Set([
  "<",
  "<=",
  ">",
  ">=",
]);
const EQUALITY_BINARY_OPERATORS: ReadonlySet<string> = new Set(["===", "!=="]);
const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(["&&", "||", "??"]);

export type CandidateFunction = FunctionDeclaration | ArrowFunctionExpression;
export type InterpValue = SourcePrimitiveValue;

export interface Budget {
  steps: number;
}

export type InterpResult =
  | { readonly ok: true; readonly value: InterpValue }
  | { readonly ok: false; readonly reason: string };

export interface ValidatedFunction {
  readonly params: readonly {
    readonly name: string;
    readonly type: SourcePrimitive;
  }[];
  readonly returnType: SourcePrimitive;
  readonly body: Expression;
}

const primitiveOfAnnotation = (
  annotation: { readonly typeAnnotation?: unknown } | null | undefined,
): SourcePrimitive | null => {
  const inner = annotation?.typeAnnotation;
  if (typeof inner !== "object" || inner === null) return null;
  switch ((inner as { type?: unknown }).type) {
    case "TSNumberKeyword":
      return "number";
    case "TSStringKeyword":
      return "string";
    case "TSBooleanKeyword":
      return "boolean";
    default:
      return null;
  }
};

/** Validate a candidate function against the supported pure-expression subset. */
export const validateFunction = (
  node: CandidateFunction,
): { ok: true; value: ValidatedFunction } | { ok: false; reason: string } => {
  if (node.async)
    return { ok: false, reason: "async functions are not supported" };
  if (node.generator)
    return { ok: false, reason: "generator functions are not supported" };
  if (node.typeParameters != null)
    return { ok: false, reason: "generic functions are not supported" };

  const params: { name: string; type: SourcePrimitive }[] = [];
  for (const param of node.params) {
    if (param.type !== "Identifier")
      return { ok: false, reason: `unsupported parameter form ${param.type}` };
    const identifier = param as Identifier;
    if (identifier.optional)
      return {
        ok: false,
        reason: `optional parameter "${identifier.name}" is not supported`,
      };
    const type = primitiveOfAnnotation(identifier.typeAnnotation);
    if (type === null)
      return {
        ok: false,
        reason: `parameter "${identifier.name}" must be annotated number, string, or boolean`,
      };
    params.push({ name: identifier.name, type });
  }

  const returnType = primitiveOfAnnotation(node.returnType);
  if (returnType === null)
    return {
      ok: false,
      reason: "return type must be annotated number, string, or boolean",
    };

  const body = extractBody(node);
  if (body === null)
    return {
      ok: false,
      reason: "function body must be a single return expression",
    };
  return { ok: true, value: { params, returnType, body } };
};

const extractBody = (node: CandidateFunction): Expression | null => {
  if (node.body.type !== "BlockStatement") return node.body;
  const statements = node.body.body;
  if (statements.length !== 1) return null;
  const only = statements[0];
  if (only?.type !== "ReturnStatement") return null;
  const argument = (only as ReturnStatement).argument;
  return argument ?? null;
};

const spend = (budget: Budget): string | null => {
  if (budget.steps <= 0)
    return "expression too complex (interpreter step budget exceeded)";
  budget.steps -= 1;
  return null;
};

/** Structural check: a supported pure expression referencing only parameters. */
export const validateExpression = (
  node: Node,
  params: ReadonlySet<string>,
  budget: Budget,
): string | null => {
  const exhausted = spend(budget);
  if (exhausted !== null) return exhausted;
  switch (node.type) {
    case "NumericLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
      return null;
    case "Identifier": {
      const name = (node as Identifier).name;
      return params.has(name)
        ? null
        : `references external identifier "${name}"`;
    }
    case "ParenthesizedExpression":
      return validateExpression(
        (node as ParenthesizedExpression).expression,
        params,
        budget,
      );
    case "UnaryExpression": {
      const unary = node as UnaryExpression;
      if (!UNARY_OPERATORS.has(unary.operator))
        return `unsupported unary operator "${unary.operator}"`;
      return validateExpression(unary.argument, params, budget);
    }
    case "BinaryExpression": {
      const binary = node as BinaryExpression;
      if (
        !ARITHMETIC_BINARY_OPERATORS.has(binary.operator) &&
        !COMPARISON_BINARY_OPERATORS.has(binary.operator) &&
        !EQUALITY_BINARY_OPERATORS.has(binary.operator)
      )
        return `unsupported binary operator "${binary.operator}"`;
      const left = validateExpression(binary.left, params, budget);
      if (left !== null) return left;
      return validateExpression(binary.right, params, budget);
    }
    case "LogicalExpression": {
      const logical = node as LogicalExpression;
      if (!LOGICAL_OPERATORS.has(logical.operator))
        return `unsupported logical operator "${logical.operator}"`;
      const left = validateExpression(logical.left, params, budget);
      if (left !== null) return left;
      return validateExpression(logical.right, params, budget);
    }
    case "ConditionalExpression": {
      const conditional = node as ConditionalExpression;
      const test = validateExpression(conditional.test, params, budget);
      if (test !== null) return test;
      const consequent = validateExpression(
        conditional.consequent,
        params,
        budget,
      );
      if (consequent !== null) return consequent;
      return validateExpression(conditional.alternate, params, budget);
    }
    case "TemplateLiteral": {
      const template = node as TemplateLiteral;
      for (const expression of template.expressions) {
        const result = validateExpression(expression, params, budget);
        if (result !== null) return result;
      }
      return null;
    }
    default:
      return `unsupported expression ${node.type}`;
  }
};

/** Bounded recursive interpreter over the validated pure-expression subset. */
export const interpret = (
  node: Node,
  env: ReadonlyMap<string, InterpValue>,
  budget: Budget,
): InterpResult => {
  const exhausted = spend(budget);
  if (exhausted !== null) return { ok: false, reason: exhausted };
  switch (node.type) {
    case "NumericLiteral":
      return { ok: true, value: (node as NumericLiteral).value };
    case "StringLiteral":
      return { ok: true, value: (node as StringLiteral).value };
    case "BooleanLiteral":
      return { ok: true, value: (node as BooleanLiteral).value };
    case "Identifier": {
      const value = env.get((node as Identifier).name);
      if (value === undefined)
        return {
          ok: false,
          reason: `unknown identifier "${(node as Identifier).name}"`,
        };
      return { ok: true, value };
    }
    case "ParenthesizedExpression":
      return interpret(
        (node as ParenthesizedExpression).expression,
        env,
        budget,
      );
    case "UnaryExpression": {
      const unary = node as UnaryExpression;
      const operand = interpret(unary.argument, env, budget);
      if (!operand.ok) return operand;
      switch (unary.operator) {
        case "-":
          return { ok: true, value: -Number(operand.value) };
        case "+":
          return { ok: true, value: +Number(operand.value) };
        case "!":
          return { ok: true, value: !operand.value };
        default:
          return {
            ok: false,
            reason: `unsupported unary operator "${unary.operator}"`,
          };
      }
    }
    case "BinaryExpression": {
      const binary = node as BinaryExpression;
      if (binary.operator === "+") {
        const left = interpret(binary.left, env, budget);
        if (!left.ok) return left;
        const right = interpret(binary.right, env, budget);
        if (!right.ok) return right;
        return { ok: true, value: addValues(left.value, right.value) };
      }
      const left = interpret(binary.left, env, budget);
      if (!left.ok) return left;
      const right = interpret(binary.right, env, budget);
      if (!right.ok) return right;
      if (binary.operator === "===")
        return { ok: true, value: left.value === right.value };
      if (binary.operator === "!==")
        return { ok: true, value: left.value !== right.value };
      return {
        ok: true,
        value: applyBinary(binary.operator, left.value, right.value),
      };
    }
    case "LogicalExpression": {
      const logical = node as LogicalExpression;
      const left = interpret(logical.left, env, budget);
      if (!left.ok) return left;
      if (logical.operator === "&&" && !left.value)
        return { ok: true, value: left.value };
      if (logical.operator === "||" && left.value)
        return { ok: true, value: left.value };
      if (
        logical.operator === "??" &&
        left.value !== null &&
        left.value !== undefined
      )
        return { ok: true, value: left.value };
      return interpret(logical.right, env, budget);
    }
    case "ConditionalExpression": {
      const conditional = node as ConditionalExpression;
      const test = interpret(conditional.test, env, budget);
      if (!test.ok) return test;
      return interpret(
        test.value ? conditional.consequent : conditional.alternate,
        env,
        budget,
      );
    }
    case "TemplateLiteral": {
      const template = node as TemplateLiteral;
      let output = "";
      for (let index = 0; index < template.quasis.length; index += 1) {
        const quasi = template.quasis[index];
        output += quasi?.value.cooked ?? quasi?.value.raw ?? "";
        const expression = template.expressions[index];
        if (expression !== undefined) {
          const result = interpret(expression, env, budget);
          if (!result.ok) return result;
          output += String(result.value);
        }
      }
      return { ok: true, value: output };
    }
    default:
      return { ok: false, reason: `unsupported expression ${node.type}` };
  }
};

const addValues = (left: InterpValue, right: InterpValue): InterpValue => {
  if (typeof left === "string" || typeof right === "string")
    return String(left) + String(right);
  return Number(left) + Number(right);
};

const applyBinary = (
  operator: string,
  left: InterpValue,
  right: InterpValue,
): InterpValue => {
  switch (operator) {
    case "-":
      return Number(left) - Number(right);
    case "*":
      return Number(left) * Number(right);
    case "/":
      return Number(left) / Number(right);
    case "%":
      return Number(left) % Number(right);
    case "<": {
      const order = relationalCompare(left, right);
      return order === -1;
    }
    case "<=": {
      const order = relationalCompare(left, right);
      return order === -1 || order === 0;
    }
    case ">": {
      const order = relationalCompare(left, right);
      return order === 1;
    }
    case ">=": {
      const order = relationalCompare(left, right);
      return order === 1 || order === 0;
    }
    default:
      return NaN;
  }
};

/**
 * Order two operands the way JavaScript's relational operators do. Returns
 * null when the operands are unordered (either coerces to NaN); in that case
 * `<`, `<=`, `>`, and `>=` all evaluate to false.
 */
const relationalCompare = (
  left: InterpValue,
  right: InterpValue,
): -1 | 0 | 1 | null => {
  if (typeof left === "string" && typeof right === "string") {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) return null;
  if (leftNumber < rightNumber) return -1;
  if (leftNumber > rightNumber) return 1;
  return 0;
};

/** Reject non-finite numbers, normalize -0, and enforce the declared type. */
export const finalizeValue = (
  value: InterpValue,
  returnType: SourcePrimitive,
):
  | { ok: true; value: SourcePrimitiveValue }
  | { ok: false; reason: string } => {
  let result = value;
  if (typeof result === "number") {
    if (!Number.isFinite(result))
      return { ok: false, reason: "non-finite numeric result" };
    if (Object.is(result, -0)) result = 0;
  }
  if (typeof result !== returnType)
    return {
      ok: false,
      reason: `result is ${typeof result}, expected ${returnType}`,
    };
  return { ok: true, value: result };
};

/** Deterministic one-factor-at-a-time input generation, bounded per function. */
export const generateCases = (
  types: readonly SourcePrimitive[],
): readonly SourcePrimitiveValue[][] => {
  const sets = types.map(valuesFor);
  const base: SourcePrimitiveValue[] = sets.map((set) => set[0]);
  const cases: SourcePrimitiveValue[][] = [base];
  for (let index = 0; index < sets.length; index += 1) {
    const set = sets[index];
    if (set === undefined) continue;
    for (let valueIndex = 1; valueIndex < set.length; valueIndex += 1) {
      const value = set[valueIndex];
      if (value === undefined) continue;
      const variant = base.slice();
      variant[index] = value;
      cases.push(variant);
    }
  }
  return dedupeCases(cases).slice(0, SOURCE_TEST_LIMITS.maxCasesPerFunction);
};

const valuesFor = (
  type: SourcePrimitive,
): readonly [SourcePrimitiveValue, ...SourcePrimitiveValue[]] => {
  switch (type) {
    case "number":
      return [...NUMBER_VALUES];
    case "string":
      return [...STRING_VALUES];
    case "boolean":
      return [...BOOLEAN_VALUES];
  }
};

const dedupeCases = (
  cases: readonly SourcePrimitiveValue[][],
): SourcePrimitiveValue[][] => {
  const seen = new Set<string>();
  const unique: SourcePrimitiveValue[][] = [];
  for (const entry of cases) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
};

/** A pure top-level initializer: literals/operators with no calls or identifiers. */
export const isSideEffectFree = (node: Node): boolean => {
  switch (node.type) {
    case "NumericLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
      return true;
    case "Identifier":
      return false;
    case "ParenthesizedExpression":
      return isSideEffectFree((node as ParenthesizedExpression).expression);
    case "UnaryExpression": {
      const unary = node as UnaryExpression;
      return (
        UNARY_OPERATORS.has(unary.operator) && isSideEffectFree(unary.argument)
      );
    }
    case "BinaryExpression": {
      const binary = node as BinaryExpression;
      return (
        (ARITHMETIC_BINARY_OPERATORS.has(binary.operator) ||
          COMPARISON_BINARY_OPERATORS.has(binary.operator) ||
          EQUALITY_BINARY_OPERATORS.has(binary.operator)) &&
        isSideEffectFree(binary.left) &&
        isSideEffectFree(binary.right)
      );
    }
    case "LogicalExpression": {
      const logical = node as LogicalExpression;
      return (
        LOGICAL_OPERATORS.has(logical.operator) &&
        isSideEffectFree(logical.left) &&
        isSideEffectFree(logical.right)
      );
    }
    case "ConditionalExpression": {
      const conditional = node as ConditionalExpression;
      return (
        isSideEffectFree(conditional.test) &&
        isSideEffectFree(conditional.consequent) &&
        isSideEffectFree(conditional.alternate)
      );
    }
    case "TemplateLiteral": {
      const template = node as TemplateLiteral;
      return template.expressions.every((expression) =>
        isSideEffectFree(expression),
      );
    }
    default:
      return false;
  }
};
