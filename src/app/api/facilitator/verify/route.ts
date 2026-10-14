import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyPayment } from "@/x402/facilitator";
import { facilitatorRequestSchema } from "@/x402/schemas";
import { errorResponse, facilitatorContext, runtime as appRuntime } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 facilitator `/verify`: read-only simulation of the ERC-7710 path. */
export async function POST(request: NextRequest) {
  try {
    const parsed = facilitatorRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { isValid: false, invalidReason: "invalid_payload" },
        { status: 400 },
      );
    }
    const response = await verifyPayment(
      {
        x402Version: parsed.data.x402Version,
        paymentPayload: parsed.data.paymentPayload as never,
        paymentRequirements: parsed.data.paymentRequirements as never,
        paymentId: parsed.data.paymentId ?? null,
      },
      facilitatorContext(appRuntime()),
    );
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
