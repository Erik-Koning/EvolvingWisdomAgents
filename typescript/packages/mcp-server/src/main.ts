#!/usr/bin/env node
// stdio entry point:
//   apg-mcp-server --graph path/to/graph.apg.json [--tools mocks.json] [--data-dir dir]
// --data-dir persists graph versions, changesets, transcripts, engine state,
// and audit.jsonl across restarts (graphPath becomes the first-run seed).
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApgServer } from "./server.js";

const args = process.argv.slice(2);
const graphFlag = args.indexOf("--graph");
const graphPath = graphFlag >= 0 ? args[graphFlag + 1] : args[0];
if (!graphPath) {
  console.error("usage: apg-mcp-server --graph <path/to/graph.apg.json> [--tools <mocks.json>] [--data-dir <dir>]");
  process.exit(1);
}
const toolsFlag = args.indexOf("--tools");
const toolMocks =
  toolsFlag >= 0 && args[toolsFlag + 1]
    ? (JSON.parse(readFileSync(args[toolsFlag + 1]!, "utf8")) as Record<string, { ok: boolean; result: unknown }>)
    : undefined;
const dataFlag = args.indexOf("--data-dir");
const dataDir = dataFlag >= 0 ? args[dataFlag + 1] : undefined;

const server = await createApgServer({
  graphPath,
  ...(toolMocks ? { toolMocks } : {}),
  ...(dataDir ? { dataDir } : {}),
});
const transport = new StdioServerTransport();
await server.connect(transport);
