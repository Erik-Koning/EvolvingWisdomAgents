// Pinned mini JSON Schema subset used for ActionSpec.resultSchema and
// VariableSpec.schema validation inside the kernel: type / required /
// properties / items / enum / const. Full-document validation (Ajv,
// jsonschema) lives outside the kernel; this subset keeps the two runtimes
// byte-identical without a heavyweight dependency in the hot path.

export function miniValidate(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = [];
  if ("const" in schema) {
    if (JSON.stringify(value) !== JSON.stringify(schema["const"])) {
      errors.push(`${path}: not const`);
    }
    return errors;
  }
  if (Array.isArray(schema["enum"])) {
    const hit = (schema["enum"] as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!hit) errors.push(`${path}: not in enum`);
    return errors;
  }
  const type = schema["type"];
  if (typeof type === "string" && !typeMatches(value, type)) {
    errors.push(`${path}: expected ${type}`);
    return errors;
  }
  if (type === "object" || (type === undefined && isPlainObject(value))) {
    if (isPlainObject(value)) {
      const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
      for (const key of required) {
        if (!(key in value)) errors.push(`${path}.${key}: required`);
      }
      const props = isPlainObject(schema["properties"]) ? (schema["properties"] as Record<string, unknown>) : {};
      for (const [key, sub] of Object.entries(props)) {
        if (key in value && isPlainObject(sub)) {
          errors.push(...miniValidate((value as Record<string, unknown>)[key], sub, `${path}.${key}`));
        }
      }
    }
  }
  if (type === "array" && Array.isArray(value) && isPlainObject(schema["items"])) {
    value.forEach((item, i) => {
      errors.push(...miniValidate(item, schema["items"] as Record<string, unknown>, `${path}[${i}]`));
    });
  }
  return errors;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
