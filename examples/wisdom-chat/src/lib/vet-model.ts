// Client-safe: the shared generation config both benchmark arms use, split out
// of compare-agent.ts so client components (BenchmarkPanel, CompareChat) can
// display it without dragging the LangChain/Anthropic server stack into the
// browser bundle (node:child_process etc. break the webpack build).
export const VET_MODEL = { model: "claude-sonnet-4-6", temperature: 0.4, maxTokens: 1024 } as const;
