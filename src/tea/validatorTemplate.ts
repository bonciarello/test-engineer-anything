/**
 * Standalone JSON Schema validator embedded verbatim in every generated test
 * file. It implements exactly the subset declared in schemaSubset.ts. The code
 * deliberately uses only string concatenation (no template literals) so it can
 * be embedded in a TypeScript template literal without escaping.
 */
export const VALIDATOR_CODE = `function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function resolvePointer(root, pointer) {
  const normalized = pointer.replace(/^#/u, "");
  if (normalized === "") return root;
  if (!normalized.startsWith("/")) return undefined;
  const tokens = normalized.slice(1).split("/").map((token) =>
    token.replace(/~1/gu, "/").replace(/~0/gu, "~"),
  );
  let current = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return undefined;
      current = current[index];
    } else if (isObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token))
        return undefined;
      current = ownValue(current, token);
    } else {
      return undefined;
    }
  }
  return current;
}

function matchesType(type, value) {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return true;
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMultipleOf(value, divisor) {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

function fail(message) {
  throw new Error("[tea-schema] " + message);
}

function passes(doc, schema, value) {
  try {
    validate(doc, schema, value, new Set(), "$");
    return true;
  } catch {
    return false;
  }
}

function validate(doc, schema, value, seenRefs, path) {
  if (typeof schema === "boolean") {
    if (schema === false) fail(path + ": false schema rejects every value");
    return;
  }
  if (isObject(schema) && typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (!ref.startsWith("#")) fail("external $ref unsupported: " + ref);
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    const target = resolvePointer(doc, ref);
    if (target === undefined) fail("unresolved $ref: " + ref);
    validate(doc, target, value, seenRefs, path);
    seenRefs.delete(ref);
    return;
  }
  if (!isObject(schema)) fail(path + ": schema is not an object");

  if (schema.nullable === true && value === null) return;

  if (typeof schema.type === "string") {
    if (!matchesType(schema.type, value))
      fail(path + ": expected type " + schema.type);
  } else if (Array.isArray(schema.type)) {
    const types = schema.type.filter((entry) => typeof entry === "string");
    if (!types.some((entry) => matchesType(entry, value)))
      fail(path + ": expected one of types " + types.join("|"));
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value))
    fail(path + ": value does not equal const");
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value)))
    fail(path + ": value is not one of the documented enum values");

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      fail(path + ": shorter than minLength " + schema.minLength);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      fail(path + ": longer than maxLength " + schema.maxLength);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      fail(path + ": does not match pattern " + schema.pattern);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      fail(path + ": below minimum " + schema.minimum);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      fail(path + ": above maximum " + schema.maximum);
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    )
      fail(path + ": not above exclusiveMinimum " + schema.exclusiveMinimum);
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    )
      fail(path + ": not below exclusiveMaximum " + schema.exclusiveMaximum);
    if (
      typeof schema.multipleOf === "number" &&
      !isMultipleOf(value, schema.multipleOf)
    )
      fail(path + ": not a multiple of " + schema.multipleOf);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      fail(path + ": fewer than minItems " + schema.minItems);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      fail(path + ": more than maxItems " + schema.maxItems);
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) fail(path + ": duplicate array items");
        }
      }
    }
    if (isObject(schema.items))
      value.forEach((item, index) =>
        validate(doc, schema.items, item, seenRefs, path + "[" + index + "]"),
      );
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties)
      fail(path + ": fewer than minProperties " + schema.minProperties);
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties)
      fail(path + ": more than maxProperties " + schema.maxProperties);
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key))
          fail(path + ': missing required property "' + key + '"');
      }
    }
    if (isObject(schema.properties)) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key))
          validate(doc, subSchema, ownValue(value, key), seenRefs, path + "." + key);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = isObject(schema.properties)
        ? new Set(Object.keys(schema.properties))
        : new Set();
      for (const key of keys) {
        if (!allowed.has(key)) fail(path + ': unexpected property "' + key + '"');
      }
    }
  }

  if (Array.isArray(schema.allOf))
    for (const subSchema of schema.allOf)
      validate(doc, subSchema, value, seenRefs, path);
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((subSchema) => passes(doc, subSchema, value)))
      fail(path + ": value matches none of anyOf");
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((subSchema) => passes(doc, subSchema, value));
    if (matched.length !== 1)
      fail(path + ": value matches " + matched.length + " of oneOf (expected 1)");
  }
}

function validateResponse(doc, schemaPointer, body) {
  if (schemaPointer === null) return;
  const schema = resolvePointer(doc, schemaPointer);
  if (schema === undefined) fail("unresolved schema pointer: " + schemaPointer);
  validate(doc, schema, body, new Set(), "$");
}
`;
