# APG examples

Runnable end-to-end demos. The scripts below need no API key — routing uses a deterministic
keyword classifier where a real deployment would register an LLM connector.

**Full app:** [`wisdom-chat/`](./wisdom-chat) — a Next.js chatbot whose AI companion learns
about you every 5 messages and saves it into a live-visualized wisdom graph (route → compose →
generate → extract → applyChangeset, the whole library in one loop). Needs `ANTHROPIC_API_KEY`;
see its README.

| Example | Shows | Run |
|---|---|---|
| `walk-triage-flow.mjs` | L3 deterministic session walking: decision → decision → explicit-fill elicitation → tool call → interpolated answer, zero LLM calls | `cd typescript && pnpm -r build && cd .. && node examples/walk-triage-flow.mjs` |
| `walk_triage_flow.py` | The same walk in the Python runtime — two runtimes, one fixture-pinned walker | `cd python && uv sync && uv run python ../examples/walk_triage_flow.py` |
| `route_and_compose.py` | L4 routing + three-stage composition in the Python runtime: safety constraints arrive via `bring[]`, persona/constraints compose along the path | `cd python && uv sync && uv run python ../examples/route_and_compose.py` |

CLI equivalents (after `cd typescript && pnpm -r build`):

```bash
node typescript/packages/cli/dist/main.js tree     templates/l3-triage-flows.apg.json
node typescript/packages/cli/dist/main.js outline  templates/l1-faq-props.apg.json
node typescript/packages/cli/dist/main.js route    templates/l0-prompt-switcher.apg.json "plan a trip to Portugal"
node typescript/packages/cli/dist/main.js route    templates/l0-prompt-switcher.apg.json "plan a trip" --live   # Anthropic API; needs ANTHROPIC_API_KEY
node typescript/packages/cli/dist/main.js compose  templates/l1-personalization.apg.json returns --var brandName=Acme
node typescript/packages/cli/dist/main.js validate templates/l2-intake-form.apg.json
```

Interactive walk (the L3 flow, with scripted tool responses for the action node):

```bash
echo '{"checkWarranty":{"ok":true,"result":{"inWarranty":true}}}' > /tmp/mocks.json
node typescript/packages/cli/dist/main.js walk templates/l3-triage-flows.apg.json wont-start --tools /tmp/mocks.json
```

MCP (Claude Desktop / MCP Inspector, stdio):

```bash
node typescript/packages/mcp-server/dist/main.js --graph templates/l4-support-bot-handoff.apg.json
```
