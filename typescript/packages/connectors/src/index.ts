import { registerConnector, MemorySessionStore, type HandoffConnector, type TelemetryConnector } from "@apgraph/core";
import { AnthropicLlm } from "./anthropic.js";
import { FileGraphStore } from "./file-store.js";
import { FileChangesetStore, FileLayerStore, FileTranscriptStore, FileAgentStateStore } from "./json-stores.js";
import { LexicalLlm } from "./lexical.js";
import { VoyageEmbeddings, OpenAIEmbeddings } from "./embeddings.js";

export { AnthropicLlm } from "./anthropic.js";
export type { AnthropicConfig } from "./anthropic.js";
export { FileGraphStore } from "./file-store.js";
export { LexicalLlm } from "./lexical.js";
export { VoyageEmbeddings, OpenAIEmbeddings } from "./embeddings.js";
export type { VoyageConfig, OpenAIConfig } from "./embeddings.js";
export { FileChangesetStore, FileLayerStore, FileTranscriptStore, FileAgentStateStore } from "./json-stores.js";

/** Webhook handoff (registry name "webhook"): POSTs the ticket to config.url. */
export class WebhookHandoff implements HandoffConnector {
  constructor(private url: string, private fetchImpl: typeof fetch = fetch) {}
  async open(ticket: { nodeId: string; queue?: string; vars: Record<string, unknown>; draft?: string }) {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
    });
    if (!res.ok) throw new Error(`WebhookHandoff: ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { ticketId?: string };
    return { ticketId: body.ticketId ?? `webhook-${ticket.nodeId}` };
  }
}

class NoopTelemetry implements TelemetryConnector {
  event(): void {}
}

/**
 * Register the shipped drivers under the registry names the templates
 * declare, so `bindConnectors(doc)` resolves. Not registered (documented
 * gaps): "mcp-client" tools; "otel" maps to a no-op here — swap in a real
 * exporter by re-registering.
 */
export function registerBuiltins(): void {
  registerConnector("anthropic", (config) => new AnthropicLlm(config));
  registerConnector("lexical", () => new LexicalLlm());
  registerConnector("voyage", (config) => new VoyageEmbeddings(config));
  registerConnector("openai", (config) => new OpenAIEmbeddings(config));
  registerConnector("file", (config) => new FileGraphStore(String(config["dir"] ?? "./graphs")));
  registerConnector("file-changesets", (config) => new FileChangesetStore(String(config["dir"] ?? "./graphs")));
  registerConnector("file-layers", (config) => new FileLayerStore(String(config["dir"] ?? "./graphs")));
  registerConnector("file-transcripts", (config) => new FileTranscriptStore(String(config["dir"] ?? "./graphs")));
  registerConnector("file-state", (config) => new FileAgentStateStore(String(config["dir"] ?? "./graphs")));
  registerConnector("memory", () => new MemorySessionStore());
  registerConnector("webhook", (config) => new WebhookHandoff(String(config["url"] ?? "")));
  registerConnector("otel", () => new NoopTelemetry());
}
