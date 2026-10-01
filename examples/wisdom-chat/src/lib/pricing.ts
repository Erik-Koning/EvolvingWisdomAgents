// Model pricing for the cost badges and projection card. Constants, USD per
// million tokens — verify against current Anthropic pricing when models
// change (values as of authoring: Sonnet 4.x $3/$15, Haiku 4.5 $1/$5).
export const PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  "claude-sonnet-4-6": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5-20251001": { inPerM: 1, outPerM: 5 },
};

const DEFAULT_PRICE = { inPerM: 3, outPerM: 15 };

export function costUsd(inputTokens: number, outputTokens: number, model: string): number {
  const p = PRICING[model] ?? DEFAULT_PRICE;
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}

export function fmtUsd(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd).toLocaleString("en-CA")}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
