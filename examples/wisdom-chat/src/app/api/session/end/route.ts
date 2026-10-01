import { NextResponse, after } from "next/server";
import { endSession } from "@/lib/chat";
import { maybeSleep } from "@/lib/consolidate";
import { getAgent, memoryPolicy } from "@/lib/agents";
import { loadAgentGraph } from "@/lib/store";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 503 });
  }
  try {
    const body = (await req.json()) as { sessionId?: string };
    if (!body.sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    const result = await endSession(body.sessionId);
    // bedtime trigger: the conversation is over — consolidate after the response ships
    const agent = getAgent(result.session.agentId);
    after(async () => {
      const { doc } = await loadAgentGraph(agent);
      if (memoryPolicy(agent, doc.meta).sleep.onSessionEnd) {
        await maybeSleep(agent.id, "sessionEnd").catch(() => {});
      }
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
