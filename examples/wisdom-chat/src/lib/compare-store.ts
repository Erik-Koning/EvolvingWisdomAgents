// Sessions for the ⚖ Compare benchmark page — deliberately independent of the
// AgentId-typed store.ts machinery. One pretty JSON file per session under
// data/compare/; WISDOM_DATA_DIR overrides the root for test isolation.
import "./env";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CompareMode = "monolith" | "graph";

export interface CompareMetrics {
  mode: CompareMode;
  /** Graph mode only: the routing classify call — the library's measured cost. */
  routeMs?: number;
  /** Graph mode only: which model classified (small model = fast routing). */
  routeModel?: string;
  /** Graph mode only: "embedding" when the embedBypass fast path skipped the
   * classify call; "classify" when the LLM decided. */
  routeMethod?: "embedding" | "classify";
  /** Graph mode only: MEASURED routing-call usage (0 when the bypass skipped
   * the LLM entirely) and its cost at the routing model's rates. */
  routeInputTokens?: number;
  routeOutputTokens?: number;
  routeCostUsd?: number;
  /** Graph mode only: compose() time (local, usually ~1ms). */
  composeMs?: number;
  generateMs: number;
  totalMs: number;
  promptChars: number;
  promptTokensEst: number;
  /** Real API usage summed across the agent's LLM calls. */
  inputTokens: number;
  outputTokens: number;
  /** First LLM call's input tokens — dominated by the system prompt, so the
   * mode delta stays visible even as shared history grows. */
  firstInputTokens: number;
  llmCalls: number;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  routedTo?: Array<{ nodeId: string; title?: string; confidence: number; fallback?: boolean }>;
  /** Must be 0 — nonzero means the compose budget silently cut the graph arm. */
  truncatedCount: number;
  /** The exact system prompt sent (shown in the UI's expandable details). */
  promptText: string;
}

export interface CompareMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  mode?: CompareMode;
  metrics?: CompareMetrics;
  /** "Run both": the other arm's reply + metrics (display-only, not history). */
  alt?: { reply: string; metrics: CompareMetrics };
}

export interface CompareSession {
  id: string;
  title: string;
  createdAt: string;
  messages: CompareMessage[];
}

function compareDir(): string {
  const root = process.env["WISDOM_DATA_DIR"] ?? join(process.cwd(), "data");
  const dir = join(root, "compare");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ID_RE = /^[a-z0-9-]+$/;

function sessionPath(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid session id: ${id}`);
  return join(compareDir(), `${id}.json`);
}

export function createCompareSession(): CompareSession {
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const session: CompareSession = { id, title: "New comparison", createdAt: new Date().toISOString(), messages: [] };
  saveCompareSession(session);
  return session;
}

export function getCompareSession(id: string): CompareSession | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as CompareSession;
}

export function saveCompareSession(session: CompareSession): void {
  const path = sessionPath(session.id);
  const tmp = join(compareDir(), `.${session.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n");
  renameSync(tmp, path);
}

export function listCompareSessions(): Array<Pick<CompareSession, "id" | "title" | "createdAt">> {
  return readdirSync(compareDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(compareDir(), f), "utf8")) as CompareSession)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(({ id, title, createdAt }) => ({ id, title, createdAt }));
}
