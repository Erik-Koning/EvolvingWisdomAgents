#!/usr/bin/env node
// Insert feedback directly into the repair-shop agent via /api/feedback — the
// same path as the 🎓 Teach box (no session, no chat). Nothing about the graph
// outcome is mocked: each step is digested by the live LLM and committed by the
// real store; the script reports the observed node-count/version delta next to
// the human-written expectation so you can judge whether the graph updated
// accurately.
//
// Usage (against a running `pnpm dev` server):
//   node scripts/insert-feedback.mjs                      # canned add → refine → retire lifecycle
//   node scripts/insert-feedback.mjs "always mention the 90-day warranty when quoting"
//   node scripts/insert-feedback.mjs --identity "you are now also the service manager"
//   node scripts/insert-feedback.mjs --agent shop --base http://localhost:3000 "…"

const args = process.argv.slice(2);
let base = "http://localhost:3000";
let agentId = "shop";
let identity = false;
const comments = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") base = args[++i];
  else if (args[i] === "--agent") agentId = args[++i];
  else if (args[i] === "--identity") identity = true;
  else comments.push(args[i]);
}

// The canned sequence walks one rule through all three digester actions.
const CANNED = [
  {
    comment: "Always collect the customer's phone number before booking a drop-off.",
    expect: "ADD — a new leaf under Scheduling & drop-off, feedbackCount=1, bring edge added (node count +1)",
  },
  {
    comment: "When collecting the phone number for a drop-off, also record the engine's make and model.",
    expect: "REFINE — same node rewritten to cover both, feedbackCount 1 → 2 (node count unchanged)",
  },
  {
    comment:
      "Forget all that — don't collect phone numbers, make, model, or anything else before booking a drop-off. Drop the rule entirely.",
    expect: "RETIRE — node deleted, bring edge cleaned up atomically (node count −1, back to the start)",
  },
];

if (identity && comments.length === 0) {
  console.error("--identity needs an explicit comment — refusing to send the canned lifecycle as identity edicts.");
  process.exit(1);
}

const steps = comments.length > 0 ? comments.map((comment) => ({ comment, expect: null })) : CANNED;

async function graphSnapshot() {
  const res = await fetch(`${base}/api/graph?agent=${agentId}`);
  if (!res.ok) throw new Error(`GET /api/graph → HTTP ${res.status}`);
  const { doc } = await res.json();
  return { nodes: doc.nodes.length, version: doc.version ?? "?" };
}

function summarize(data) {
  const parts = [];
  if (data.adjustments?.length) {
    const where = data.adjustments
      .map((a) => (a.nodeId ? `${a.nodeId} under ${a.categoryId}` : a.tool ? `tool ${a.tool}` : a.categoryId))
      .join(", ");
    parts.push(`new: ${where}`);
  }
  if (data.refined?.length) parts.push(`refined: ${data.refined.map((r) => r.nodeId).join(", ")}`);
  if (data.retired?.length) parts.push(`retired: ${data.retired.map((r) => r.nodeId).join(", ")}`);
  if (data.deniedTools?.length) parts.push(`tools removed: ${data.deniedTools.join(", ")}`);
  if (data.proposal) {
    parts.push("rejected" in data.proposal ? `amendment rejected (${data.proposal.rejected})` : `amendment drafted (${data.proposal.status})`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no adjustment extracted";
}

try {
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  if (!health.hasKey) {
    console.error("ANTHROPIC_API_KEY is not set on the server — feedback digestion needs the live LLM.");
    process.exit(1);
  }
} catch {
  console.error(`Cannot reach ${base} — is the app running? (cd examples/wisdom-chat && pnpm dev)`);
  process.exit(1);
}

let before = await graphSnapshot();
console.log(`agent=${agentId} · graph v${before.version} · ${before.nodes} nodes\n`);

for (const [i, step] of steps.entries()) {
  console.log(`── step ${i + 1}/${steps.length} ${identity ? "(identity edict)" : ""}`);
  console.log(`   teach:  ${step.comment}`);
  if (step.expect) console.log(`   expect: ${step.expect}`);
  const res = await fetch(`${base}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, comment: step.comment, identity }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error(`   FAILED: ${data.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  const after = await graphSnapshot();
  const delta = after.nodes - before.nodes;
  console.log(`   digest: ${summarize(data)}`);
  console.log(`   graph:  v${before.version} → v${after.version} · ${before.nodes} → ${after.nodes} nodes (${delta >= 0 ? "+" : ""}${delta})\n`);
  before = after;
}

console.log("done — inspect the tree at " + base + " (changes persist; delete data/ to reset)");
