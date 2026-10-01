// Deep sleep — the Loop-3 growth stage: when the fallback category (the
// misfit pool) fills up, cluster its learnings, ask the LLM to name coherent
// clusters, and propose NEW subcategories as a lifecycle changeset draft —
// validated against the graph's meta.regression labeled set PLUS the misfit
// exemplars (which must route to their proposed home), human-approved before
// commit. Clustering uses real embeddings when available, else a
// deterministic bag-of-words cosine (demo-grade, flagged in the result).
import {
  Graph,
  addOps,
  buildSplitOps,
  clusterBySimilarity,
  createChangeset,
  labeledFromMeta,
  medoid,
  validateChangeset,
  type Changeset,
  type GraphDoc,
  type LabeledQuery,
} from "@apgraph/core";
import { depNow, type MemoryDeps } from "./deps.js";
import { bagOfWordsVectors, learnedText } from "./ops.js";
import { nowIso } from "./state.js";
import type { GrowthPolicy } from "./policy.js";

export interface GrowthResult {
  changesetId: string;
  status: Changeset["status"];
  vectorMode: "semantic" | "lexical";
  newCategories: Array<{ id: string; title: string; take: number }>;
  regression: { passRate: number; stolen: number } | null;
}

interface ClusterReview {
  clusters?: Array<{ index: number; title: string; learn: string; slug: string }>;
}

/**
 * Propose growth for the graph's misfit pool. Returns null when the pool is
 * small, clustering finds nothing coherent, or the LLM declines to name any
 * cluster. Never mutates the graph — the draft awaits human approval.
 */
export async function maybeGrow(
  deps: MemoryDeps,
  doc: GraphDoc,
  graph: Graph,
  policy: GrowthPolicy
): Promise<GrowthResult | null> {
  const pool = graph.dfs().find((n) => n.isFallback === true && n.routable !== false);
  if (!pool) return null;
  const residents = (graph.get(pool.id).bring ?? []).filter((id) => graph.has(id));
  if (residents.length < policy.min) return null;

  const texts = residents.map((id) => learnedText(graph, id));
  const vectorMode: GrowthResult["vectorMode"] = deps.embeddings ? "semantic" : "lexical";
  const vectors = deps.embeddings ? await deps.embeddings.embed(texts) : bagOfWordsVectors(texts);
  const clusters = clusterBySimilarity(vectors, {
    threshold: vectorMode === "semantic" ? policy.semanticThreshold : policy.lexicalThreshold,
    minSize: policy.minSize,
  });
  if (clusters.length === 0) return null;

  // one LLM call names the coherent clusters (declining is a valid answer)
  const schema = {
    type: "object",
    required: ["clusters"],
    properties: {
      clusters: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "title", "learn", "slug"],
          properties: {
            index: { type: "number", enum: clusters.map((_, i) => i) },
            title: { type: "string", description: "Category title for this theme." },
            learn: { type: "string", description: "What this category wants learned (props.learn guidance)." },
            slug: { type: "string", description: "kebab-case id fragment, e.g. 'boat-storage'" },
          },
        },
      },
    },
  };
  const text = [
    "These clusters of learnings accumulated in the misfit pool — none fit the existing categories. For each cluster that is a COHERENT THEME deserving its own category, name it. Skip incoherent clusters (returning none is a valid answer).",
    "",
    ...clusters.map((cluster, i) =>
      [`Cluster ${i} (medoid: "${texts[medoid(vectors, cluster)]}"):`, ...cluster.map((j) => `- ${texts[j]}`)].join("\n")
    ),
  ].join("\n");
  if (!deps.llm.extract) throw new Error("maybeGrow requires an LlmConnector with extract()");
  const review = (await deps.llm.extract({ text, schema })) as ClusterReview;
  const named = (review.clusters ?? []).filter(
    (c) => Number.isInteger(c.index) && c.index >= 0 && c.index < clusters.length && c.title?.trim() && c.slug?.trim()
  );
  if (named.length === 0) return null;

  const usedIds = new Set(graph.dfs().map((n) => n.id));
  const groups = named
    .map((c) => {
      const id = `cat-${c.slug.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
      if (usedIds.has(id)) return null;
      usedIds.add(id);
      return {
        newCategory: {
          id,
          parentId: pool.id,
          type: "category" as const,
          title: c.title.trim(),
          props: { learn: c.learn?.trim() || c.title.trim() },
        },
        take: clusters[c.index]!.map((j) => residents[j]!),
        exemplar: texts[medoid(vectors, clusters[c.index]!)]!,
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);
  if (groups.length === 0) return null;

  // draft → validate with the regression gate: the graph's labeled set plus
  // the misfit exemplars, which must now route to their proposed home
  const ops = buildSplitOps(graph, pool.id, groups);
  let cs = createChangeset(doc, "deep-sleep", `grow-${depNow(deps).toString(36)}`);
  cs = addOps(cs, ops);
  cs = { ...cs, createdAt: nowIso(deps) };
  const labeled: LabeledQuery[] = [
    ...labeledFromMeta(graph),
    ...groups.map((g) => ({ query: g.exemplar, expected: g.newCategory.id })),
  ];
  cs = await validateChangeset(doc, cs, {
    labeled,
    connectors: { llm: deps.llm }, // the same driver that named the clusters routes the gate
    focusNodes: groups.map((g) => g.newCategory.id),
  });
  await deps.changesets.put(cs);

  const regression = cs.regression as { passRate: number; stolen: unknown[] } | undefined;
  return {
    changesetId: cs.id,
    status: cs.status,
    vectorMode,
    newCategories: groups.map((g) => ({ id: g.newCategory.id, title: g.newCategory.title!, take: g.take.length })),
    regression: regression ? { passRate: regression.passRate, stolen: regression.stolen.length } : null,
  };
}
