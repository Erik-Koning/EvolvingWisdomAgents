import { NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { createSession, listSessions } from "@/lib/store";

export async function GET(req: Request) {
  const agent = getAgent(new URL(req.url).searchParams.get("agent"));
  return NextResponse.json({ sessions: listSessions(agent.id) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { agentId?: string };
  const agent = getAgent(body.agentId);
  return NextResponse.json({ session: createSession(agent.id) });
}
