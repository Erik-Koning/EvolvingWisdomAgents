// Live test scripts for the repair-shop agent. Only the USER side is scripted —
// every step hits the real /api/chat or /api/feedback endpoint, the real LLM
// digests it, and the real graph store commits. The `expect` text is a
// human-verifiable note about what the graph (left panel) should do, never a
// mock: the point is to watch whether the live pipeline updates accurately.
//
// Graph writes made by a run are REAL and persist in data/ — delete the data
// directory (or hand-edit the .apg.json) to reset.

export interface TestStep {
  /**
   * say    = chat message through /api/chat (the agent replies; shop chat never writes the graph)
   * adjust = feedback anchored to the last assistant reply (the 👎 Adjust path)
   * teach  = direct free-form feedback with no message anchor (the 🎓 Teach box path)
   */
  kind: "say" | "adjust" | "teach";
  content: string;
  /** teach only: submit as an identity edict (charter amendment path). */
  identity?: boolean;
  /** Expected graph change (or explicit non-change) to verify by eye. */
  expect: string;
}

export interface TestScript {
  id: string;
  label: string;
  description: string;
  steps: TestStep[];
}

export const TEST_SCRIPTS: TestScript[] = [
  {
    id: "adjust-add-refine",
    label: "👎 Adjust: add, then refine",
    description:
      "Quote flow feedback anchored to replies — first teach a new rule, then repeat it and watch the digester strengthen the same node instead of duplicating it.",
    steps: [
      {
        kind: "say",
        content: "What would a new impeller cost for my Mercury 90hp outboard?",
        expect:
          "Routes to Quotes & estimates (badge on your message); reply uses ⚙ partsCost / laborRate. Graph unchanged — shop chat never writes the graph.",
      },
      {
        kind: "adjust",
        content: "Always mention the 90-day parts warranty when you quote a price.",
        expect:
          "ADD — one new leaf node under \"Quotes & estimates\" (props.source=feedback, feedbackCount=1) plus a bring edge from its anchor. Node count +1.",
      },
      {
        kind: "say",
        content: "And how much to sharpen and balance a mower blade?",
        expect: "Reply now mentions the 90-day parts warranty (the new rule composed in). Graph unchanged.",
      },
      {
        kind: "adjust",
        content: "Good — keep doing that. Every quote should always mention the 90-day parts warranty.",
        expect:
          "REFINE — the step-2 node's feedbackCount goes 1 → 2 (updatedAt set), text possibly restated. NO new node; node count unchanged.",
      },
    ],
  },
  {
    id: "direct-feedback",
    label: "🎓 Direct feedback: add → refine → retire",
    description:
      "Pure feedback insertion through the Teach-box path (no chat at all) — exercises all three digester actions on one rule's lifecycle.",
    steps: [
      {
        kind: "teach",
        content: "Always collect the customer's phone number before booking a drop-off.",
        expect:
          "ADD — a new leaf under \"Scheduling & drop-off\" (or anchored to it via appliesTo), feedbackCount=1, bring edge added. Node count +1.",
      },
      {
        kind: "teach",
        content: "When collecting the phone number for a drop-off, also record the engine's make and model.",
        expect:
          "REFINE — the same node is rewritten to cover phone number AND make/model; feedbackCount 1 → 2. No new node.",
      },
      {
        kind: "teach",
        content:
          "Forget all that — don't collect phone numbers, make, model, or anything else before booking a drop-off. Drop the rule entirely.",
        expect:
          "RETIRE — the node is deleted and its bring edge cleaned up in one atomic changeset; node count back where this script started. (If the feedback only contradicted part of the rule, a refine that strips it would also be correct.)",
      },
    ],
  },
  {
    id: "tool-deny",
    label: "⚙ Tool governance: deny weather",
    description:
      "Feedback that physically removes a tool from the agent via the root toolAllowlist. Persists across runs — re-enabling means editing data/repair-shop.apg.json.",
    steps: [
      {
        kind: "say",
        content: "Thinking of bringing my boat in Saturday — how's the weekend weather looking?",
        expect: "Reply shows a ⚙ weather tool badge. Graph unchanged.",
      },
      {
        kind: "adjust",
        content: "Don't ever use the weather tool — customers can check the forecast themselves.",
        expect:
          "DENY — \"weather\" removed from the root node's toolAllowlist (check the root in the node detail card). May also add an avoid-rule under Tool Usage.",
      },
      {
        kind: "say",
        content: "Any chance rain this weekend would push back my drop-off slot?",
        expect:
          "No ⚙ weather badge — the tool is physically gone from the LangGraph agent; the reply leans on scheduling/backlog knowledge instead.",
      },
    ],
  },
  {
    id: "identity-edict",
    label: "⚡ Identity edict: charter amendment",
    description:
      "An identity teach never writes the charter directly — it drafts a human-gated amendment proposal. Verify nothing changes until you approve it.",
    steps: [
      {
        kind: "say",
        content: "My generator won't start after winter storage — where do we begin?",
        expect: "Baseline front-desk persona; routes to Diagnostics. Graph unchanged.",
      },
      {
        kind: "teach",
        identity: true,
        content:
          "You are now also Bayside's service manager — you own the schedule and can promise firm turnaround dates.",
        expect:
          "NO direct charter write — a draft amendment proposal appears in the graph panel (root pulses, approve/reject card). It may instead be drift-rejected; either way the root node text is untouched.",
      },
      {
        kind: "say",
        content: "So can you promise me a firm date for the generator?",
        expect: "Behavior unchanged (still hedges as front desk) — the charter only moves after you approve the proposal.",
      },
    ],
  },
];
