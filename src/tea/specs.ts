import { parse as parseYaml } from "yaml";

import { asString, isJsonObject, objectChild } from "./json.js";
import { MUTATING_METHODS, PATH_ITEM_METHODS } from "./limits.js";
import type { JsonObject } from "./types.js";

/** Result of parsing one spec candidate. */
export type SpecParse =
  | {
      readonly kind: "openapi3";
      readonly format: "json" | "yaml";
      readonly version: string;
      readonly title: string | null;
      readonly document: JsonObject;
    }
  | { readonly kind: "swagger2"; readonly format: "json" | "yaml" }
  | { readonly kind: "not-openapi"; readonly format: "json" | "yaml" };

/** Parse a spec candidate as JSON first, then YAML. Never throws. */
export const parseSpecDocument = (text: string): SpecParse => {
  let format: "json" | "yaml" = "json";
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    format = "yaml";
    try {
      value = parseYaml(text);
    } catch {
      return { kind: "not-openapi", format };
    }
  }
  if (!isJsonObject(value)) return { kind: "not-openapi", format };

  const openapi = asString(value.openapi);
  if (openapi !== null && openapi.startsWith("3.")) {
    const info = isJsonObject(objectChild(value, "info"))
      ? objectChild(value, "info")
      : undefined;
    return {
      kind: "openapi3",
      format,
      version: openapi,
      title:
        info !== undefined && isJsonObject(info)
          ? asString(objectChild(info, "title"))
          : null,
      document: value,
    };
  }
  if (typeof value.swagger === "string") {
    return { kind: "swagger2", format };
  }
  return { kind: "not-openapi", format };
};

/** Count operations by category for an analyzed spec summary. */
export const countOperations = (
  document: JsonObject,
): {
  get: number;
  head: number;
  mutating: number;
  other: number;
  total: number;
} => {
  const counts = { get: 0, head: 0, mutating: 0, other: 0, total: 0 };
  const paths = objectChild(document, "paths");
  if (!isJsonObject(paths)) return counts;
  for (const pathItem of Object.values(paths)) {
    if (!isJsonObject(pathItem)) continue;
    for (const method of PATH_ITEM_METHODS) {
      if (!isJsonObject(objectChild(pathItem, method))) continue;
      counts.total += 1;
      if (method === "get") counts.get += 1;
      else if (method === "head") counts.head += 1;
      else if (MUTATING_METHODS.has(method)) counts.mutating += 1;
      else counts.other += 1;
    }
  }
  return counts;
};
