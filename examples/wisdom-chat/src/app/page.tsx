"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { WisdomTree, NodeDetail, type VizDoc } from "@/components/WisdomTree";
import { ChatPane, type AgentInfo } from "@/components/ChatPane";
import { ProposalCard, type ProposalView } from "@/components/ProposalCard";

interface GrowthView {
  id: string;
  status: string;
  newCategories: Array<{ id: string; title?: string }>;
  moved: number;
  regression: { passRate: number; stolen: number } | null;
}

const AGENT_INFO: AgentInfo[] = [
  {
    id: "sage",
    label: "Sage",
    defaultContextMode: "full",
    supportsFeedback: false,
    tagline: "learns about you every 5 messages",
    placeholder:
      "Say hello — talk about what you believe, what you're working toward, what you love.\nSage saves what it learns into the wisdom graph on the left.",
  },
  {
    id: "shop",
    label: "Repair Shop",
    defaultContextMode: "routed",
    supportsFeedback: true,
    tagline: "LangGraph agent · teach it with 👎 Adjust",
    placeholder:
      "Ask about a repair — \"what would a new impeller cost for my Mercury outboard?\"\nThen hit 👎 Adjust on any reply to teach the agent how you want it to respond.",
  },
];

export default function Home() {
  const [agent, setAgent] = useState<AgentInfo>(AGENT_INFO[0]!);
  const [doc, setDoc] = useState<VizDoc | null>(null);
  const [canSleep, setCanSleep] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [pressure, setPressure] = useState<{ open: number; threshold: number } | null>(null);
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [growth, setGrowth] = useState<GrowthView | null>(null);
  const [growthBusy, setGrowthBusy] = useState(false);
  const [hasKey, setHasKey] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const prevIds = useRef<Map<string, Set<string>>>(new Map());

  const refreshGraph = useCallback(async () => {
    const res = await fetch(`/api/graph?agent=${agent.id}`);
    const data = (await res.json()) as {
      doc: VizDoc;
      consolidation?: { recommended: boolean };
      pressure?: { open: number; threshold: number };
      proposal?: ProposalView | null;
      growth?: GrowthView | null;
    };
    const ids = new Set(data.doc.nodes.map((n) => n.id));
    const prev = prevIds.current.get(agent.id);
    const added = new Set([...ids].filter((id) => prev !== undefined && !prev.has(id)));
    prevIds.current.set(agent.id, ids);
    setDoc(data.doc);
    setNewIds(added);
    setCanSleep(data.consolidation?.recommended ?? false);
    setPressure(data.pressure && Number.isFinite(data.pressure.threshold) ? data.pressure : null);
    setProposal(data.proposal ?? null);
    setGrowth(data.growth ?? null);
  }, [agent.id]);

  useEffect(() => {
    setDoc(null);
    setSelectedId(null);
    void refreshGraph();
  }, [refreshGraph]);

  useEffect(() => {
    void fetch("/api/health")
      .then((r) => r.json())
      .then((h: { hasKey: boolean }) => setHasKey(h.hasKey));
  }, []);

  const onGraphChanged = useCallback(
    (toastText: string | null) => {
      void refreshGraph();
      if (toastText) {
        setToast(toastText);
        setTimeout(() => setToast(null), 4500);
      }
    },
    [refreshGraph],
  );

  return (
    <main className="app">
      <section className="panel">
        <header className="panel-header">
          <nav className="tabs">
            {AGENT_INFO.map((a) => (
              <button key={a.id} className={`tab${agent.id === a.id ? " active" : ""}`} onClick={() => setAgent(a)}>
                {a.label}
              </button>
            ))}
            <Link href="/compare" className="tab">
              ⚖ Compare
            </Link>
          </nav>
          <div className="spacer" />
          <span className="sub">
            {doc ? `${doc.nodes.length} nodes · v${doc.version ?? "?"}` : "loading…"}
            {pressure && pressure.open > 0 && (
              <span title="Philosophy-conflict pressure toward a charter amendment">
                {" "}
                · ⚡ {pressure.open}/{pressure.threshold}
              </span>
            )}
          </span>
          <button
            className="small"
            title="Consolidate: merge duplicate rules, retire stale ones, re-rank by reinforcement (the sleep cycle)"
            disabled={!canSleep || sleeping || !hasKey}
            onClick={async () => {
              setSleeping(true);
              try {
                const res = await fetch("/api/consolidate", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ agentId: agent.id }),
                });
                const data = (await res.json()) as {
                  error?: string;
                  categories?: Array<{ merged: number; retired: number; reranked: number }>;
                };
                if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
                const sum = (k: "merged" | "retired" | "reranked") =>
                  (data.categories ?? []).reduce((a, c) => a + c[k], 0);
                onGraphChanged(
                  (data.categories?.length ?? 0) > 0
                    ? `😴 slept — merged ${sum("merged")} · retired ${sum("retired")} · re-ranked ${sum("reranked")}`
                    : "Nothing to consolidate",
                );
              } catch (err) {
                onGraphChanged(`Consolidation failed: ${(err as Error).message}`);
              } finally {
                setSleeping(false);
              }
            }}
          >
            {sleeping ? "😴 sleeping…" : "😴 Consolidate"}
          </button>
        </header>
        {!hasKey && (
          <div className="banner">
            ANTHROPIC_API_KEY is not set — chat is disabled. The graph below is the seed template.
          </div>
        )}
        {doc && (
          <WisdomTree
            doc={doc}
            newIds={newIds}
            selectedId={selectedId}
            onSelect={setSelectedId}
            pulseId={proposal ? (doc.nodes.find((n) => n.parentId === null)?.id ?? null) : null}
          />
        )}
        {proposal && <ProposalCard proposal={proposal} onResolved={onGraphChanged} />}
        {growth && (
          <div className="proposal-card">
            <h2>🌱 Growth proposed <span className="sub">({growth.status})</span></h2>
            <p className="fact">
              {growth.newCategories.map((c) => c.title ?? c.id).join(", ")} — {growth.moved} learnings would move
            </p>
            {growth.regression && (
              <p className="sub">
                regression gate: {(growth.regression.passRate * 100).toFixed(0)}% pass
                {growth.regression.stolen > 0 ? ` · ${growth.regression.stolen} STOLEN — blocked` : ""}
              </p>
            )}
            <div className="proposal-actions">
              <button
                className="small primary"
                disabled={growthBusy || growth.status !== "validated"}
                title={growth.status !== "validated" ? "Blocked: the regression gate did not pass" : "Commit the new categories"}
                onClick={async () => {
                  setGrowthBusy(true);
                  try {
                    const res = await fetch("/api/growth", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ agentId: agent.id, id: growth.id, action: "approve" }),
                    });
                    const data = (await res.json()) as { error?: string; blocked?: boolean };
                    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
                    onGraphChanged(data.blocked ? "Growth blocked by the regression gate" : "🌱 graph grew — new categories committed");
                  } catch (err) {
                    onGraphChanged(`Growth failed: ${(err as Error).message}`);
                  } finally {
                    setGrowthBusy(false);
                  }
                }}
              >
                Approve
              </button>
              <button
                className="small"
                disabled={growthBusy}
                onClick={async () => {
                  setGrowthBusy(true);
                  try {
                    await fetch("/api/growth", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ agentId: agent.id, id: growth.id, action: "reject" }),
                    });
                    onGraphChanged("Growth proposal rejected");
                  } finally {
                    setGrowthBusy(false);
                  }
                }}
              >
                Reject
              </button>
            </div>
          </div>
        )}
        {doc && selectedId && <NodeDetail doc={doc} nodeId={selectedId} />}
      </section>

      <ChatPane agent={agent} hasKey={hasKey} onGraphChanged={onGraphChanged} />

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
