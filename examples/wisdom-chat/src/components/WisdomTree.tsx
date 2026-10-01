"use client";
// Node-link tidy tree of the wisdom graph. Layout by d3-hierarchy; rendering
// is our own SVG. Categorical color is assigned to top-level categories in
// fixed slot order and inherited by their knowledge leaves (color follows the
// entity); every node carries a visible ink-token label (the relief rule for
// the sub-3:1 light-mode slots). Links are recessive hairlines; seeAlso
// cross-links are dashed; new nodes animate in.
import { useMemo, useState } from "react";
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";

export interface VizNode {
  id: string;
  parentId: string | null;
  title?: string;
  routable?: boolean;
  props?: Record<string, unknown>;
  prompt?: { slots?: Record<string, string> } | string;
  isFallback?: boolean;
}

export interface VizDoc {
  version?: string;
  nodes: VizNode[];
  edges?: Array<{ from: string; to: string; kind: string }>;
}

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

interface TreeDatum {
  node: VizNode;
  children: TreeDatum[];
}

/** A leaf's learned text, whichever slot it lives in — knowledge facts (harvest)
 *  or constraints/examples rules (feedback). Mirrors wisdom.ts learnedText. */
function learnedText(node: VizNode): string | undefined {
  if (typeof node.prompt !== "object" || node.prompt === null) return undefined;
  const slots = node.prompt.slots ?? {};
  return slots["knowledge"] ?? slots["constraints"] ?? slots["examples"];
}

function label(node: VizNode): string {
  if (node.title) return node.title;
  // long rules carry an authored ≤10-word summary label — prefer it to truncation
  const authored = node.props?.["label"];
  if (typeof authored === "string" && authored.length > 0) {
    return authored.length > 46 ? `${authored.slice(0, 46)}…` : authored;
  }
  const text = learnedText(node);
  if (text) return text.length > 46 ? `${text.slice(0, 46)}…` : text;
  return node.id;
}

