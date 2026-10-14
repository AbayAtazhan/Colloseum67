import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ensureLocalSpendingFunds } from "@/payments/local-funding";
import { prepareMissionRevocation } from "@/missions/revoke";
import {
  errorResponse,
  revocationContext,
  runtime as appRuntime,
  store,
} from "../../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prepares an owner-signed revocation user operation. The response contains
 * the EIP-712 typed data for the wallet's `eth_signTypedData_v4`; the server
 * never sees the owner key.
 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const app = appRuntime();
    const mission = store().getMission(id);
    await ensureLocalSpendingFunds({
      mode: app.config.mode,
      publicClient: app.publicClient,
      token: app.config.token.address,
      deployerWallet: app.deployerWallet,
      smartAccountAddress: mission.smartAccountAddress,
    });
    const prepared = await prepareMissionRevocation(
      revocationContext(app),
      id,
    );
    return NextResponse.json(prepared);
  } catch (error) {
    return errorResponse(error);
  }
}
