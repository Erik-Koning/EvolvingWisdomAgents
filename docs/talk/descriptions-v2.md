# Talk description v2 — MCP / operating-system framing

**Suggested title:** *An Operating System for Prompts: APG, MCP, and the self-rewriting agent*

**Angle:** architecture-first, for an MCP/infra conference audience. Leads with the OS analogy
and the two-runtime conformance discipline; MCP as the syscall interface is the hook.

---

What if the prompt were a program? This talk presents the Adaptive Prompt Graph (APG): an
operating system for prompts. An agent's behavior lives in a portable JSON graph — taxonomy
edges say where a query belongs, bring edges say what an answer needs, flow edges say what
happens next. A small deterministic kernel executes it (route → resolve → compose → walk →
effects) with exactly one LLM call per route and byte-stable everything else, pinned by 64
conformance fixtures that twin TypeScript and Python kernels must both pass. Models, stores,
and tools plug in as drivers; MCP is the syscall interface: the graph is served as resources
and prompts, its algorithms as tools, and the human approval gate is enforced through
capability negotiation — a client that can't elicit is refused the commit. Because behavior is
data, the agent can rewrite it safely: every memory is a diffable node, every change an
audited operation behind graduated governance. We'll tour the kernel, the MCP mapping, and a
live self-evolving agent — and argue the leverage isn't in the human-authored prompt but in
the governed representation beside it.

---

*1,133 characters.*
