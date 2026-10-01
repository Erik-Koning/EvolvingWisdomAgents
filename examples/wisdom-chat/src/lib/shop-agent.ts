// The repair-shop agent is a LangGraph ReAct agent; the wisdom graph is its
// control plane. compose() supplies the system prompt, compose().toolAllowlist
// gates which tools it receives, and the tool calls LangGraph reports back
// become metadata the feedback digester can learn from.
import "./env";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ComposedPrompt } from "@apgraph/core";
import { buildShopTools } from "./tools";
import type { ChatMessage } from "./store";

export interface ShopReply {
  text: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
}

export async function shopReply(
  composed: ComposedPrompt,
  history: ChatMessage[],
  message: string,
): Promise<ShopReply> {
  const agent = createReactAgent({
    llm: new ChatAnthropic({
      model: composed.modelHints?.model ?? "claude-sonnet-4-6",
      temperature: composed.modelHints?.temperature ?? 0.4,
      maxTokens: composed.modelHints?.maxTokens ?? 1024,
    }),
    tools: buildShopTools(composed.toolAllowlist),
    prompt: composed.text,
  });

  const result = await agent.invoke({
    messages: [
      ...history.map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content))),
      new HumanMessage(message),
    ],
  });

  const toolCalls: ShopReply["toolCalls"] = [];
  for (const msg of result.messages) {
    if (msg instanceof AIMessage) {
      for (const tc of msg.tool_calls ?? []) {
        toolCalls.push({ tool: tc.name, args: (tc.args ?? {}) as Record<string, unknown> });
      }
    }
  }

  const last = result.messages[result.messages.length - 1];
  return { text: contentToText(last?.content), toolCalls };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("");
  }
  return "";
}
