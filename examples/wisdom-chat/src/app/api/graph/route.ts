import { NextResponse } from "next/server";
import { Graph } from "@apgraph/core";
import { getAgent, memoryPolicy } from "@/lib/agents";
import { consolidationStatus } from "@/lib/consolidate";
import { changesetStore, getAgentState, listProposals, loadAgentGraph, loadAgentVersion, listAgentVersions } from "@/lib/store";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const agent = getAgent(url.searchParams.get("agent"));
    const version = url.searchParams.get("version");
    const doc = version ? await loadAgentVersion(agent, version) : (await loadAgentGraph(agent)).doc;
    const versions = await listAgentVersions(agent);
    const policy = memoryPolicy(agent, doc.meta);
    const consolidation = consolidationStatus(new Graph(doc), policy.sleep.threshold);
    const state = getAgentState(agent.id);
    const draft = listProposals(agent.id, "draft")[0] ?? null;
    // latest pending deep-sleep growth changeset, summarized for the card
    const pendingGrowth = (await changesetStore().list())
      .filter((c) => c.id.startsWith("grow-") && (c.status === "draft" || c.status === "validated"))
      .sort((a, b) => b.id.localeCompare(a.id))[0];
    const growth = pendingGrowth
      ? {
          id: pendingGrowth.id,
          status: pendingGrowth.status,
          newCategories: pendingGrowth.ops
            .filter((o) => o.op === "addNode")
            .map((o) => ({ id: (o as { node: { id: string; title?: string } }).node.id, title: (o as { node: { title?: string } }).node.title })),
          moved: pendingGrowth.ops.filter((o) => o.op === "moveNode").length,
          regression: (pendingGrowth.regression as { passRate?: number; stolen?: unknown[] } | undefined)
            ? {
                passRate: (pendingGrowth.regression as { passRate: number }).passRate,
                stolen: ((pendingGrowth.regression as { stolen: unknown[] }).stolen ?? []).length,
              }
            : null,
        }
      : null;
    return NextResponse.json({
      growth,
      doc,
      version: doc.version,
      versions,
      agentId: agent.id,
      consolidation,
      pressure: {
        open: state.pressure.filter((p) => p.status === "open").length,
        threshold: policy.transcendence.pressureThreshold,
        score: policy.transcendence.score,
      },
      proposal: draft,
      lastSleep: { at: state.lastSleepAt, summary: state.lastSleepSummary },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
