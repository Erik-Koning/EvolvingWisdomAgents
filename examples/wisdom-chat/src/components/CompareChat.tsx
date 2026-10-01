"use client";
// Chat pane for the ⚖ Compare benchmark. Renders per-reply metrics (mode,
// tools, timing, real token usage, routing chips) and the exact system prompt
// behind an expandable details block; "run both" turns render side-by-side.
import { useEffect, useRef, useState } from "react";
import type { CompareMessage, CompareMetrics } from "../lib/compare-store";
import { SAMPLE_QUESTIONS, type SampleQuestion } from "../lib/sample-questions";
import { costUsd, fmtUsd } from "../lib/pricing";
import { VET_MODEL } from "../lib/vet-model";

const fmtK = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n >= 1000 ? `${(n / 1000).toFixed(2)}k` : String(n));

function timingLabel(m: CompareMetrics): string {
  const parts: string[] = [];
  if (m.routeMs !== undefined) parts.push(`route ${m.routeMs}`);
  if (m.composeMs !== undefined) parts.push(`compose ${m.composeMs}`);
  parts.push(`generate ${m.generateMs}`);
  return `${parts.join(" · ")} ms`;
}

function MetricsBadges({ metrics }: { metrics: CompareMetrics }) {
  const total = Math.max(1, (metrics.routeMs ?? 0) + (metrics.composeMs ?? 0) + metrics.generateMs);
  return (
    <>
      <div className="badges assistant-meta">
        <span className={`badge mode-${metrics.mode}`}>{metrics.mode}</span>
        {metrics.routedTo?.map((r) => (
          <span key={r.nodeId} className="badge" title={r.nodeId}>
            {r.fallback ? "fallback" : `${r.title ?? r.nodeId} · ${Math.round(r.confidence * 100)}%`}
          </span>
        ))}
        {metrics.toolCalls.map((t, i) => (
          <span key={`${t.tool}-${i}`} className="badge tool" title={JSON.stringify(t.args)}>
            ⚙ {t.tool}
          </span>
        ))}
        <span
          className="badge stats"
          title={
            metrics.routeModel
              ? `route: ${metrics.routeMethod === "embedding" ? "embedding fast path (no LLM call)" : `classify via ${metrics.routeModel}`}${metrics.routeInputTokens ? ` · ${metrics.routeInputTokens} route tokens` : ""}`
              : undefined
          }
        >
          {metrics.routeMethod === "embedding" ? "⚡ " : ""}
          {timingLabel(metrics)}
        </span>
        <span className="badge stats" title={`prompt ${fmtK(metrics.promptChars)} chars (~${fmtK(metrics.promptTokensEst)} tokens est) · ${metrics.llmCalls} LLM call${metrics.llmCalls === 1 ? "" : "s"}`}>
          in {fmtK(metrics.inputTokens)} (first {fmtK(metrics.firstInputTokens)}) · out {fmtK(metrics.outputTokens)}
        </span>
        <span
          className="badge stats"
          title={
            metrics.routeCostUsd !== undefined
              ? `generation + measured routing (${fmtUsd(metrics.routeCostUsd)} route)`
              : "generation usage (monolith pays no routing)"
          }
        >
          ~{fmtUsd(costUsd(metrics.inputTokens, metrics.outputTokens, VET_MODEL.model) + (metrics.routeCostUsd ?? 0))}
        </span>
        {metrics.truncatedCount > 0 && <span className="badge">⚠ truncated ×{metrics.truncatedCount}</span>}
      </div>
      <div className="time-bar" title={timingLabel(metrics)}>
        {metrics.routeMs !== undefined && <div className="seg-route" style={{ width: `${(metrics.routeMs / total) * 100}%` }} />}
        {metrics.composeMs !== undefined && <div className="seg-compose" style={{ width: `${(metrics.composeMs / total) * 100}%` }} />}
        <div className="seg-generate" style={{ width: `${(metrics.generateMs / total) * 100}%` }} />
      </div>
      <details className="prompt-details">
        <summary>system prompt · {fmtK(metrics.promptChars)} chars</summary>
        <pre>{metrics.promptText}</pre>
      </details>
    </>
  );
}

