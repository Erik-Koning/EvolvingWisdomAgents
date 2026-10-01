// Routing-regression harness — the evolution brake system (§10, design doc):
// after any structural change, labeled queries must still route home, and
// changed nodes must not poach queries that belonged to siblings (traffic
// steal). Deterministic: queries evaluate sequentially in input order (one
// classifier call each), so mock queues line up one-to-one.
import type { LabeledQuery, NodeId, RegressionReport } from "@apgraph/schema";
import { Graph } from "./graph.js";
import { route } from "./router.js";
import type { Connectors } from "./connectors.js";

export interface EvalRoutingOptions {
  connectors: Connectors;
  /** Pass when the expected node is within the top-K gated matches (default 1). */
  topK?: number;
  /** Nodes this changeset added/changed — failures they win are "stolen". */
  focusNodes?: NodeId[];
  /** Session vars for entryCondition gating during evaluation. */
  sessionVars?: Record<string, unknown>;
}

export async function evalRouting(
  graph: Graph,
  labeled: LabeledQuery[],
  opts: EvalRoutingOptions,
): Promise<RegressionReport> {
  const topK = opts.topK ?? 1;
  const focus = new Set(opts.focusNodes ?? []);
  const report: RegressionReport = { total: labeled.length, passed: 0, passRate: 1, failed: [], stolen: [] };

  for (const { query, expected } of labeled) {
    const routing = await route(query, graph, {
      connectors: opts.connectors,
      ...(opts.sessionVars ? { sessionVars: opts.sessionVars } : {}),
    });
    // a query that fell back has lost its home — never a pass
    const matches = routing.fallbackUsed ? [] : routing.matches;
    if (matches.slice(0, topK).some((m) => m.nodeId === expected)) {
      report.passed += 1;
      continue;
    }
    const got = matches[0]?.nodeId ?? null;
    const entry: RegressionReport["failed"][number] = { query, expected, got };
    if (matches[0]?.confidence !== undefined) entry.confidence = matches[0].confidence;
    report.failed.push(entry);
    if (got !== null && focus.has(got)) {
      report.stolen.push({ query, expected, stolenBy: got });
    }
  }

  report.passRate = report.total === 0 ? 1 : report.passed / report.total;
  return report;
}

/** The lifecycle gate: throw a summarized error when the graph regressed. */
export function assertRegression(report: RegressionReport, opts: { minPassRate?: number } = {}): void {
  const min = opts.minPassRate ?? 1;
  if (report.passRate >= min) return;
  const examples = report.failed
    .slice(0, 3)
    .map((f) => `"${f.query}" expected ${f.expected}, got ${f.got ?? "fallback"}`)
    .join("; ");
  const steal = report.stolen.length > 0 ? ` (${report.stolen.length} stolen by changed nodes)` : "";
  throw new Error(
    `Routing regression failed: ${report.passed}/${report.total} passed${steal} — ${examples}`,
  );
}

/** The portable labeled set carried in graph meta (learning convention). */
export function labeledFromMeta(graph: Graph): LabeledQuery[] {
  const raw = graph.doc.meta?.["regression"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is LabeledQuery =>
      typeof e === "object" && e !== null && typeof (e as LabeledQuery).query === "string" &&
      typeof (e as LabeledQuery).expected === "string",
  );
}
