import { NextResponse, after } from "next/server";
import { digestFeedback } from "@/lib/feedback";
import { armIdleSleep } from "@/lib/consolidate";
import { getAgent } from "@/lib/agents";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      agentId?: string;
      sessionId?: string;
      messageIndex?: number;
      comment?: string;
      identity?: boolean;
    };
    if (!body.comment?.trim()) {
      return NextResponse.json({ error: "comment is required" }, { status: 400 });
    }
    if (body.messageIndex !== undefined && !body.sessionId) {
      return NextResponse.json({ error: "messageIndex requires a sessionId" }, { status: 400 });
    }
    const agent = getAgent(body.agentId);
    const result = await digestFeedback(agent.id, body.sessionId, body.messageIndex, body.comment.trim(), body.identity === true);
    after(() => armIdleSleep(agent.id));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
