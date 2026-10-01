"use client";
// Charter-amendment review: the human gate every root change passes through,
// regardless of transcendence score. Shows the per-slot diff, the rationale,
// the evidence that built the pressure, and the measured drift.
import { useState } from "react";

export interface ProposalView {
  id: string;
  source: "pressure" | "edict";
  label: string;
  rationale: string;
  changes: Record<string, { old: string; next: string }>;
  evidence: Array<{ nodeId?: string; note: string }>;
  drift: Record<string, number>;
  at: string;
}

export function ProposalCard({
  proposal,
  onResolved,
}: {
  proposal: ProposalView;
  onResolved: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function resolve(action: "approve" | "reject") {
    setBusy(true);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}/${action}`, { method: "POST" });
      const data = (await res.json()) as { error?: string; proposal?: { status: string } };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      const status = data.proposal?.status;
      onResolved(
        status === "approved"
          ? `🧬 charter amended — ${proposal.label}`
          : status === "invalidated"
            ? "Proposal invalidated: the charter changed since it was drafted"
            : "Proposal rejected — charter stands",
      );
    } catch (err) {
      onResolved(`Amendment failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="proposal-card">
      <h2>
        🧬 Charter amendment proposed <span className="sub">({proposal.source})</span>
      </h2>
      <p className="fact">{proposal.label}</p>
      {Object.entries(proposal.changes).map(([slot, change]) => (
        <div key={slot} className="diff">
          <div className="diff-slot">
            {slot} <span className="sub">drift-similarity {proposal.drift[slot]?.toFixed(2) ?? "?"}</span>
          </div>
          <div className="diff-old">− {change.old}</div>
          <div className="diff-new">+ {change.next}</div>
        </div>
      ))}
      <p className="sub rationale">{proposal.rationale}</p>
      <details>
        <summary className="sub">evidence ({proposal.evidence.length})</summary>
        <ul className="sub">
          {proposal.evidence.map((e, i) => (
            <li key={i}>{e.note}</li>
          ))}
        </ul>
      </details>
      <div className="proposal-actions">
        <button className="small primary" disabled={busy} onClick={() => void resolve("approve")}>
          Approve
        </button>
        <button className="small" disabled={busy} onClick={() => void resolve("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}
