import type { JsonObject, JsonValue } from "./types.js";

/** Narrow an unknown value to a JSON object. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow an unknown value to a JSON array. */
export const isJsonArray = (value: unknown): value is JsonValue[] =>
  Array.isArray(value);

/** Read a string property without throwing on non-object values. */
export const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Resolve an RFC 6901 JSON pointer (with an optional leading `#`) against a
 * document root. Returns undefined when any segment is missing.
 */
export const resolveJsonPointer = (
  root: JsonValue,
  pointer: string,
): JsonValue | undefined => {
  const normalized = pointer.replace(/^#/u, "");
  if (normalized === "") return root;
  if (!normalized.startsWith("/")) return undefined;
  const tokens = normalized
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  let current: JsonValue | undefined = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return undefined;
      current = current[index];
    } else if (isJsonObject(current)) {
      current = Object.hasOwn(current, token) ? current[token] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
};

/** Encode a single reference token for use inside a JSON pointer. */
export const pointerToken = (segment: string): string =>
  segment.replace(/~/gu, "~0").replace(/\//gu, "~1");

/** Build the JSON pointer for a path item method. */
export const operationPointer = (
  pathTemplate: string,
  method: string,
): string => `/paths/${pointerToken(pathTemplate)}/${method}`;

/**
 * Read a child object property. Returns undefined for missing keys or
 * non-object values.
 */
export const objectChild = (
  object: JsonObject,
  key: string,
): JsonValue | undefined =>
  Object.hasOwn(object, key) ? object[key] : undefined;
