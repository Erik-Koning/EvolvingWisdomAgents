"use client";
// Left-panel dashboard for the ⚖ Compare benchmark: arms overview, mode
// toggle, run-both switch, per-mode aggregate table, cost projection,
// per-message history.
import { useState } from "react";
import type { CompareMessage, CompareMetrics, CompareMode } from "../lib/compare-store";
import { costUsd, fmtUsd } from "../lib/pricing";
import { VET_MODEL } from "../lib/vet-model";

export interface VetMetaInfo {
  monolithChars: number;
  monolithTokensEst: number;
  graphStats: { nodes: number; categories: number; leaves: number };
}

interface Aggregate {
  msgs: number;
  avgTotalMs: number;
  avgGenerateMs: number;
  avgInputTokens: number;
  avgFirstInputTokens: number;
  avgPromptChars: number;
  avgCostUsd: number;
  toolCalls: number;
}

function aggregate(all: CompareMetrics[]): Aggregate | null {
  if (all.length === 0) return null;
  const avg = (f: (m: CompareMetrics) => number) => Math.round(all.reduce((a, m) => a + f(m), 0) / all.length);
  return {
    msgs: all.length,
    avgTotalMs: avg((m) => m.totalMs),
    avgGenerateMs: avg((m) => m.generateMs),
    avgInputTokens: avg((m) => m.inputTokens),
    avgFirstInputTokens: avg((m) => m.firstInputTokens),
    avgPromptChars: avg((m) => m.promptChars),
    avgCostUsd:
      all.reduce((a, m) => a + costUsd(m.inputTokens, m.outputTokens, VET_MODEL.model) + (m.routeCostUsd ?? 0), 0) /
      all.length,
    toolCalls: all.reduce((a, m) => a + m.toolCalls.length, 0),
  };
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Monthly cost projection from this session's measured averages. */
function ProjectionCard({ mono, graph }: { mono: Aggregate | null; graph: Aggregate | null }) {
  const [exp, setExp] = useState(3); // 10^exp messages/month: 100 → 100k
  const volume = Math.round(10 ** exp);
  const monthly = (a: Aggregate | null): number | null => (a ? a.avgCostUsd * volume : null);
  const m = monthly(mono);
  const g = monthly(graph);
  return (
    <div className="projection-card">
      <h4>Monthly projection · {volume.toLocaleString("en-CA")} messages</h4>
      <input
        type="range"
        min={2}
        max={5}
        step={0.1}
        value={exp}
        onChange={(e) => setExp(Number(e.target.value))}
        aria-label="Messages per month"
      />
      <div className="projection-row">
        <span>
          monolith: <strong>{m === null ? "—" : `${fmtUsd(m)}/mo`}</strong>
        </span>
        <span>
          graph: <strong>{g === null ? "—" : `${fmtUsd(g)}/mo`}</strong>
        </span>
      </div>
      {m !== null && g !== null && m > g && (
        <div className="savings-line">graph saves ~{fmtUsd(m - g)}/month at this volume</div>
      )}
      <div className="fairness">
        Projected from this session's measured average cost per message — generation usage plus
        the graph arm's MEASURED routing usage (zero when the embedding fast path skips the
        classify call).
      </div>
    </div>
  );
}

export interface BenchmarkProgress {
  done: number;
  total: number;
  current: string | null;
}

export interface BenchmarkPanelProps {
  meta: VetMetaInfo | null;
  mode: CompareMode;
  runBoth: boolean;
  messages: CompareMessage[];
  onMode: (mode: CompareMode) => void;
  onRunBoth: (v: boolean) => void;
  benchmark: BenchmarkProgress | null;
  canRunBenchmark: boolean;
  onRunBenchmark: () => void;
}

