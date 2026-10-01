import { NextResponse } from "next/server";
import {
  Graph,
  approveChangeset,
  commitChangeset,
  discardChangeset,
  labeledFromMeta,
  validateChangeset,
} from "@apgraph/core";
import { getAgent } from "@/lib/agents";
import { llm } from "@/lib/llm";
import {
  changesetStore,
  loadAgentDocFresh,
  saveAgentDocUnlocked,
  withAgentLock,
} from "@/lib/store";

/** Approve or reject a deep-sleep growth changeset (the human gate). */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { agentId?: string; id?: string; action?: "approve" | "reject" };
    if (!body.id || !body.action) return NextResponse.json({ error: "id and action are required" }, { status: 400 });
    const agent = getAgent(body.agentId);
    const store = changesetStore();
    let cs = await store.get(body.id);
    if (!cs) return NextResponse.json({ error: `unknown changeset: ${body.id}` }, { status: 404 });

    if (body.action === "reject") {
      cs = discardChangeset(cs);
      await store.put(cs);
      return NextResponse.json({ changeset: cs });
    }

    const result = await withAgentLock(agent.id, async () => {
      const fresh = await loadAgentDocFresh(agent);
      // the base moved since drafting → conservative re-validation against it
      if (cs!.baseGraphVersion !== fresh.version) {
        cs = await validateChangeset(fresh, { ...cs!, status: "draft" }, {
          labeled: labeledFromMeta(new Graph(fresh)),
          connectors: { llm },
        });
        await store.put(cs);
        if (cs.status !== "validated") return { blocked: true as const, changeset: cs };
      }
      cs = approveChangeset(cs!);
      const committed = commitChangeset(fresh, cs);
      await saveAgentDocUnlocked(agent, committed.doc, {
        actor: "sleep",
        summary: `growth committed: ${cs.id}`,
        expectedVersion: fresh.version,
      });
      await store.put(committed.changeset);
      return { blocked: false as const, changeset: committed.changeset, version: committed.doc.version };
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
