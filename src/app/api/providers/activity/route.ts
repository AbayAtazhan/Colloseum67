import type { NextRequest } from "next/server";
import { handleProviderRequest } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Paid activity-facts endpoint: 0.02 test USDC per request via x402 ERC-7710. */
export async function GET(request: NextRequest) {
  return handleProviderRequest(request, "activity");
}
