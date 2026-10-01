import { describe, it, expect } from "vitest";
import { MemoryGraphStore, StoreConflictError, type GraphDoc } from "../src/index.js";

const doc = (version: string): GraphDoc => ({
  schemaVersion: "1.0",
  graphId: "g",
  version,
  nodes: [{ id: "root", parentId: null, type: "category", title: "R", description: "r" }],
});

describe("MemoryGraphStore", () => {
  it("load() with no version returns the most recently saved, not first-insert order", async () => {
    const store = new MemoryGraphStore();
    await store.save(doc("2"));
    await store.save(doc("1"));
    expect((await store.load("g")).version).toBe("1");
    await store.save(doc("2")); // re-save existing key must move it to latest
    expect((await store.load("g")).version).toBe("2");
  });

  it("CAS: expectedVersion must match the latest; null means create-only", async () => {
    const store = new MemoryGraphStore();
    await store.save(doc("1"), { expectedVersion: null }); // create-only on empty: ok
    await expect(store.save(doc("2"), { expectedVersion: null })).rejects.toThrow(StoreConflictError);
    await expect(store.save(doc("2"), { expectedVersion: "0" })).rejects.toThrow("expected 0, found 1");
    await store.save(doc("2"), { expectedVersion: "1" });
    expect((await store.load("g")).version).toBe("2");
    await store.save(doc("3")); // unconditional save still works
  });

  it("load() with a version returns that version", async () => {
    const store = new MemoryGraphStore();
    await store.save(doc("1"));
    await store.save(doc("2"));
    expect((await store.load("g", "1")).version).toBe("1");
    await expect(store.load("g", "3")).rejects.toThrow("unknown version");
  });
});
