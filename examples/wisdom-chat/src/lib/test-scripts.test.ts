// Structural invariants the ChatPane runner relies on. These test the script
// DEFINITIONS only — live graph behavior is intentionally untested here (the
// whole point of the harness is that outcomes come from the real LLM).
import { describe, expect, it } from "vitest";
import { TEST_SCRIPTS } from "./test-scripts";

describe("test scripts", () => {
  it("every script has 3-8 steps with non-empty content and expectation", () => {
    for (const s of TEST_SCRIPTS) {
      expect(s.steps.length, s.id).toBeGreaterThanOrEqual(3);
      expect(s.steps.length, s.id).toBeLessThanOrEqual(8);
      for (const step of s.steps) {
        expect(step.content.trim().length, `${s.id}: empty content`).toBeGreaterThan(0);
        expect(step.expect.trim().length, `${s.id}: empty expectation`).toBeGreaterThan(0);
      }
    }
  });

  it("script ids and labels are unique", () => {
    const ids = TEST_SCRIPTS.map((s) => s.id);
    const labels = TEST_SCRIPTS.map((s) => s.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("adjust steps only appear after at least one say step", () => {
    // the runner anchors adjust feedback to the last assistant reply — an
    // adjust with no prior say would have nothing to anchor to and throw
    for (const s of TEST_SCRIPTS) {
      let said = false;
      for (const step of s.steps) {
        if (step.kind === "say") said = true;
        if (step.kind === "adjust") expect(said, `${s.id}: adjust before any say`).toBe(true);
      }
    }
  });

  it("identity is only set on teach steps", () => {
    for (const s of TEST_SCRIPTS) {
      for (const step of s.steps) {
        if (step.identity) expect(step.kind, `${s.id}: identity on non-teach step`).toBe("teach");
      }
    }
  });
});
