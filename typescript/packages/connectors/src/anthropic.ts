import type { ChatTurn, ComposedPrompt, JsonSchemaFragment, LlmConnector, ModelHints, RoutingMatch } from "@apgraph/core";

export interface AnthropicConfig {
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Per-request timeout in ms (default 60000) — a hung fetch never wedges a pipeline. */
  timeoutMs?: number;
  /** Called once per successful API request with the measured token usage —
   * lets hosts price classify/extract calls instead of estimating them. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; model: string }) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

const CLASSIFY_SYSTEM =
  "You are a routing classifier for an Adaptive Prompt Graph. Given a user query and a category outline (one node per line: `id: descriptor`), report every node the query plausibly belongs to with a confidence in [0,1]. Prefer the most specific (deepest) applicable nodes. Report nothing for irrelevant nodes.";

const EXTRACT_SYSTEM =
  "You extract structured values from a user's free-text message. Only report values the message actually states or clearly implies; never guess. Omit unknown fields entirely.";

/**
 * Fetch-based Anthropic Messages driver (no SDK dependency). Both calls force
 * a tool whose input schema is supplied by the kernel, so the response is
 * validated structure, not prose.
 */
export class AnthropicLlm implements LlmConnector {
  constructor(private config: AnthropicConfig = {}) {}

  async classify(input: {
    query: string;
    outline: string;
    schema: JsonSchemaFragment;
    multi: boolean;
    hints?: ModelHints;
  }): Promise<RoutingMatch[]> {
    const result = await this.forcedToolCall({
      name: "classify",
      description: "Report the outline nodes matching the query.",
      inputSchema: input.schema,
      system: CLASSIFY_SYSTEM + (input.multi ? "" : " Report at most one node."),
      user: `Query: ${input.query}\n\nCategory outline:\n${input.outline}`,
      model: input.hints?.model,
    });
    const matches = (result as { matches?: RoutingMatch[] }).matches;
    return Array.isArray(matches) ? matches : [];
  }

  async extract(input: { text: string; schema: JsonSchemaFragment }): Promise<Record<string, unknown>> {
    const result = await this.forcedToolCall({
      name: "extract",
      description: "Report values stated in the message.",
      inputSchema: input.schema,
      system: EXTRACT_SYSTEM,
      user: input.text,
    });
    return (result as Record<string, unknown>) ?? {};
  }

  /** Multi-turn chat: system = the composed prompt, query = the new user turn. */
  async generate(input: { prompt: ComposedPrompt; query: string; history?: ChatTurn[] }): Promise<{ text: string }> {
    const data = (await this.post({
      model: input.prompt.modelHints?.model ?? this.config.model ?? DEFAULT_MODEL,
      max_tokens: input.prompt.modelHints?.maxTokens ?? this.config.maxTokens ?? 1024,
      ...(input.prompt.modelHints?.temperature !== undefined
        ? { temperature: input.prompt.modelHints.temperature }
        : {}),
      system: input.prompt.text,
      messages: [
        ...(input.history ?? []).map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: input.query },
      ],
    })) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    return { text };
  }

  private async forcedToolCall(args: {
    name: string;
    description: string;
    inputSchema: JsonSchemaFragment;
    system: string;
    user: string;
    model?: string;
  }): Promise<unknown> {
    const data = (await this.post({
      model: args.model ?? this.config.model ?? DEFAULT_MODEL,
      max_tokens: this.config.maxTokens ?? 1024,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      tools: [{ name: args.name, description: args.description, input_schema: args.inputSchema }],
      tool_choice: { type: "tool", name: args.name },
    })) as { content?: Array<{ type: string; input?: unknown }> };
    const toolUse = data.content?.find((c) => c.type === "tool_use");
    if (!toolUse) throw new Error("AnthropicLlm: response contained no tool_use block");
    return toolUse.input;
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const apiKey = this.config.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("AnthropicLlm: no API key — set ANTHROPIC_API_KEY or pass config.apiKey");
    }
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.config.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      throw new Error(`AnthropicLlm: API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      this.config.onUsage?.({
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        model: String(body["model"]),
      });
    } catch {
      /* a telemetry sink must never break the call it observes */
    }
    return data;
  }
}
