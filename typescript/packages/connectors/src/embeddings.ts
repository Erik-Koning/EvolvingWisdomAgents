import type { EmbeddingsConnector } from "@apgraph/core";

interface FetchConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VoyageConfig extends FetchConfig {
  /** "query" | "document" — Voyage embeds queries and documents differently. */
  inputType?: "query" | "document";
}

/** Voyage AI embeddings (Anthropic's partner; registry name "voyage"). */
export class VoyageEmbeddings implements EmbeddingsConnector {
  constructor(private config: VoyageConfig = {}) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await postJson(
      `${this.config.baseUrl ?? "https://api.voyageai.com"}/v1/embeddings`,
      {
        Authorization: `Bearer ${requireKey(this.config.apiKey, "VOYAGE_API_KEY", "VoyageEmbeddings")}`,
      },
      {
        input: texts,
        model: this.config.model ?? "voyage-3-lite",
        ...(this.config.inputType ? { input_type: this.config.inputType } : {}),
      },
      this.config.fetchImpl,
      "VoyageEmbeddings",
    );
    return orderedVectors(data, texts.length, "VoyageEmbeddings");
  }
}

export interface OpenAIConfig extends FetchConfig {
  /** Matryoshka truncation for text-embedding-3-* models. */
  dimensions?: number;
}

/** OpenAI embeddings (registry name "openai"). */
export class OpenAIEmbeddings implements EmbeddingsConnector {
  constructor(private config: OpenAIConfig = {}) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await postJson(
      `${this.config.baseUrl ?? "https://api.openai.com"}/v1/embeddings`,
      {
        Authorization: `Bearer ${requireKey(this.config.apiKey, "OPENAI_API_KEY", "OpenAIEmbeddings")}`,
      },
      {
        input: texts,
        model: this.config.model ?? "text-embedding-3-small",
        ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
      },
      this.config.fetchImpl,
      "OpenAIEmbeddings",
    );
    return orderedVectors(data, texts.length, "OpenAIEmbeddings");
  }
}

function requireKey(configured: string | undefined, envVar: string, who: string): string {
  const key = configured ?? process.env[envVar];
  if (!key) throw new Error(`${who}: no API key — set ${envVar} or pass config.apiKey`);
  return key;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch | undefined,
  who: string,
): Promise<unknown> {
  const res = await (fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${who}: API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Both APIs return {data: [{index, embedding}]}; re-order by index to be safe. */
function orderedVectors(data: unknown, expected: number, who: string): number[][] {
  const rows = (data as { data?: Array<{ index?: number; embedding?: number[] }> }).data;
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new Error(`${who}: expected ${expected} embeddings, got ${rows?.length ?? 0}`);
  }
  const out: number[][] = new Array(expected);
  rows.forEach((row, i) => {
    out[row.index ?? i] = row.embedding ?? [];
  });
  return out;
}
