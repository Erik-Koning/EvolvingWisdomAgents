import { NextResponse } from "next/server";
import { listCompareSessions } from "../../../../lib/compare-store";

export async function GET() {
  try {
    return NextResponse.json({ sessions: listCompareSessions() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
