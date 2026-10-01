// End-to-end L3 demo: deterministic session walking over the device-triage
// template — zero LLM calls. Run from repo root after building typescript/:
//   node examples/walk-triage-flow.mjs
import { loadGraph, newSession, sessionStep, ScriptedTools } from "../typescript/packages/core/dist/index.js";

const graph = loadGraph(new URL("../templates/l3-triage-flows.apg.json", import.meta.url).pathname);
const connectors = {
  tools: new ScriptedTools({
    checkWarranty: { ok: true, result: { inWarranty: true, until: "2027-01-01" } },
  }),
};

let session = newSession("demo");
const show = (label, effects) => {
  console.log(`\n== ${label}`);
  for (const e of effects) console.log("  ", JSON.stringify(e));
};

let step = await sessionStep(graph, session, { kind: "enter", nodeId: "wont-start" }, connectors);
show("enter wont-start → decision asks", step.effects);

step = await sessionStep(graph, step.session, { kind: "choice", value: "yes" }, connectors);
show("choice: powers on → next decision asks", step.effects);

step = await sessionStep(graph, step.session, { kind: "choice", value: "yes" }, connectors);
show("choice: screen damaged → action node elicits the serial number", step.effects);

step = await sessionStep(graph, step.session, { kind: "user", text: "SN-12345" }, connectors);
show("user: SN-12345 → explicit fill, tool call, answer", step.effects);

console.log("\nfinal vars:", JSON.stringify(step.session.vars, null, 2));
