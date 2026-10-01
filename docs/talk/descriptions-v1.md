# Talk description v1 — enterprise wisdom framing

**Suggested title:** *The Wisdom Graph: enterprise memory your agent tends itself*

**Angle:** brand alignment + the wall-of-text problem; for a product/enterprise-leaning
audience. Erik's revision, polished against the code paths (human gate = sign-off not command;
"harvest" kept as the repo's term of art; charter framing fixed; fallback claim removed — see
note below).

---

Context and prompting are how you align an agent with your enterprise brand and culture — so
customers feel they're talking to your product, not the model provider. The usual fix is a
wall of system prompt: edge cases, rare-product knowledge, critical policies, "DO this, DON'T
do that." It confuses the model and defies review. The Wisdom Graph is a different shape:
enterprise wisdom as a portable, schema-validated graph the agent maintains itself. It writes,
merges, and retires its own learnings from chat and feedback; only changes to the taxonomy's
shape or to the agent's identity need a human sign-off. Learning runs on three timescales
borrowed from biological memory: harvest while awake, consolidate during sleep, grow new
structure in deep sleep. Identity sits behind a constitution: the root charter frames every
prompt and amends only under sustained evidence pressure, within a drift cap. Every query
flows into the graph — route → resolve → compose → walk — and effects flow out for the host to
execute. The talk: the architecture plus a live demo — an agent visibly getting better at its
job, on a graph you can read, diff, roll back, and govern, scoped per tenant, user, or use
case.

---

*1,202 characters.*

**Cut but worth keeping for the talk itself:** the fallback fact. Fallback lives in the
*route* stage as a ladder (nearest ancestor `fallbackNodeId` → first `isFallback` node → root),
and in the wisdom demos unrouteable queries land in the **misfit pool**, not at the root — the
same pool deep-sleep growth clusters into new categories. Stage line: *"queries that fit
nowhere become the seeds of new structure."*
