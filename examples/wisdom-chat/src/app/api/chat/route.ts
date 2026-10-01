import { NextResponse, after } from "next/server";
import { reply } from "@/lib/chat";
import { armIdleSleep } from "@/lib/consolidate";
import { getAgent, type ContextMode } from "@/lib/agents";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      agentId?: string;
      sessionId?: string;
      message?: string;
      contextMode?: ContextMode;
    };
    if (!body.message || body.message.trim() === "") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const agent = getAgent(body.agentId);
    const result = await reply(agent.id, body.sessionId, body.message.trim(), body.contextMode);
    // sleep-pressure trigger: (re)arm the idle timer after the response ships
    after(() => armIdleSleep(agent.id));
    return NextResponse.json({
      sessionId: result.session.id,
      reply: result.reply,
      routedTo: result.routedTo,
      toolCalls: result.toolCalls,
      contextStats: result.contextStats,
      harvested: result.harvested,
      autoSleep: result.autoSleep,
      session: result.session,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
