import { readFile } from "node:fs/promises";

import { analyzeProduct } from "./analyze.js";
import {
  asString,
  isJsonArray,
  isJsonObject,
  objectChild,
  operationPointer,
  pointerToken,
  resolveJsonPointer,
} from "./json.js";
import { MUTATING_METHODS, PATH_ITEM_METHODS } from "./limits.js";
import { checkSchemaSupport } from "./schemaSubset.js";
import { parseSpecDocument } from "./specs.js";
import type {
  ContractTestCase,
  ExcludedOperation,
  JsonObject,
  JsonValue,
  PlanInput,
  ResponseAssertion,
  TeaEvidence,
  TestPlan,
} from "./types.js";

/** Plan contract tests for GET/HEAD operations of every discovered spec. */
export const planContractTests = async (
  input: PlanInput,
): Promise<TestPlan> => {
  const analysis = input.analysis ?? (await analyzeProduct(input.repoDir));
  const cases: ContractTestCase[] = [];
  const excluded: ExcludedOperation[] = [];
  const limitations: string[] = [...analysis.limitations];
  const specs: string[] = [];

  for (const spec of analysis.specs) {
    specs.push(spec.path);
    const parsed = parseSpecDocument(await readFile(spec.path, "utf8"));
    if (parsed.kind !== "openapi3") continue;
    const planned = planDocument(spec.path, parsed.document);
    cases.push(...planned.cases);
    excluded.push(...planned.excluded);
    limitations.push(...planned.limitations);
  }

  return {
    repoDir: analysis.repoDir,
    specs,
    cases,
    excluded,
    limitations: dedupe(limitations),
  };
};

interface PlannedDocument {
  readonly cases: ContractTestCase[];
  readonly excluded: ExcludedOperation[];
  readonly limitations: string[];
}

const planDocument = (
  specPath: string,
  document: JsonObject,
): PlannedDocument => {
  const cases: ContractTestCase[] = [];
  const excluded: ExcludedOperation[] = [];
  const limitations: string[] = [];
  const usedIds = new Map<string, number>();

  const paths = objectChild(document, "paths");
  if (!isJsonObject(paths)) {
    limitations.push(`spec ${specPath} declares no paths`);
    return { cases, excluded, limitations };
  }

  for (const [pathTemplate, rawPathItem] of Object.entries(paths)) {
    const pathItem = resolveLocalObjectRef(document, rawPathItem);
    if (!isJsonObject(pathItem)) continue;
    const pathParameters = parameterList(
      document,
      objectChild(pathItem, "parameters"),
    );

    for (const method of PATH_ITEM_METHODS) {
      const rawOperation = objectChild(pathItem, method);
      if (!isJsonObject(rawOperation)) continue;
      const operation = resolveLocalObjectRef(document, rawOperation);
      if (!isJsonObject(operation)) continue;

      const jsonPointer = operationPointer(pathTemplate, method);
      const evidence: TeaEvidence = {
        specPath,
        jsonPointer,
        confidence: "observed",
        authority: "shipped-artifact",
        limitations: [],
      };
      if (method !== "get" && method !== "head") {
        excluded.push({
          method,
          path: pathTemplate,
          jsonPointer,
          reason: MUTATING_METHODS.has(method)
            ? "mutating method"
            : "non-GET/HEAD method",
          evidence,
        });
        continue;
      }

      const operationParameters = parameterList(
        document,
        objectChild(operation, "parameters"),
      );
      const parameters = mergeParameters(
        document,
        pathParameters,
        operationParameters,
      );

      const paramFailure = resolveOperationParameters(document, parameters);
      if (paramFailure !== null) {
        excluded.push({
          method,
          path: pathTemplate,
          jsonPointer,
          reason: paramFailure,
          evidence,
        });
        continue;
      }

      const responses = objectChild(operation, "responses");
      const assertions = responseAssertions(
        document,
        pathTemplate,
        method,
        responses,
      );
      if (assertions.length === 0) {
        excluded.push({
          method,
          path: pathTemplate,
          jsonPointer,
          reason: "no documented 2xx response",
          evidence,
        });
        continue;
      }

      for (const assertion of assertions) {
        if (!assertion.schemaSupported && assertion.unsupportedReason !== null)
          limitations.push(
            `response schema at ${assertion.schemaPointer ?? jsonPointer} uses ${assertion.unsupportedReason}; asserting status/content-type only`,
          );
      }

      const id = uniqueCaseId(usedIds, method, pathTemplate);
      const operationId = asString(objectChild(operation, "operationId"));
      const summary = asString(objectChild(operation, "summary"));
      cases.push({
        id,
        method,
        pathTemplate,
        operationId,
        summary,
        evidence,
        expectedStatus: assertions
          .filter((assertion) => assertion.status !== null)
          .map((assertion) => assertion.status as number),
        any2xx: assertions.some((assertion) => assertion.status === null),
        pathParams: paramsOf(document, parameters, "path"),
        queryParams: paramsOf(document, parameters, "query"),
        responses: assertions,
      });
    }
  }

  return { cases, excluded, limitations };
};

