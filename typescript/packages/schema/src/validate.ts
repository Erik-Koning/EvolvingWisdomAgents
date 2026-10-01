import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphDoc } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

function schemaDir(): string {
  // vendored copy (published package) first, repo /schema (dev) second
  for (const candidate of [
    join(here, "..", "schemas"),
    join(here, "..", "..", "schemas"),
    join(here, "..", "..", "..", "..", "..", "schema"),
  ]) {
    if (existsSync(join(candidate, "apg.schema.json"))) return candidate;
  }
  throw new Error("APG schema files not found (looked for apg.schema.json)");
}

let compiled: ValidateFunction | null = null;

function compiler(): ValidateFunction {
  if (compiled) return compiled;
  const dir = schemaDir();
  // ajv/dist/2020 is CJS; createRequire sidesteps ESM/CJS default-export drift
  const require = createRequire(import.meta.url);
  const mod = require("ajv/dist/2020.js") as { Ajv2020?: unknown; default?: unknown };
  const AjvCtor = (mod.Ajv2020 ?? mod.default) as new (opts: Record<string, unknown>) => {
    addSchema(s: unknown): void;
    compile(s: unknown): ValidateFunction;
  };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  for (const f of ["changeset.schema.json", "session.schema.json", "routing-result.schema.json", "transcript.schema.json"]) {
    ajv.addSchema(JSON.parse(readFileSync(join(dir, f), "utf8")));
  }
  const fn = ajv.compile(JSON.parse(readFileSync(join(dir, "apg.schema.json"), "utf8")));
  compiled = fn;
  return fn;
}

export interface DocumentValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

/** Structural validation of a raw *.apg.json document against the JSON Schema. */
export function validateDocument(doc: unknown): DocumentValidationResult {
  const validate = compiler();
  const valid = validate(doc) as boolean;
  return {
    valid,
    errors: (validate.errors ?? []).map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? "invalid",
    })),
  };
}

export function assertDocument(doc: unknown): asserts doc is GraphDoc {
  const r = validateDocument(doc);
  if (!r.valid) {
    const first = r.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`APG document failed schema validation: ${first}`);
  }
}

export function loadProfiles(): {
  profiles: Record<string, { name: string; inherits?: string; features: string[] }>;
  featureGates: Record<string, string>;
} {
  const dir = schemaDir();
  return JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8"));
}
