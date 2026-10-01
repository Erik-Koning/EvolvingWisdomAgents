"use client";
// ⚖ Compare — the same vet-clinic chatbot two ways: one giant monolith prompt
// vs the graph library's route-then-compose. Everything else identical.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "./compare.css";
import BenchmarkPanel, { type VetMetaInfo } from "../../components/BenchmarkPanel";
import CompareChat from "../../components/CompareChat";
import type { CompareMessage, CompareMode, CompareSession } from "../../lib/compare-store";
import { SAMPLE_QUESTIONS, type SampleQuestion } from "../../lib/sample-questions";

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
}

export default function ComparePage() {
  const [meta, setMeta] = useState<VetMetaInfo | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [mode, setMode] = useState<CompareMode>("graph");
  const [runBoth, setRunBoth] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [messages, setMessages] = useState<CompareMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<{ done: number; total: number; current: string | null } | null>(null);

  useEffect(() => {
    void fetch("/api/compare/meta")
      .then((r) => r.json())
      .then((j) => setMeta(j.error ? null : (j as VetMetaInfo)))
      .catch(() => setMeta(null));
    void fetch("/api/health")
      .then((r) => r.json())
      .then((j: Record<string, unknown>) => {
        const flag = j["hasKey"] ?? j["anthropic"] ?? j["ok"];
        setHasKey(flag !== false);
      })
      .catch(() => setHasKey(true));
    void refreshSessions();
  }, []);

  const refreshSessions = async () => {
    try {
      const j = (await (await fetch("/api/compare/sessions")).json()) as { sessions?: SessionSummary[] };
      setSessions(j.sessions ?? []);
    } catch {
      /* list is cosmetic */
    }
  };

  const openSession = useCallback(async (id: string) => {
    if (!id) {
      setSessionId(null);
      setMessages([]);
      return;
    }
    const j = (await (await fetch(`/api/compare/sessions/${id}`)).json()) as { session?: CompareSession };
    if (j.session) {
      setSessionId(j.session.id);
      setMessages(j.session.messages);
    }
  }, []);

  const send = useCallback(
    async (text: string, sendMode: CompareMode = mode, sendRunBoth: boolean = runBoth) => {
      setBusy(true);
      setError(null);
      setMessages((prev) => [...prev, { role: "user", content: text, at: new Date().toISOString() }]);
      try {
        const res = await fetch("/api/compare/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId ?? undefined, message: text, mode: sendMode, runBoth: sendRunBoth }),
        });
        const j = (await res.json()) as { error?: string; sessionId?: string; session?: CompareSession };
        if (!res.ok || j.error) {
          if (res.status === 503) setHasKey(false);
          throw new Error(j.error ?? `request failed (${res.status})`);
        }
        setSessionId(j.sessionId ?? null);
        setMessages(j.session?.messages ?? []);
        void refreshSessions();
      } catch (err) {
        setError((err as Error).message);
        setMessages((prev) => prev.slice(0, -1)); // roll back the optimistic user msg
      } finally {
        setBusy(false);
      }
    },
    [sessionId, mode, runBoth]
  );

  // a sample carries its own suggested mode/runBoth — reflect them in the
  // controls so the viewer sees what is being tested, then send
  const runSample = useCallback(
    (s: SampleQuestion) => {
      setMode(s.mode);
      setRunBoth(s.runBoth === true);
      void send(s.question, s.mode, s.runBoth === true);
    },
    [send]
  );

  // one-click benchmark: the whole curated suite through BOTH arms, in one
  // fresh session (shared growing history keeps parity realistic). Threads
  // the session id imperatively — React state is async between iterations.
  const runBenchmark = useCallback(async () => {
    if (busy || benchmark?.current != null) return;
    setError(null);
    setSessionId(null);
    setMessages([]);
    setMode("graph");
    setRunBoth(true);
    let sid: string | undefined;
    try {
      for (let i = 0; i < SAMPLE_QUESTIONS.length; i++) {
        const s = SAMPLE_QUESTIONS[i]!;
        setBenchmark({ done: i, total: SAMPLE_QUESTIONS.length, current: s.question });
        setMessages((prev) => [...prev, { role: "user", content: s.question, at: new Date().toISOString() }]);
        const res = await fetch("/api/compare/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, message: s.question, mode: "graph", runBoth: true }),
        });
        const j = (await res.json()) as { error?: string; sessionId?: string; session?: CompareSession };
        if (!res.ok || j.error) {
          if (res.status === 503) setHasKey(false);
          throw new Error(j.error ?? `request failed (${res.status})`);
        }
        sid = j.sessionId;
        setSessionId(j.sessionId ?? null);
        setMessages(j.session?.messages ?? []);
      }
      setBenchmark({ done: SAMPLE_QUESTIONS.length, total: SAMPLE_QUESTIONS.length, current: null });
    } catch (err) {
      setError((err as Error).message);
      setBenchmark(null);
    } finally {
      void refreshSessions();
    }
  }, [busy, benchmark]);

  return (
    <main className="app">
      <section className="panel">
        <header className="panel-header">
          <nav className="tabs">
            <Link className="tab" href="/">
              ← Agents
            </Link>
            <span className="tab active">⚖ Compare</span>
          </nav>
          <div className="sub">Cedar Grove Veterinary Clinic — monolith prompt vs graph compose</div>
          <select
            value={sessionId ?? ""}
            onChange={(e) => void openSession(e.target.value)}
            aria-label="Comparison session"
          >
            <option value="">New comparison</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </header>
        <BenchmarkPanel
          meta={meta}
          mode={mode}
          runBoth={runBoth}
          messages={messages}
          onMode={setMode}
          onRunBoth={setRunBoth}
          benchmark={benchmark}
          canRunBenchmark={hasKey && !busy && benchmark?.current == null}
          onRunBenchmark={() => void runBenchmark()}
        />
      </section>
      <section className="panel">
        {!hasKey && <div className="banner">ANTHROPIC_API_KEY is not set — chat is disabled, but the graph/monolith stats above still load.</div>}
        {error && <div className="banner">{error}</div>}
        <CompareChat
          messages={messages}
          busy={busy || benchmark?.current != null}
          hasKey={hasKey}
          onSend={(t) => void send(t)}
          onSample={runSample}
        />
      </section>
    </main>
  );
}
