import { NextResponse } from "next/server";
import { vetMeta } from "../../../../lib/compare";

export async function GET() {
  try {
    return NextResponse.json(vetMeta());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
