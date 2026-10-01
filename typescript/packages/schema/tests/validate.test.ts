import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateDocument, loadProfiles } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "..", "..", "..", "templates");

describe("document validation", () => {
  for (const file of readdirSync(templatesDir).filter((f) => f.endsWith(".apg.json")).sort()) {
    it(`${file} passes the JSON Schema`, () => {
      const doc = JSON.parse(readFileSync(join(templatesDir, file), "utf8"));
      const r = validateDocument(doc);
      expect(r.errors).toEqual([]);
      expect(r.valid).toBe(true);
    });
  }

  it("rejects a decision node without its decision block", () => {
    const r = validateDocument({
      schemaVersion: "1.0",
      graphId: "bad",
      nodes: [
        { id: "root", parentId: null, title: "R", description: "r" },
        { id: "d", parentId: "root", type: "decision", title: "D", description: "d" },
      ],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const r = validateDocument({ schemaVersion: "1.0", graphId: "x", nodes: [], banana: true });
    expect(r.valid).toBe(false);
  });

  it("exposes capability profiles with feature gates", () => {
    const p = loadProfiles();
    expect(Object.keys(p.profiles)).toEqual(["L0", "L1", "L2", "L3", "L4", "L5"]);
    expect(p.featureGates["escalation"]).toBe("L4");
  });
});
