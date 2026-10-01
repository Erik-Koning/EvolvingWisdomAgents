// The changeset lifecycle — the L5 governance pipeline as pure kernel
// functions: draft → validated → approved → committed | discarded. Validation
// is a dry apply + structural report + optional routing regression; commit IS
// applyChangeset (already conformance-pinned) and only proceeds from
// "approved" (or "validated" with the explicit user-scope autoApprove flag,
// per the design doc's scope-graduated rules).
import type { Changeset, GraphDoc, LabeledQuery, MutationOp, ValidationReport } from "@apgraph/schema";
import { Graph } from "./graph.js";
import { applyChangeset } from "./mutation.js";
import { validateGraph } from "./validator.js";
import { evalRouting } from "./regress.js";
import type { Connectors } from "./connectors.js";

export interface ValidateChangesetOptions {
  /** Run the routing-regression gate on the RESULT graph. */
  labeled?: LabeledQuery[];
  connectors?: Connectors;
  topK?: number;
  /** Regression pass rate required for "validated" (default 1). */
  minPassRate?: number;
  /** Traffic-steal attribution set; defaults to node ids the ops touch. */
  focusNodes?: string[];
}

function transition(cs: Changeset, verb: string, from: Changeset["status"][]): void {
  if (!from.includes(cs.status)) {
    throw new Error(`Cannot ${verb} changeset in status "${cs.status}"`);
  }
}

/** Append ops to a draft. */
export function addOps(cs: Changeset, ops: MutationOp[]): Changeset {
  transition(cs, "add ops to", ["draft"]);
  return { ...cs, ops: [...cs.ops, ...ops] };
}

/** Node ids a changeset's ops create or modify (default traffic-steal focus). */
export function changesetFocusNodes(cs: Changeset): string[] {
  const focus = new Set<string>();
  for (const op of cs.ops) {
    if (op.op === "addNode") focus.add(op.node.id);
    if (op.op === "graftSubtree") for (const n of op.nodes) focus.add(n.id);
    if (op.op === "updateNode" || op.op === "moveNode" || op.op === "setBring") focus.add(op.id);
    if (op.op === "mergeNodes") focus.add(op.intoId);
    if (op.op === "splitNode") for (const p of op.partitions) focus.add(p.node.id);
  }
  return [...focus];
}

/**
 * Dry-apply + structural validation (+ optional regression gate). Returns the
 * changeset with reports attached; status becomes "validated" only when
 * everything passes — otherwise it stays "draft" with the failure recorded.
 */
export async function validateChangeset(
  doc: GraphDoc,
  cs: Changeset,
  opts: ValidateChangesetOptions = {},
): Promise<Changeset> {
  transition(cs, "validate", ["draft", "validated"]);
  let validation: ValidationReport;
  let resultDoc: GraphDoc | null = null;
  try {
    resultDoc = applyChangeset(doc, cs.ops); // throws on op failure or invalid result
    validation = { valid: true, errors: [], warnings: [] };
  } catch (err) {
    validation = {
      valid: false,
      errors: [{ code: "CHANGESET_APPLY_FAILED", message: (err as Error).message }],
      warnings: [],
    };
  }
  // structural detail even on success (warnings etc.)
  if (resultDoc) validation = validateGraph(resultDoc);

  let regression: Changeset["regression"];
  let regressionPassed = true;
  if (resultDoc && opts.labeled && opts.labeled.length > 0) {
    if (!opts.connectors) throw new Error("validateChangeset regression requires connectors");
    const report = await evalRouting(new Graph(resultDoc), opts.labeled, {
      connectors: opts.connectors,
      topK: opts.topK ?? 1,
      focusNodes: opts.focusNodes ?? changesetFocusNodes(cs),
    });
    regression = report as unknown as Record<string, unknown>;
    regressionPassed = report.passRate >= (opts.minPassRate ?? 1);
  }

  return {
    ...cs,
    validation,
    ...(regression !== undefined ? { regression } : {}),
    status: validation.valid && regressionPassed ? "validated" : "draft",
  };
}

/** The human gate. */
export function approveChangeset(cs: Changeset): Changeset {
  transition(cs, "approve", ["validated"]);
  return { ...cs, status: "approved" };
}

/**
 * Commit = the pinned applyChangeset, gated by status. autoApprove permits
 * committing straight from "validated" (user-scope semantics).
 */
export function commitChangeset(
  doc: GraphDoc,
  cs: Changeset,
  opts: { autoApprove?: boolean } = {},
): { doc: GraphDoc; changeset: Changeset } {
  transition(cs, "commit", opts.autoApprove ? ["approved", "validated"] : ["approved"]);
  const next = applyChangeset(doc, cs.ops);
  return { doc: next, changeset: { ...cs, status: "committed" } };
}

export function discardChangeset(cs: Changeset): Changeset {
  transition(cs, "discard", ["draft", "validated", "approved"]);
  return { ...cs, status: "discarded" };
}