/** Merge path-level and operation-level parameters; operation wins per name+in. */
const mergeParameters = (
  document: JsonObject,
  pathParameters: readonly JsonObject[],
  operationParameters: readonly JsonObject[],
): JsonObject[] => {
  const merged = new Map<string, JsonObject>();
  for (const parameter of [...pathParameters, ...operationParameters]) {
    const name = asString(objectChild(parameter, "name"));
    const location = asString(objectChild(parameter, "in"));
    if (name === null || location === null) continue;
    merged.set(`${location}:${name}`, parameter);
  }
  return [...merged.values()];
};

/** Parse a `parameters` array, resolving local `$ref` entries. */
const parameterList = (
  document: JsonObject,
  value: JsonValue | undefined,
): JsonObject[] => {
  if (!isJsonArray(value)) return [];
  const result: JsonObject[] = [];
  for (const entry of value) {
    const resolved = resolveLocalObjectRef(document, entry);
    if (isJsonObject(resolved)) result.push(resolved);
  }
  return result;
};

/**
 * Resolve required path/query parameters to deterministic string values.
 * Returns an exclusion reason when a required parameter is unresolvable.
 */
const resolveOperationParameters = (
  document: JsonObject,
  parameters: readonly JsonObject[],
): string | null => {
  for (const parameter of parameters) {
    const location = asString(objectChild(parameter, "in"));
    const name = asString(objectChild(parameter, "name"));
    if (location === null || name === null) continue;
    if (location !== "path" && location !== "query") continue;
    const required =
      location === "path" ||
      asBoolean(objectChild(parameter, "required")) === true;
    if (!required) continue;
    if (resolveParamValue(document, parameter) === null)
      return location === "path"
        ? `unresolvable path parameter "${name}"`
        : `unresolvable required query parameter "${name}"`;
  }
  return null;
};

/** Resolve one parameter to a deterministic URL-safe string, or null. */
const resolveParamValue = (
  document: JsonObject,
  parameter: JsonObject,
): string | null => {
  const direct = firstDefined(
    objectChild(parameter, "example"),
    firstExampleValue(objectChild(parameter, "examples")),
    objectChild(parameter, "default"),
  );
  if (direct !== undefined) return valueToString(direct);

  const schema = resolveLocalObjectRef(
    document,
    objectChild(parameter, "schema"),
  );
  if (isJsonObject(schema)) {
    const fromSchema = firstDefined(
      objectChild(schema, "example"),
      firstExampleValue(objectChild(schema, "examples")),
      objectChild(schema, "default"),
    );
    if (fromSchema !== undefined) return valueToString(fromSchema);
    const enumValue = objectChild(schema, "enum");
    if (isJsonArray(enumValue) && enumValue.length > 0) {
      const firstEnum = enumValue[0];
      if (firstEnum !== undefined) return valueToString(firstEnum);
    }
    const constValue = objectChild(schema, "const");
    if (constValue !== undefined) return valueToString(constValue);
    const type = objectChild(schema, "type");
    if (typeof type === "string") return deterministicValue(type);
    if (isJsonArray(type) && typeof type[0] === "string")
      return deterministicValue(type[0]);
  }
  return null;
};

/** Build response assertions for all documented 2xx responses. */
const responseAssertions = (
  document: JsonObject,
  pathTemplate: string,
  method: string,
  responses: JsonValue | undefined,
): ResponseAssertion[] => {
  if (!isJsonObject(responses)) return [];
  const assertions: ResponseAssertion[] = [];
  for (const [statusKey, rawResponse] of Object.entries(responses)) {
    const parsedStatus = parseStatus(statusKey);
    if (parsedStatus === undefined) continue;
    const response = resolveLocalObjectRef(document, rawResponse);
    if (!isJsonObject(response)) continue;
    assertions.push(
      buildAssertion(
        document,
        pathTemplate,
        method,
        statusKey,
        parsedStatus,
        response,
      ),
    );
  }
  return assertions;
};

