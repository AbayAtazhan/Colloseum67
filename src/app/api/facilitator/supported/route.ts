import { NextResponse } from "next/server";
import { loadAppRuntime } from "@/payments/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 facilitator discovery endpoint (spec section 7.3). */
export async function GET() {
  const app = loadAppRuntime();
  const relayer = app.config.relayerAddress;
  return NextResponse.json({
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: app.config.network,
        extra: {
          assetTransferMethod: "erc7710",
          paymentFlow: "upfront",
        },
      },
    ],
    extensions: [],
    signers: relayer ? { "eip155:*": [relayer] } : {},
  });
}