export function WisdomTree({
  doc,
  newIds,
  selectedId,
  onSelect,
  pulseId = null,
}: {
  doc: VizDoc;
  newIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Node drawn with a pulsing ring (e.g. the root while an amendment is pending). */
  pulseId?: string | null;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const { layout, colorOf, seeAlso, width, height } = useMemo(() => {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const childrenOf = new Map<string, VizNode[]>();
    let root: VizNode | undefined;
    for (const n of doc.nodes) {
      if (n.parentId === null) root = n;
      else {
        const list = childrenOf.get(n.parentId) ?? [];
        list.push(n);
        childrenOf.set(n.parentId, list);
      }
    }
    const build = (node: VizNode): TreeDatum => ({
      node,
      children: (childrenOf.get(node.id) ?? []).map(build),
    });
    const datum = root ? build(root) : { node: { id: "?", parentId: null }, children: [] };

    // fixed-order categorical assignment to top-level categories, inherited below
    const colorOf = new Map<string, string>();
    (childrenOf.get(root?.id ?? "") ?? []).forEach((cat, i) => {
      const color = SERIES[i % SERIES.length]!;
      const paint = (id: string) => {
        colorOf.set(id, color);
        for (const child of childrenOf.get(id) ?? []) paint(child.id);
      };
      paint(cat.id);
    });

    const h = hierarchy<TreeDatum>(datum);
    const leafCount = h.leaves().length;
    const height = Math.max(320, leafCount * 30 + 60);
    const width = 560;
    // horizontal tree: x becomes vertical position, y becomes depth
    const layout = tree<TreeDatum>().size([height - 40, width - 240])(h);
    const seeAlso = (doc.edges ?? []).filter((e) => e.kind === "seeAlso");
    return { layout, colorOf, seeAlso, width, height };
  }, [doc]);

  const positions = new Map<string, HierarchyPointNode<TreeDatum>>();
  layout.each((d) => positions.set(d.data.node.id, d));

  const link = (d: HierarchyPointNode<TreeDatum>) => {
    const p = d.parent!;
    const x0 = p.y + 24;
    const y0 = p.x;
    const x1 = d.y + 24;
    const y1 = d.x;
    const mx = (x0 + x1) / 2;
    return `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  };

  return (
    <div className="tree-wrap">
      <svg
        className="tree-svg"
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Wisdom graph: categories and learned knowledge"
        onClick={() => onSelect(null)}
      >
        <g transform="translate(8, 20)">
          {/* structural links: recessive hairlines */}
          {layout
            .descendants()
            .filter((d) => d.parent)
            .map((d) => (
              <path
                key={`l-${d.data.node.id}`}
                d={link(d)}
                fill="none"
                stroke="var(--hairline)"
                strokeWidth={1.5}
              />
            ))}
          {/* seeAlso cross-links: dashed, muted */}
          {seeAlso.map((e, i) => {
            const from = positions.get(e.from);
            const to = positions.get(e.to);
            if (!from || !to) return null;
            const x0 = from.y + 24;
            const x1 = to.y + 24;
            const bow = 26 + Math.abs(from.x - to.x) * 0.1;
            return (
              <path
                key={`sa-${i}`}
                d={`M${x0},${from.x} C${x0 + bow},${from.x} ${x1 + bow},${to.x} ${x1},${to.x}`}
                fill="none"
                stroke="var(--baseline)"
                strokeWidth={1.2}
                strokeDasharray="4 3"
              />
            );
          })}
          {/* nodes */}
          {layout.descendants().map((d) => {
            const node = d.data.node;
            const isRoot = node.parentId === null;
            const isKnowledge = node.routable === false && !isRoot;
            const color = colorOf.get(node.id) ?? "var(--text-muted)";
            const r = isRoot ? 8 : isKnowledge ? 4.5 : 7;
            const selected = selectedId === node.id;
            const hovered = hoverId === node.id;
            const kids = d.children?.length ?? 0;
            return (
              <g
                key={node.id}
                className={`tree-node${newIds.has(node.id) ? " entering" : ""}`}
                transform={`translate(${d.y + 24}, ${d.x})`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect(selected ? null : node.id);
                }}
                onMouseEnter={() => setHoverId(node.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                {/* hit target larger than the mark */}
                <circle r={14} fill="transparent" />
                {pulseId === node.id && (
                  <circle className="pulse-ring" r={r + 5} fill="none" stroke="var(--accent)" strokeWidth={2} />
                )}
                {(selected || hovered) && (
                  <circle r={r + 4} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={2} />
                )}
                <circle
                  r={r}
                  fill={isKnowledge ? "var(--surface-1)" : isRoot ? "var(--text-muted)" : color}
                  stroke={isKnowledge ? color : "var(--surface-1)"}
                  strokeWidth={2}
                />
                <text
                  className={isKnowledge ? "leaf-label" : "node-label"}
                  x={isKnowledge ? 12 : 0}
                  y={isKnowledge ? 4 : -13}
                  textAnchor={isKnowledge ? "start" : "middle"}
                >
                  {label(node)}
                </text>
                {!isKnowledge && !isRoot && kids > 0 && (
                  <text className="count-label" y={22} textAnchor="middle">
                    {kids} {kids === 1 ? "fact" : "facts"}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export function NodeDetail({ doc, nodeId }: { doc: VizDoc; nodeId: string }) {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const fact = learnedText(node);
  const props = Object.entries(node.props ?? {});
  return (
    <div className="detail-card">
      <h2>
        <span className="dot" style={{ background: "var(--accent)" }} />
        {node.title ?? node.id}
      </h2>
      {fact && <p className="fact">{fact}</p>}
      {typeof node.props?.["learn"] === "string" && !fact && (
        <p className="fact" style={{ color: "var(--text-secondary)" }}>
          Learns: {String(node.props["learn"])}
        </p>
      )}
      <dl>
        <dt>id</dt>
        <dd>{node.id}</dd>
        {props
          .filter(([k]) => k !== "learn")
          .map(([k, v]) => (
            <FragmentRow key={k} k={k} v={v} />
          ))}
      </dl>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
    </>
  );
}
