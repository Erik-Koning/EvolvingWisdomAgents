import { NextResponse } from "next/server";
import { getCompareSession } from "../../../../../lib/compare-store";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const session = getCompareSession(id);
    if (!session) return NextResponse.json({ error: `Unknown session: ${id}` }, { status: 404 });
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
