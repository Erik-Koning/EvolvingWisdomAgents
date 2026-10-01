import { NextResponse } from "next/server";
import { approveAmendment, rejectAmendment } from "@/lib/transcend";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    const { id, action } = await params;
    if (action === "approve") return NextResponse.json({ proposal: await approveAmendment(id) });
    if (action === "reject") return NextResponse.json({ proposal: rejectAmendment(id) });
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
