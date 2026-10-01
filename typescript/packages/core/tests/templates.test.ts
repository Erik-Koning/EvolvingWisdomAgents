// Every shipped template must: pass JSON Schema validation, normalize, pass
// the semantic validator, declare a profile at or above the features it uses,
// and round-trip byte-stably (normalize is idempotent).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateDocument } from "@apgraph/schema";
import { normalizeDocument, validateGraph, detectRequiredProfile, type GraphDoc, type Profile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "..", "..", "..", "templates");
const files = readdirSync(templatesDir).filter((f) => f.endsWith(".apg.json")).sort();

const ORDER: Profile[] = ["L0", "L1", "L2", "L3", "L4", "L5"];

describe("templates", () => {
  for (const file of files) {
    describe(file, () => {
      const raw = JSON.parse(readFileSync(join(templatesDir, file), "utf8")) as GraphDoc;

      it("passes JSON Schema validation", () => {
        const r = validateDocument(raw);
        expect(r.errors).toEqual([]);
        expect(r.valid).toBe(true);
      });

      it("passes semantic validation after normalization", () => {
        const report = validateGraph(normalizeDocument(raw));
        expect(report.errors).toEqual([]);
        expect(report.valid).toBe(true);
      });

      it("declares a profile covering its features", () => {
        const required = detectRequiredProfile(normalizeDocument(raw));
        expect(ORDER.indexOf(required)).toBeLessThanOrEqual(ORDER.indexOf(raw.profile ?? "L0"));
      });

      it("normalization is idempotent (byte-stable round trip)", () => {
        const once = normalizeDocument(raw);
        const twice = normalizeDocument(once);
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
      });
    });
  }
});
