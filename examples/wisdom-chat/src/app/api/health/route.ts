import { NextResponse } from "next/server";
import { loadRootEnv } from "@/lib/env";

export async function GET() {
  loadRootEnv();
  return NextResponse.json({ hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
}
