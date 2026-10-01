# Talk description v5 — CFP framing, accuracy-fixed

**Suggested title:** *Beyond Prompt Engineering: The Wisdom Graph for Self-Learning Agents*

**Angle:** v4's program-committee register with the three accuracy fixes applied and one
concrete mechanism sentence added (so a technical reviewer sees a falsifiable claim). This is
the submission-ready CFP version; use v1 for landing-page/speaker-blurb copy.

Fixes over v4: "separates wisdom from **hand-written** prompts" + the compiled-artifact clause
(the graph *is* the prompt source — no RAG misreading); "graph-based **memory and routing**"
(not "reasoning"); tenant/user/use-case scoping decoupled from the live-demo sentence (library
capability, not demoed).

---

Enterprise AI agents are often aligned through massive system prompts filled with policies,
edge cases, product knowledge, and behavioral rules. As prompts grow, they become difficult to
govern, review, and evolve.

This session introduces the Wisdom Graph, a schema-validated knowledge graph that separates
enterprise wisdom from hand-written prompts. The system prompt becomes a compiled artifact,
assembled per query from the graph. Instead of relying on static instructions, agents capture,
consolidate, refine, and retire knowledge from conversations and human feedback while
remaining observable and governed. Inspired by biological memory, learning runs from real-time
harvest through sleep-time consolidation to structural growth in deep sleep, with identity
guarded by a drift-capped, human-approved charter.

Attendees will learn how constitutional governance, controlled drift, and graph-based memory
and routing enable agents to improve continuously without losing alignment. The session
concludes with a live demo of a self-improving agent whose knowledge can be inspected,
versioned, audited, diffed, and rolled back; the same graph can be scoped per tenant, user, or
use case.

---

*1,192 characters.*


Enterprise AI agents are often aligned through massive system prompts filled with policies, edge cases, product knowledge, and behavioral rules. As prompts grow, they become difficult to govern, review, and evolve.

This session introduces the Wisdom Graph, a schema-validated knowledge graph that separates enterprise wisdom from hand-written prompts. The system prompt becomes a compiled artifact, and any human-approved charter is assembled per query from the graph. Instead of relying on static instructions, agents capture, consolidate, refine, and retire knowledge from conversations and human feedback while
remaining observable and governed. Inspired by biological memory systems, learning occurs across multiple timescales, from real-time capture to long-term knowledge evolution. 

Attendees will learn how constitutional governance, controlled drift, and graph-based memory and routing enable agents to improve continuously without losing alignment. The session
concludes with a live demo of a self-improving agent whose knowledge can be inspected, versioned, audited, diffed, and rolled back; the same graph can be scoped per tenant, user, or use case.



---

How it helps MCP

Most MCP servers wrap an API. This talk shows MCP carrying a full agent runtime — routing, prompt composition, and self-evolving memory — via a reusable mapping: nouns as Resources, verbs as Tools, identities as Prompts, approvals as Elicitation. It demonstrates elicitation as a server-enforced human-governance gate and live resource/prompt notifications as the agent learns — giving server authors patterns to lift directly, and client authors a concrete reason to prioritize elicitation support.
