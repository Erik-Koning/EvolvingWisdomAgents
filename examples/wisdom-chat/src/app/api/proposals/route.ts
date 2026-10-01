import { NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { listProposals } from "@/lib/store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent = getAgent(url.searchParams.get("agent"));
  const status = url.searchParams.get("status") as "draft" | null;
  return NextResponse.json({ proposals: listProposals(agent.id, status ?? undefined) });
}
