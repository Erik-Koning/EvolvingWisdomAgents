// Shared connector construction. Chat/extraction always use Anthropic; the
// embedding pre-filter binds only when a Voyage or OpenAI key is present —
// without one, routing skips the shortlist stage (fine at small graph sizes).
import "./env";
import type { Connectors, EmbeddingsConnector } from "@apgraph/core";
import { AnthropicLlm, OpenAIEmbeddings, VoyageEmbeddings } from "@apgraph/connectors";

export const llm = new AnthropicLlm();

export function embeddingsConnector(): EmbeddingsConnector | undefined {
  // no inputType: the router embeds query + node texts in one batch call
  if (process.env.VOYAGE_API_KEY) return new VoyageEmbeddings();
  if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddings();
  return undefined;
}

export function routingConnectors(): Connectors {
  const embeddings = embeddingsConnector();
  return embeddings ? { llm, embeddings } : { llm };
}
