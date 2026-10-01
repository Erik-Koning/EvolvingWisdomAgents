import { NextResponse } from "next/server";
import { maybeSleep, type SleepReason } from "@/lib/consolidate";
import { getAgent } from "@/lib/agents";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 503 });
  }
  // optional shared secret for external schedulers (cron) hitting this route
  const secret = process.env.CONSOLIDATE_SECRET;
  const authorized = !secret || req.headers.get("authorization") === `Bearer ${secret}`;
  try {
    const body = (await req.json().catch(() => ({}))) as { agentId?: string; reason?: SleepReason };
    const reason: SleepReason = body.reason === "cron" ? "cron" : "manual";
    if (reason === "cron" && !authorized) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const agent = getAgent(body.agentId);
    const result = await maybeSleep(agent.id, reason);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
