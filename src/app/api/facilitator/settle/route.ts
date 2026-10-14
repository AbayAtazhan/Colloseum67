import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { settlePayment, type FacilitatorRequest } from "@/x402/facilitator";
import { facilitatorRequestSchema, type FacilitatorRequestBody } from "@/x402/schemas";
import { errorResponse, facilitatorContext, runtime as appRuntime } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toFacilitatorRequest(body: FacilitatorRequestBody): FacilitatorRequest {
  return {
    x402Version: body.x402Version,
    paymentPayload: body.paymentPayload as PaymentPayload,
    paymentRequirements: body.paymentRequirements as PaymentRequirements,
    paymentId: body.paymentId ?? null,
  };
}

/** x402 facilitator `/settle`: verify, broadcast and confirm the redemption. */
export async function POST(request: NextRequest) {
  try {
    const parsed = facilitatorRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, errorReason: "invalid_payload", transaction: "" },
        { status: 400 },
      );
    }
    const response = await settlePayment(
      toFacilitatorRequest(parsed.data),
      facilitatorContext(appRuntime()),
    );
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