/** Map a response status key to a concrete 2xx code, wildcard marker, or none. */
const parseStatus = (statusKey: string): number | "2xx" | undefined => {
  if (/^\d{3}$/u.test(statusKey)) {
    const code = Number(statusKey);
    return code >= 200 && code < 300 ? code : undefined;
  }
  return /^2xx$/iu.test(statusKey) ? "2xx" : undefined;
};

const buildAssertion = (
  document: JsonObject,
  pathTemplate: string,
  method: string,
  statusKey: string,
  status: number | "2xx",
  response: JsonObject,
): ResponseAssertion => {
  const content = objectChild(response, "content");
  const base: ResponseAssertion = {
    status: status === "2xx" ? null : status,
    contentType: null,
    jsonContentType: false,
    schemaPointer: null,
    schemaSupported: false,
    unsupportedReason: null,
  };
  if (!isJsonObject(content)) return base;

  const mediaTypes = Object.keys(content);
  const jsonMediaType =
    mediaTypes.find((entry) => entry === "application/json") ??
    mediaTypes.find((entry) => entry.endsWith("+json"));
  if (jsonMediaType === undefined) {
    return { ...base, contentType: mediaTypes[0] ?? null };
  }

  const media = objectChild(content, jsonMediaType);
  const schema = isJsonObject(media) ? objectChild(media, "schema") : undefined;
  if (schema === undefined)
    return {
      ...base,
      contentType: jsonMediaType,
      jsonContentType: true,
      schemaPointer: null,
      unsupportedReason: "no response schema documented",
    };

  const schemaPointer = `/paths/${pointerToken(pathTemplate)}/${method}/responses/${pointerToken(statusKey)}/content/${pointerToken(jsonMediaType)}/schema`;
  const support = checkSchemaSupport(document, schema);
  return {
    ...base,
    contentType: jsonMediaType,
    jsonContentType: true,
    schemaPointer,
    schemaSupported: support.supported,
    unsupportedReason: support.reason,
  };
};

/** Extract resolved string values for parameters in one location. */
const paramsOf = (
  document: JsonObject,
  parameters: readonly JsonObject[],
  location: "path" | "query",
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const parameter of parameters) {
    if (asString(objectChild(parameter, "in")) !== location) continue;
    const name = asString(objectChild(parameter, "name"));
    if (name === null) continue;
    // Path parameters are always exercised; query parameters only when required.
    if (
      location === "query" &&
      asBoolean(objectChild(parameter, "required")) !== true
    )
      continue;
    const value = resolveParamValue(document, parameter);
    if (value !== null) result[name] = value;
  }
  return result;
};

const firstDefined = (
  ...values: readonly (JsonValue | undefined)[]
): JsonValue | undefined => values.find((value) => value !== undefined);

const firstExampleValue = (
  examples: JsonValue | undefined,
): JsonValue | undefined => {
  if (!isJsonObject(examples)) return undefined;
  const first = Object.values(examples)[0];
  if (isJsonObject(first)) {
    const value = objectChild(first, "value");
    return value ?? first;
  }
  return first;
};

const valueToString = (value: JsonValue): string => {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  return JSON.stringify(value);
};

const deterministicValue = (type: string): string => {
  switch (type) {
    case "number":
    case "integer":
      return "1";
    case "boolean":
      return "true";
    case "array":
      return "[]";
    case "object":
      return "{}";
    default:
      return "tea";
  }
};

/** Resolve a local `$ref` chain; returns undefined for external/cyclic refs. */
const resolveLocalObjectRef = (
  document: JsonObject,
  value: JsonValue | undefined,
): JsonValue | undefined => {
  let current = value;
  const seen = new Set<string>();
  while (isJsonObject(current)) {
    const ref = asString(objectChild(current, "$ref"));
    if (ref === null) return current;
    if (!ref.startsWith("#") || seen.has(ref)) return undefined;
    seen.add(ref);
    current = resolveJsonPointer(document, ref);
  }
  return current;
};

const uniqueCaseId = (
  used: Map<string, number>,
  method: string,
  pathTemplate: string,
): string => {
  const base =
    `tea_${method}_${pathTemplate.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "root"}`.toLowerCase();
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}_${count}`;
};

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

const asBoolean = (value: JsonValue | undefined): boolean | null =>
  typeof value === "boolean" ? value : null;