function DeltaLine({ a, b }: { a: CompareMetrics; b: CompareMetrics }) {
  const graph = a.mode === "graph" ? a : b;
  const mono = a.mode === "graph" ? b : a;
  if (!graph || !mono || graph.mode === mono.mode) return null;
  const tokenDelta = mono.firstInputTokens > 0 ? Math.round((1 - graph.firstInputTokens / mono.firstInputTokens) * 100) : 0;
  const msDelta = graph.totalMs - mono.totalMs;
  return (
    <div className="delta-line">
      graph: {tokenDelta >= 0 ? "−" : "+"}
      {Math.abs(tokenDelta)}% first-call input tokens · {msDelta >= 0 ? "+" : "−"}
      {Math.abs(msDelta)} ms total{graph.routeMs !== undefined ? ` (route ${graph.routeMs} ms)` : ""}
    </div>
  );
}

function SideBySide({ message }: { message: CompareMessage }) {
  if (!message.metrics || !message.alt) return null;
  const cols: Array<{ label: string; reply: string; metrics: CompareMetrics; active: boolean }> = [
    { label: `${message.metrics.mode} (in conversation)`, reply: message.content, metrics: message.metrics, active: true },
    { label: message.alt.metrics.mode, reply: message.alt.reply, metrics: message.alt.metrics, active: false },
  ];
  return (
    <div className="compare-card">
      <div className="compare-cols">
        {cols.map((c) => (
          <div key={c.label} className={`compare-col${c.active ? " active" : ""}`}>
            <div className="col-head">
              <span className={`badge mode-${c.metrics.mode}`}>{c.label}</span>
            </div>
            <div className="col-reply">{c.reply}</div>
            <MetricsBadges metrics={c.metrics} />
          </div>
        ))}
      </div>
      <DeltaLine a={message.metrics} b={message.alt.metrics} />
    </div>
  );
}

function SampleChips({ onSample, disabled }: { onSample: (s: SampleQuestion) => void; disabled: boolean }) {
  return (
    <div className="chips">
      {SAMPLE_QUESTIONS.map((s) => (
        <button key={s.question} className="chip" title={s.proves} disabled={disabled} onClick={() => onSample(s)}>
          {s.runBoth ? "⚖ " : ""}
          {s.question}
        </button>
      ))}
    </div>
  );
}

export interface CompareChatProps {
  messages: CompareMessage[];
  busy: boolean;
  hasKey: boolean;
  onSend: (text: string) => void;
  onSample: (s: SampleQuestion) => void;
}

export default function CompareChat({ messages, busy, hasKey, onSend, onSample }: CompareChatProps) {
  const [draft, setDraft] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, busy]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
  };

  return (
    <>
      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <>
            <div className="msg note">
              Ask Cedar Grove Veterinary Clinic anything, or pick a probe below — each one is
              designed to expose a difference between the monolith prompt and the routed graph
              (hover a chip to see what it proves; ⚖ chips run both arms side by side).
            </div>
            <SampleChips onSample={onSample} disabled={!hasKey || busy} />
          </>
        )}
        {messages.length > 0 && (
          <details className="prompt-details samples-details">
            <summary>sample questions</summary>
            <SampleChips onSample={onSample} disabled={!hasKey || busy} />
          </details>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div>{m.role === "assistant" && m.alt ? null : m.content}</div>
            {m.role === "assistant" && !m.alt && m.metrics && <MetricsBadges metrics={m.metrics} />}
            {m.role === "assistant" && m.alt && <SideBySide message={m} />}
          </div>
        ))}
        {busy && <div className="msg note">Juniper is thinking…</div>}
      </div>
      <div className="chat-input">
        <textarea
          value={draft}
          placeholder={hasKey ? "Message the clinic…" : "Set ANTHROPIC_API_KEY to chat"}
          disabled={!hasKey || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={!hasKey || busy || !draft.trim()}>
          Send
        </button>
      </div>
    </>
  );
}
