import { NextResponse } from "next/server";
import { getSession } from "@/lib/store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ session });
}