export default function BenchmarkPanel({
  meta,
  mode,
  runBoth,
  messages,
  onMode,
  onRunBoth,
  benchmark,
  canRunBenchmark,
  onRunBenchmark,
}: BenchmarkPanelProps) {
  // every metric record ever produced in this session, incl. run-both alts
  const byMode: Record<CompareMode, CompareMetrics[]> = { monolith: [], graph: [] };
  for (const m of messages) {
    if (m.metrics) byMode[m.metrics.mode].push(m.metrics);
    if (m.alt) byMode[m.alt.metrics.mode].push(m.alt.metrics);
  }
  const mono = aggregate(byMode.monolith);
  const graph = aggregate(byMode.graph);

  const rows: Array<{ label: string; f: (a: Aggregate) => number; fmt?: (n: number) => string; lowerBetter: boolean }> = [
    { label: "messages", f: (a) => a.msgs, lowerBetter: false },
    { label: "avg total ms", f: (a) => a.avgTotalMs, lowerBetter: true },
    { label: "avg generate ms", f: (a) => a.avgGenerateMs, lowerBetter: true },
    { label: "avg input tokens", f: (a) => a.avgInputTokens, fmt: fmtK, lowerBetter: true },
    { label: "avg first-call input", f: (a) => a.avgFirstInputTokens, fmt: fmtK, lowerBetter: true },
    { label: "avg prompt chars", f: (a) => a.avgPromptChars, fmt: fmtK, lowerBetter: true },
    { label: "avg cost / msg", f: (a) => a.avgCostUsd, fmt: fmtUsd, lowerBetter: true },
    { label: "tool calls", f: (a) => a.toolCalls, lowerBetter: false },
  ];

  return (
    <div>
      <div className="arms-card">
        <div className="arm">
          <h4>Monolith · no library</h4>
          <div className="big">{meta ? `${fmtK(meta.monolithChars)} chars` : "…"}</div>
          <div className="sub-line">{meta ? `~${fmtK(meta.monolithTokensEst)} tokens est, every request` : ""}</div>
        </div>
        <div className="arm">
          <h4>Graph · routed compose</h4>
          <div className="big">{meta ? `${meta.graphStats.nodes} nodes` : "…"}</div>
          <div className="sub-line">
            {meta ? `${meta.graphStats.categories} categories · ${meta.graphStats.leaves} knowledge leaves` : ""}
          </div>
        </div>
      </div>

      <div className="toggle">
        {(["monolith", "graph"] as CompareMode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => onMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={runBoth} onChange={(e) => onRunBoth(e.target.checked)} />
        Run both on next send (side-by-side; only the {mode} reply joins the conversation)
      </label>

      <p className="fairness">
        Same model, temperature, tools, and history in both arms — only the system prompt
        differs. The graph arm pays one extra routing call (shown as route ms); neither arm
        uses prompt caching. History grows identically for both, so watch first-call input
        tokens and prompt chars for the cleanest delta.
      </p>

      <button className="benchmark-btn" disabled={!canRunBenchmark} onClick={onRunBenchmark}>
        ▶ Run full benchmark — all 8 probes through both arms (≈2 min, ≈$1.50 of API usage)
      </button>
      {benchmark && benchmark.current !== null && (
        <div className="benchmark-progress">
          probe {benchmark.done + 1}/{benchmark.total}: {benchmark.current}
        </div>
      )}
      {benchmark && benchmark.current === null && (
        <div className="savings-line">✓ benchmark complete — the table and projection above are the scorecard</div>
      )}

      <table className="metric-table">
        <thead>
          <tr>
            <th></th>
            <th>monolith</th>
            <th>graph</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const a = mono ? r.f(mono) : null;
            const b = graph ? r.f(graph) : null;
            const fmt = r.fmt ?? String;
            const best = (v: number | null, other: number | null): boolean =>
              r.lowerBetter && v !== null && other !== null && v < other;
            return (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className={best(a, b) ? "best" : ""}>{a === null ? "—" : fmt(a)}</td>
                <td className={best(b, a) ? "best" : ""}>{b === null ? "—" : fmt(b)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ProjectionCard mono={mono} graph={graph} />

      <div className="history-list">
        {messages
          .filter((m) => m.role === "assistant" && m.metrics)
          .map((m, i) => {
            const userMsg = messages[messages.indexOf(m) - 1];
            return (
              <div className="history-row" key={i}>
                <span className={`badge mode-${m.metrics!.mode}`}>{m.metrics!.mode}</span>
                <span className="q">{userMsg?.content ?? ""}</span>
                <span>{m.metrics!.totalMs} ms</span>
                <span>
                  in {fmtK(m.metrics!.inputTokens)} / out {fmtK(m.metrics!.outputTokens)}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}
