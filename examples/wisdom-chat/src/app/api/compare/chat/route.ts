import { NextResponse } from "next/server";
import { compareReply } from "../../../../lib/compare";
import type { CompareMode } from "../../../../lib/compare-store";

export async function POST(req: Request) {
  try {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 503 });
    }
    const body = (await req.json()) as { sessionId?: string; message?: string; mode?: string; runBoth?: boolean };
    if (!body.message?.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });
    if (body.mode !== "monolith" && body.mode !== "graph") {
      return NextResponse.json({ error: "mode must be monolith or graph" }, { status: 400 });
    }
    const result = await compareReply(body.sessionId, body.message.trim(), body.mode as CompareMode, {
      runBoth: body.runBoth === true,
    });
    return NextResponse.json({
      sessionId: result.session.id,
      reply: result.active.reply,
      metrics: result.active.metrics,
      ...(result.alt ? { alt: result.alt } : {}),
      session: result.session,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
