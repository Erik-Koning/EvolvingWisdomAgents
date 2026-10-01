// The shared LangGraph runner both benchmark arms use. Generation config is
// byte-identical (VET_MODEL constant — never composed.modelHints, which only
// the graph arm would have); the ONLY input that differs is promptText.
import "./env";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildVetTools } from "./vet-tools";

// re-exported from a client-safe module so UI components can import it without
// pulling this file's server-only LangChain stack into the browser bundle
import { VET_MODEL } from "./vet-model";
export { VET_MODEL };

export interface RunnerResult {
  text: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  firstInputTokens: number;
  generateMs: number;
}

export type CompareRunner = (input: {
  promptText: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
  toolAllowlist: string[] | undefined;
}) => Promise<RunnerResult>;

/** Pure extraction of usage + tool calls from an agent result's messages.
 * @langchain/anthropic sets usage_metadata on every non-streamed AIMessage;
 * input_tokens of the FIRST call is dominated by the system prompt. */
export function usageFromMessages(messages: BaseMessage[]): Omit<RunnerResult, "text" | "generateMs"> {
  const toolCalls: RunnerResult["toolCalls"] = [];
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let firstInputTokens = 0;
  for (const msg of messages) {
    if (!(msg instanceof AIMessage)) continue;
    llmCalls += 1;
    const usage = msg.usage_metadata;
    if (llmCalls === 1) firstInputTokens = usage?.input_tokens ?? 0;
    inputTokens += usage?.input_tokens ?? 0;
    outputTokens += usage?.output_tokens ?? 0;
    for (const tc of msg.tool_calls ?? []) {
      toolCalls.push({ tool: tc.name, args: (tc.args ?? {}) as Record<string, unknown> });
    }
  }
  return { toolCalls, llmCalls, inputTokens, outputTokens, firstInputTokens };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : ((block as { text?: string }).text ?? "")))
      .join("");
  }
  return "";
}

export const vetAgentRunner: CompareRunner = async ({ promptText, history, message, toolAllowlist }) => {
  const agent = createReactAgent({
    llm: new ChatAnthropic(VET_MODEL),
    tools: buildVetTools(toolAllowlist),
    prompt: promptText,
  });
  const messages: BaseMessage[] = [
    ...history.map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content))),
    new HumanMessage(message),
  ];
  const t0 = performance.now();
  const result = await agent.invoke({ messages });
  const generateMs = Math.round(performance.now() - t0);
  // measure only the messages this run ADDED — the input history's assistant
  // turns are plain AIMessages with no usage_metadata and would otherwise
  // inflate llmCalls and zero out firstInputTokens on turn 2+
  const usage = usageFromMessages(result.messages.slice(messages.length));
  const last = result.messages[result.messages.length - 1];
  return { text: contentToText(last?.content), generateMs, ...usage };
};
