// Cross-language conformance runner. The identical fixtures run against the
// Python runtime (python/packages/apg-core/tests/test_conformance.py); a
// fixture passing in one runtime and failing in the other blocks both.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Graph,
  normalizeDocument,
  validateGraph,
  serializeOutline,
  evalExpr,
  evalRouting,
  route,
  resolveBring,
  compose,
  sessionStep,
  newSession,
  applyChangeset,
  applyEvidenceGate,
  materializeLayers,
  ScriptedLlm,
  MapEmbeddings,
  ScriptedTools,
  type Connectors,
  type GraphDoc,
  type SessionState,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "..", "schema", "conformance", "fixtures");

interface Fixture {
  description: string;
  schemaVersion: string;
  graph?: GraphDoc;
  session?: SessionState;
  vars?: Record<string, unknown>;
  userOverlays?: unknown[];
  mocks?: {
    classify?: Array<{ matches: Array<{ nodeId: string; confidence: number; reason?: string }> }>;
    extract?: Array<{ vars: Record<string, unknown> }>;
    embeddings?: Record<string, number[]>;
    tools?: Record<string, { ok: boolean; result: unknown }>;
  };
  op: { kind: string } & Record<string, unknown>;
  expected?: unknown;
  expectError?: string;
}

/**
 * Recursive subset match: objects match on present keys; arrays match
 * exactly; an explicit null in expected asserts null-or-absent.
 */
function subsetMatch(actual: unknown, expected: unknown, path: string): string[] {
  if (expected === null) {
    return actual === null || actual === undefined ? [] : [`${path}: expected null/absent, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${typeof actual}`];
    if (actual.length !== expected.length) {
      return [`${path}: expected length ${expected.length}, got ${actual.length} — actual: ${JSON.stringify(actual)}`];
    }
    return expected.flatMap((e, i) => subsetMatch(actual[i], e, `${path}[${i}]`));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    }
    return Object.entries(expected).flatMap(([k, v]) =>
      subsetMatch((actual as Record<string, unknown>)[k], v, `${path}.${k}`),
    );
  }
  if (actual !== expected) {
    return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  return [];
}

function connectorsFor(fixture: Fixture): Connectors {
  const connectors: Connectors = {};
  const m = fixture.mocks ?? {};
  if (m.classify || m.extract) {
    const script: ConstructorParameters<typeof ScriptedLlm>[0] = {};
    if (m.classify) script.classify = m.classify;
    if (m.extract) script.extract = m.extract;
    connectors.llm = new ScriptedLlm(script);
  }
  if (m.embeddings) connectors.embeddings = new MapEmbeddings(m.embeddings);
  if (m.tools) connectors.tools = new ScriptedTools(m.tools);
  return connectors;
}

async function runOp(fixture: Fixture): Promise<unknown> {
  const op = fixture.op;
  const rawGraph = fixture.graph;
  const graph = () => new Graph(normalizeDocument(rawGraph!));
  switch (op.kind) {
    case "normalize":
      return { graph: normalizeDocument(rawGraph!) };
    case "validate": {
      const report = validateGraph(normalizeDocument(rawGraph!));
      return { valid: report.valid, errors: report.errors, warnings: report.warnings };
    }
    case "serializeOutline":
      return { outline: serializeOutline(graph(), op["nodeIds"] as string[] | undefined) };
    case "evalExpr":
      return { value: evalExpr(op["expr"] as string, (op["vars"] ?? {}) as Record<string, unknown>) };
    case "route":
      return await route(op["query"] as string, graph(), {
        sessionVars: op["sessionVars"] as Record<string, unknown> | undefined,
        connectors: connectorsFor(fixture),
      });
    case "evalRouting":
      return await evalRouting(graph(), op["labeled"] as never, {
        connectors: connectorsFor(fixture),
        topK: op["topK"] as number | undefined,
        focusNodes: op["focusNodes"] as string[] | undefined,
      });
    case "resolveBring": {
      const r = resolveBring(graph(), op["nodeId"] as string);
      return { brought: r.brought, dangling: r.dangling, tenantBlocked: r.tenantBlocked };
    }
    case "compose": {
      const targets = (op["nodeIds"] as string[] | undefined) ?? [op["nodeId"] as string];
      return compose(graph(), targets, {
        query: op["query"] as string | undefined,
        vars: fixture.vars,
        sessionVars: op["sessionVars"] as Record<string, unknown> | undefined,
        memoryVars: op["memoryVars"] as Record<string, unknown> | undefined,
        tenantVars: op["tenantVars"] as Record<string, unknown> | undefined,
        overlays: fixture.userOverlays as never,
        maxPromptTokens: op["maxPromptTokens"] as number | undefined,
      });
    }
    case "routeAndCompose": {
      const g = graph();
      const routing = await route(op["query"] as string, g, { connectors: connectorsFor(fixture) });
      const prompt = compose(g, routing.matches.map((m) => m.nodeId), {
        query: op["query"] as string,
        vars: fixture.vars,
        overlays: fixture.userOverlays as never,
      });
      return { routing, prompt };
    }
    case "sessionStep": {
      const session = fixture.session ?? newSession("s");
      const result = await sessionStep(graph(), session, op["input"] as never, connectorsFor(fixture));
      return result;
    }
    case "applyChangeset":
      return { graph: applyChangeset(normalizeDocument(rawGraph!), op["ops"] as never) };
    case "evidenceGate":
      return applyEvidenceGate(
        normalizeDocument(rawGraph!),
        op["ops"] as never,
        op["evidence"] as never,
        op["transcripts"] as never
      );
    case "materializeLayers": {
      const r = materializeLayers(normalizeDocument(rawGraph!), op["layers"] as never);
      return { graph: r.doc, conflicts: r.conflicts };
    }
    default:
      throw new Error(`Unknown fixture op kind: ${op.kind}`);
  }
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();

describe("conformance fixtures", () => {
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Fixture;
    it(`${file}: ${fixture.description}`, async () => {
      if (fixture.expectError !== undefined) {
        await expect(runOp(fixture)).rejects.toThrow(fixture.expectError);
        return;
      }
      const actual = await runOp(fixture);
      const expected = fixture.expected as Record<string, unknown>;
      // validate errors/warnings match as a set keyed by (code, nodeId)
      if (fixture.op.kind === "validate") {
        const act = actual as { valid: boolean; errors: Array<{ code: string; nodeId?: string }> };
        const exp = expected as { valid?: boolean; errors?: Array<{ code: string; nodeId?: string }> };
        if (exp.valid !== undefined) expect(act.valid).toBe(exp.valid);
        if (exp.errors !== undefined) {
          const key = (e: { code: string; nodeId?: string }) => `${e.code}::${e.nodeId ?? ""}`;
          expect(new Set(act.errors.map(key))).toEqual(new Set(exp.errors.map(key)));
        }
        return;
      }
      const mismatches = subsetMatch(actual, expected, "$");
      if (mismatches.length > 0) {
        throw new Error(`Fixture mismatch:\n${mismatches.join("\n")}`);
      }
    });
  }
});
