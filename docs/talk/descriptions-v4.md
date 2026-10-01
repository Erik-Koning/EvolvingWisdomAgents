# Talk description v4 — CFP / program-committee framing

**Suggested title:** *Beyond Prompt Engineering: The Wisdom Graph for Self-Learning Agents*

**Angle:** formal conference-abstract register ("This session introduces… Attendees will
learn…") — written to scan well for a program committee. Erik's draft, saved verbatim; accuracy
notes below rather than silent edits.

---

Enterprise AI agents are often aligned through massive system prompts filled with policies,
edge cases, product knowledge, and behavioral rules. As prompts grow, they become difficult to
govern, review, and evolve.

This session introduces the Wisdom Graph, a schema-validated knowledge graph that separates
enterprise wisdom from prompts. Instead of relying on static instructions, agents can capture,
consolidate, refine, and retire knowledge from conversations and human feedback while
remaining observable and governed. Inspired by biological memory systems, learning occurs
across multiple timescales, from real-time capture to long-term knowledge evolution.

Attendees will learn how constitutional governance, controlled drift, and graph-based
reasoning enable agents to improve continuously without losing alignment. The session
concludes with a live demo of a self-improving agent whose knowledge can be inspected,
versioned, audited, diffed, and rolled back across tenant, user, or use-case boundaries.

---

*1,012 characters.*

**Accuracy notes (fix before submitting):**

1. *"separates enterprise wisdom from prompts"* — slightly misleading: the graph doesn't
   bypass prompting; it **is** the prompt source (compose compiles the system prompt from it
   per query). Say "separates enterprise wisdom from **hand-written** prompts" or "replaces
   the static prompt with a compiled one" — otherwise it reads like RAG.
2. *"graph-based reasoning"* — overclaims to a technical audience; the kernel does routing,
   composition, and deterministic flow-walking, not graph reasoning in the graph-ML sense.
   Safer: "graph-based memory and routing."
3. *"across tenant, user, or use-case boundaries"* — true as a library capability
   (GraphLayers: base ⊕ tenant ⊕ user, fixture-pinned); the current demo doesn't exercise
   per-user layers, so don't promise it in the live-demo sentence specifically.
