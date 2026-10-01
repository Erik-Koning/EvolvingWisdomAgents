"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TEST_SCRIPTS, type TestScript } from "@/lib/test-scripts";

interface ContextStats {
  mode: "full" | "routed";
  nodeCount: number;
  chars: number;
  matched: string[];
}

interface Message {
  /** "note" rows are local test-harness annotations, never persisted server-side. */
  role: "user" | "assistant" | "note";
  content: string;
  at: string;
  tone?: "expect" | "result" | "error";
  routedTo?: Array<{ nodeId: string; title?: string; confidence: number }>;
  toolCalls?: Array<{ tool: string; args: Record<string, unknown> }>;
  contextStats?: ContextStats;
}

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  ended: boolean;
}

export interface AgentInfo {
  id: string;
  label: string;
  defaultContextMode: "full" | "routed";
  supportsFeedback: boolean;
  tagline: string;
  placeholder: string;
}

export function ChatPane({
  agent,
  hasKey,
  onGraphChanged,
}: {
  agent: AgentInfo;
  hasKey: boolean;
  onGraphChanged: (toastText: string | null) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ended, setEnded] = useState(false);
  const [contextMode, setContextMode] = useState<"full" | "routed">(agent.defaultContextMode);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [testMenu, setTestMenu] = useState(false);
  const [testRun, setTestRun] = useState<{ label: string; step: number; total: number } | null>(null);
  const testAbort = useRef(false);
  const testWrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async () => {
    const res = await fetch(`/api/sessions?agent=${agent.id}`);
    const data = (await res.json()) as { sessions: SessionSummary[] };
    setSessions(data.sessions);
  }, [agent.id]);

  // reset the pane when switching agents
  useEffect(() => {
    testAbort.current = true; // kill any in-flight test run
    setTestMenu(false);
    setTestRun(null);
    setSessionId(null);
    setMessages([]);
    setEnded(false);
    setError(null);
    setAdjusting(null);
    setContextMode(agent.defaultContextMode);
    void refreshSessions();
  }, [agent.id, agent.defaultContextMode, refreshSessions]);

  // close the test popover on outside click or Escape
  useEffect(() => {
    if (!testMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!testWrapRef.current?.contains(e.target as Node)) setTestMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTestMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [testMenu]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function openSession(id: string) {
    const res = await fetch(`/api/sessions/${id}`);
    const data = (await res.json()) as { session: { messages: Message[]; ended: boolean; contextMode?: "full" | "routed" } };
    setSessionId(id);
    setMessages(data.session.messages);
    setEnded(data.session.ended);
    if (data.session.contextMode) setContextMode(data.session.contextMode);
    setError(null);
  }

  function newChat() {
    setSessionId(null);
    setMessages([]);
    setEnded(false);
    setError(null);
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message, at: new Date().toISOString() }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, sessionId: sessionId ?? undefined, message, contextMode }),
      });
      const data = (await res.json()) as {
        error?: string;
        sessionId?: string;
        session?: { messages: Message[] };
        harvested?: { learned: unknown[] } | null;
        autoSleep?: string | null;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (!sessionId && data.sessionId) {
        setSessionId(data.sessionId);
        void refreshSessions();
      }
      // merge, don't replace: a wholesale swap would drop test-harness note rows
      if (data.session) setMessages((cur) => mergeNotes(cur, data.session!.messages));
      if (data.autoSleep) {
        onGraphChanged(`😴 slept while you were away — ${data.autoSleep}`);
      } else if (data.harvested && data.harvested.learned.length > 0) {
        onGraphChanged(`💡 learned ${data.harvested.learned.length} thing${data.harvested.learned.length === 1 ? "" : "s"}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitFeedback(comment: string, messageIndex?: number, identity = false) {
    if (!comment.trim()) return;
    setBusy(true);
    setAdjusting(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          sessionId: sessionId ?? undefined,
          ...(messageIndex !== undefined ? { messageIndex } : {}),
          comment,
          identity,
        }),
      });
      const data = (await res.json()) as { error?: string } & DigestResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      const summary = digestSummary(data);
      onGraphChanged(summary === "no adjustment extracted" ? "No adjustment extracted" : `🔧 agent adjusted — ${summary}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function endChat() {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/session/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json()) as { error?: string; harvested?: { learned: unknown[] } | null };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEnded(true);
      void refreshSessions();
      const n = data.harvested?.learned.length ?? 0;
      onGraphChanged(n > 0 ? `💡 learned ${n} thing${n === 1 ? "" : "s"}` : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Live test scripts: only the user side is scripted — every step goes through
  // the real /api/chat or /api/feedback pipeline and commits real graph writes.
  // Expected-change notes are rendered before each step so you can verify the
  // graph panel against them; nothing about the graph outcome is mocked.
  async function runTestScript(script: TestScript) {
    if (busy || testRun || !hasKey) return;
    setTestMenu(false);
    testAbort.current = false;
    setSessionId(null);
    setEnded(false);
    setError(null);
    setAdjusting(null);
    let sid: string | null = null;
    let serverCount = 0; // messages the server session holds (notes are local-only)
    let rows: Message[] = [];
    const push = (...added: Message[]) => {
      rows = [...rows, ...added];
      setMessages(rows);
    };
    const note = (content: string, tone?: Message["tone"]): Message => ({
      role: "note",
      content,
      at: new Date().toISOString(),
      tone,
    });
    setMessages(rows);
    setBusy(true);
    push(note(`running “${script.label}” — ${script.steps.length} steps against the live LLM. Graph changes are real and persist (delete data/ to reset).`));
    try {
      for (let i = 0; i < script.steps.length; i++) {
        if (testAbort.current) break;
        const step = script.steps[i]!;
        setTestRun({ label: script.label, step: i + 1, total: script.steps.length });
        push(note(`step ${i + 1}/${script.steps.length} · expect: ${step.expect}`, "expect"));
        if (step.kind === "say") {
          push({ role: "user", content: step.content, at: new Date().toISOString() });
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId: agent.id, sessionId: sid ?? undefined, message: step.content, contextMode }),
          });
          const data = (await res.json()) as {
            error?: string;
            sessionId?: string;
            reply?: string;
            routedTo?: Message["routedTo"];
            toolCalls?: Message["toolCalls"];
            contextStats?: ContextStats;
            autoSleep?: string | null;
          };
          if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
          if (testAbort.current) break;
          if (!sid && data.sessionId) {
            sid = data.sessionId;
            setSessionId(sid);
            void refreshSessions();
          }
          // patch routing badges onto the user row we just pushed, then append the reply
          rows = rows.map((r, idx) => (idx === rows.length - 1 ? { ...r, routedTo: data.routedTo } : r));
          push({
            role: "assistant",
            content: data.reply ?? "",
            at: new Date().toISOString(),
            toolCalls: data.toolCalls,
            contextStats: data.contextStats,
          });
          serverCount += 2;
          // an automatic sleep between messages rewrites the graph underneath
          // the test — surface it so expectation mismatches are explainable
          if (data.autoSleep) {
            push(note(`😴 auto-sleep ran between messages — ${data.autoSleep}. The graph changed underneath this test.`, "result"));
            onGraphChanged(null);
          }
        } else {
          const anchored = step.kind === "adjust";
          if (anchored && serverCount === 0) throw new Error(`script "${script.id}": adjust step before any reply`);
          const res = await fetch("/api/feedback", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agentId: agent.id,
              sessionId: sid ?? undefined,
              ...(anchored ? { messageIndex: serverCount - 1 } : {}),
              comment: step.content,
              identity: step.identity === true,
            }),
          });
          const data = (await res.json()) as { error?: string } & DigestResponse;
          if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
          if (testAbort.current) break;
          push(note(`${anchored ? "👎 adjust" : step.identity ? "⚡ teach identity" : "🎓 teach"}: “${step.content}” → ${digestSummary(data)}`, "result"));
          onGraphChanged(null); // refresh the tree so the real change is visible now
        }
      }
      if (!testAbort.current) {
        push(note("script complete — compare the graph panel against the expectations above", "result"));
      }
    } catch (err) {
      if (!testAbort.current) push(note(`test failed: ${(err as Error).message}`, "error"));
    } finally {
      // an abort can land after a step already committed — refresh so the
      // tree never shows stale state (stopping does not roll writes back)
      if (testAbort.current) onGraphChanged(null);
      setTestRun(null);
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h1>{agent.label}</h1>
        <span className="sub">{agent.tagline}</span>
        <div className="spacer" />
        <label className="toggle">
          <span className={contextMode === "routed" ? "on" : ""} onClick={() => setContextMode("routed")}>
            routed
          </span>
          <span className={contextMode === "full" ? "on" : ""} onClick={() => setContextMode("full")}>
            full
          </span>
        </label>
        <InfoTip label="What does routed vs full mean?">
          <p>
            <b>How each reply&apos;s system prompt is built from the graph:</b>
          </p>
          <p>
            <b>routed</b> — the message is first classified against the routable categories (the badges under your
            message). Only the matched branches&apos; rules compose into the prompt, plus the root&apos;s global brings
            (style, tool usage, shop facts). Selective context: the prompt stays small as the graph grows, but a rule
            anchored to a task only loads when the message routes there.
          </p>
          <p>
            <b>full</b> — the root plus every category composes: all learned rules in every prompt. Total recall, but
            the prompt grows with the graph.
          </p>
          <p className="dim">
            Compare the stats badge under a reply — mode · nodes composed · prompt chars — by asking the same question
            in each mode.
          </p>
        </InfoTip>
        {agent.supportsFeedback && (
          <div className="test-wrap" ref={testWrapRef}>
            <button
              className="small"
              title={
                testRun
                  ? `Stop “${testRun.label}”`
                  : "Run a scripted live test: user messages are canned, the LLM and graph writes are real — verify each expected change in the graph panel"
              }
              disabled={!hasKey || (busy && !testRun)}
              onClick={() => {
                if (testRun) testAbort.current = true;
                else setTestMenu((o) => !o);
              }}
            >
              {testRun ? `⏹ ${testRun.step}/${testRun.total}` : "🧪 Test"}
            </button>
            {testMenu && !testRun && (
              <div className="test-menu">
                <p className="test-menu-head">
                  Live test scripts — real LLM calls, real graph writes; only the user messages are scripted. Each step
                  shows the expected graph change to verify by eye.
                </p>
                {TEST_SCRIPTS.map((s) => (
                  <button key={s.id} className="test-item" onClick={() => void runTestScript(s)}>
                    <span className="test-item-label">
                      {s.label} <span className="sub">· {s.steps.length} steps</span>
                    </span>
                    <span className="test-item-desc">{s.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <select
          value={sessionId ?? ""}
          disabled={busy}
          onChange={(e) => (e.target.value ? void openSession(e.target.value) : newChat())}
        >
          <option value="">New chat</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.ended ? "✓ " : ""}
              {s.title}
            </option>
          ))}
        </select>
        <button className="small" onClick={endChat} disabled={!sessionId || ended || busy}>
          End chat
        </button>
      </header>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && <p className="empty">{agent.placeholder}</p>}
        {messages.map((m, i) =>
          m.role === "note" ? (
            <div key={i} className={`msg note${m.tone ? ` ${m.tone}` : ""}`}>
              🧪 {m.content}
            </div>
          ) : (
            <MessageRow
              key={i}
              index={i}
              message={m}
              canAdjust={agent.supportsFeedback && m.role === "assistant" && !ended && !testRun}
              adjusting={adjusting === i}
              onAdjustOpen={() => setAdjusting(adjusting === i ? null : i)}
              // server sessions never hold note rows, so translate the local
              // index to the server-side one before anchoring feedback
              onAdjustSubmit={(comment) =>
                void submitFeedback(comment, messages.slice(0, i + 1).filter((m) => m.role !== "note").length - 1)
              }
            />
          ),
        )}
        {busy && <div className="msg assistant">…</div>}
      </div>

      {error && <div className="banner">{error}</div>}

      {agent.supportsFeedback && (
        <TeachRow disabled={!hasKey || busy} onTeach={(comment, identity) => void submitFeedback(comment, undefined, identity)} />
      )}

      <div className="chat-input">
        <textarea
          value={input}
          placeholder={ended ? "This chat has ended — start a new one" : `Message ${agent.label}…`}
          disabled={!hasKey || ended || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" onClick={send} disabled={!hasKey || ended || busy || !input.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}

/**
 * Server sessions never hold note rows — when replacing the transcript with the
 * server copy, re-interleave local notes at their original positions (a note's
 * anchor = how many real messages preceded it).
 */
function mergeNotes(current: Message[], server: Message[]): Message[] {
  const notes: Array<{ anchor: number; note: Message }> = [];
  let real = 0;
  for (const m of current) {
    if (m.role === "note") notes.push({ anchor: real, note: m });
    else real++;
  }
  if (notes.length === 0) return server;
  const merged: Message[] = [];
  let ni = 0;
  for (let i = 0; i <= server.length; i++) {
    while (ni < notes.length && notes[ni]!.anchor === i) {
      merged.push(notes[ni]!.note);
      ni++;
    }
    if (i < server.length) merged.push(server[i]!);
  }
  while (ni < notes.length) merged.push(notes[ni++]!.note);
  return merged;
}

interface DigestResponse {
  adjustments?: Array<{ nodeId?: string; instruction: string; categoryId: string; tool?: string }>;
  refined?: Array<{ nodeId: string }>;
  retired?: Array<{ nodeId: string }>;
  deniedTools?: string[];
  version?: string | null;
  proposal?: { id: string; status: string; label: string } | { rejected: string };
}

/** One line describing what the feedback digester ACTUALLY did — including WHERE
 *  each new rule landed, so it can be found in the tree and compared against expectations. */
function digestSummary(data: DigestResponse): string {
  const parts: string[] = [];
  if (data.adjustments?.length) {
    const where = data.adjustments
      .map((a) => (a.nodeId ? `${a.nodeId} under ${a.categoryId}` : a.tool ? `tool ${a.tool}` : a.categoryId))
      .join(", ");
    parts.push(`new: ${where}`);
  }
  if (data.refined?.length) parts.push(`refined: ${data.refined.map((r) => r.nodeId).join(", ")}`);
  if (data.retired?.length) parts.push(`retired: ${data.retired.map((r) => r.nodeId).join(", ")}`);
  if (data.deniedTools?.length) parts.push(`tools removed: ${data.deniedTools.join(", ")}`);
  if (data.proposal) {
    parts.push("rejected" in data.proposal ? `amendment rejected (${data.proposal.rejected})` : `amendment drafted (${data.proposal.status})`);
  }
  if (data.version) parts.push(`graph → v${data.version}`);
  return parts.length > 0 ? parts.join(" · ") : "no adjustment extracted";
}

/** ⓘ tooltip: shows on hover, click pins it open (outside click unpins). */
function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <div
      className="info-tip"
      ref={wrapRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        className={`info-btn${pinned ? " on" : ""}`}
        aria-label={label}
        aria-expanded={pinned || hovered}
        onClick={() => setPinned((p) => !p)}
      >
        i
      </button>
      {(pinned || hovered) && (
        <div className="info-pop" role="tooltip">
          {children}
        </div>
      )}
    </div>
  );
}

function TeachRow({ disabled, onTeach }: { disabled: boolean; onTeach: (comment: string, identity: boolean) => void }) {
  const [comment, setComment] = useState("");
  const [identity, setIdentity] = useState(false);
  const submit = () => {
    if (!comment.trim()) return;
    onTeach(comment.trim(), identity);
    setComment("");
    setIdentity(false);
  };
  return (
    <div className="teach-row">
      <span className="teach-label">🎓</span>
      <input
        value={comment}
        placeholder={
          identity
            ? "Teach identity… proposes a charter amendment (you approve it)"
            : "Teach the agent… e.g. always mention the warranty when quoting"
        }
        disabled={disabled}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <label className="identity-toggle" title="Teach who the agent IS (charter) rather than a behavior rule — always human-gated">
        <input type="checkbox" checked={identity} disabled={disabled} onChange={(e) => setIdentity(e.target.checked)} />
        identity
      </label>
      <button className="small" disabled={disabled || !comment.trim()} onClick={submit}>
        Teach
      </button>
    </div>
  );
}

function MessageRow({
  index,
  message,
  canAdjust,
  adjusting,
  onAdjustOpen,
  onAdjustSubmit,
}: {
  index: number;
  message: Message;
  canAdjust: boolean;
  adjusting: boolean;
  onAdjustOpen: () => void;
  onAdjustSubmit: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const stats = message.contextStats;
  return (
    <>
      <div className={`msg ${message.role}`}>{message.content}</div>
      {message.role === "user" && (message.routedTo?.length ?? 0) > 0 && (
        <div className="badges">
          {message.routedTo!.map((r) => (
            <span key={r.nodeId} className="badge">
              {r.title ?? r.nodeId} · {Math.round(r.confidence * 100)}%
            </span>
          ))}
        </div>
      )}
      {message.role === "assistant" && ((message.toolCalls?.length ?? 0) > 0 || stats || canAdjust) && (
        <div className="badges assistant-meta">
          {message.toolCalls?.map((t, i) => (
            <span key={`${t.tool}-${i}`} className="badge tool" title={JSON.stringify(t.args)}>
              ⚙ {t.tool}
            </span>
          ))}
          {stats && (
            <span className="badge stats" title={stats.matched.length > 0 ? `matched: ${stats.matched.join(", ")}` : "no routing match"}>
              {stats.mode} · {stats.nodeCount} nodes · {(stats.chars / 1000).toFixed(1)}k chars
            </span>
          )}
          {canAdjust && (
            <button className="badge adjust" onClick={onAdjustOpen}>
              👎 Adjust
            </button>
          )}
        </div>
      )}
      {adjusting && (
        <div className="adjust-row">
          <input
            autoFocus
            value={comment}
            placeholder="How should it have responded? e.g. lead with the price, skip the weather"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && comment.trim()) {
                onAdjustSubmit(comment.trim());
                setComment("");
              }
            }}
          />
          <button
            className="small primary"
            disabled={!comment.trim()}
            onClick={() => {
              onAdjustSubmit(comment.trim());
              setComment("");
            }}
          >
            Teach
          </button>
        </div>
      )}
    </>
  );
}
