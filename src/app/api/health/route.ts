import { NextResponse } from "next/server";
import { loadAppRuntime } from "@/payments/runtime";
import { USDC_BASE_SEPOLIA } from "@/payments/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public health endpoint: only public parameters, never keys. */
export async function GET() {
  try {
    const app = loadAppRuntime();
    return NextResponse.json({
      status: "ok",
      mode: app.config.mode,
      network: app.config.network,
      chainId: app.config.chainId,
      token: app.config.token,
      officialBaseSepoliaUsdc: USDC_BASE_SEPOLIA,
      executorAddress: app.config.executorAddress,
      relayerAddress: app.config.relayerAddress,
      missionPolicyEnforcer: app.config.enforcerAddress,
      recipients: app.config.recipients,
      deepseek: { hasKey: app.config.hasDeepSeekKey, fakeLlm: app.config.fakeLlm },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "misconfigured",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
