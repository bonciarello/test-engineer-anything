import {
  asString,
  isJsonObject,
  objectChild,
  resolveJsonPointer,
} from "./json.js";
import type { JsonObject, JsonValue } from "./types.js";

/**
 * Validation keywords the generated validator implements. Annotation-only keys
 * are accepted and ignored; anything else fails closed so an assertion never
 * becomes unreliable.
 */
const SUPPORTED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "$ref",
  "type",
  "enum",
  "const",
  "nullable",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "pattern",
  // Annotation / structural keys that do not affect validation.
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "xml",
  "externalDocs",
  "discriminator",
  "definitions",
  "$defs",
  "$schema",
  "$id",
  "id",
  "$comment",
]);

export interface SchemaSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

/**
 * Decide whether the generated validator can trust a response schema. Local
 * `$ref`s are resolved (cycle-safe); unknown validation keywords fail closed.
 */
export const checkSchemaSupport = (
  document: JsonObject,
  schema: JsonValue,
): SchemaSupport => checkNode(document, schema, new Set());

const checkNode = (
  document: JsonObject,
  schema: JsonValue,
  seenRefs: Set<string>,
): SchemaSupport => {
  if (typeof schema === "boolean") return { supported: true, reason: null };
  if (!isJsonObject(schema))
    return { supported: false, reason: "schema is not an object" };

  const ref = asString(objectChild(schema, "$ref"));
  if (ref !== null) {
    if (!ref.startsWith("#"))
      return { supported: false, reason: `external $ref unsupported: ${ref}` };
    if (seenRefs.has(ref)) return { supported: true, reason: null };
    const target = resolveJsonPointer(document, ref);
    if (target === undefined)
      return { supported: false, reason: `unresolved $ref: ${ref}` };
    seenRefs.add(ref);
    const result = checkNode(document, target, seenRefs);
    seenRefs.delete(ref);
    return result;
  }

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key))
      return { supported: false, reason: `unsupported keyword "${key}"` };
  }

  const properties = objectChild(schema, "properties");
  if (properties !== undefined) {
    if (!isJsonObject(properties))
      return { supported: false, reason: "properties must be an object" };
    for (const sub of Object.values(properties)) {
      const result = checkNode(document, sub, seenRefs);
      if (!result.supported) return result;
    }
  }

  const items = objectChild(schema, "items");
  if (items !== undefined) {
    if (Array.isArray(items))
      return { supported: false, reason: "tuple items are unsupported" };
    const result = checkNode(document, items, seenRefs);
    if (!result.supported) return result;
  }

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const value = objectChild(schema, key);
    if (value !== undefined) {
      if (!Array.isArray(value))
        return { supported: false, reason: `${key} must be an array` };
      for (const sub of value) {
        const result = checkNode(document, sub, seenRefs);
        if (!result.supported) return result;
      }
    }
  }

  for (const key of ["definitions", "$defs"] as const) {
    const value = objectChild(schema, key);
    if (value !== undefined && isJsonObject(value)) {
      for (const sub of Object.values(value)) {
        const result = checkNode(document, sub, seenRefs);
        if (!result.supported) return result;
      }
    }
  }

  return { supported: true, reason: null };
};
