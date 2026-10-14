import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prepareMissionSchema } from "@/shared/schemas";
import { PolicyError, SetupRequiredError, ValidationError } from "@/shared/errors";
import { prepareWalletMission } from "@/missions/service";
import { errorResponse, runtime as appRuntime } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the unsigned root delegation and the EIP-712 payload for the user's
 * wallet to sign. Nothing is persisted; POST /api/missions submits it back.
 */
export async function POST(request: NextRequest) {
  try {
    const body = prepareMissionSchema.safeParse(await request.json());
    if (!body.success) {
      throw new ValidationError(
        body.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    }
    const prepared = await prepareWalletMission({
      runtime: appRuntime(),
      input: {
        title: body.data.title,
        task: body.data.task,
        addresses: body.data.addresses,
        scenario: body.data.scenario, positionUsd: body.data.positionUsd,
        ...(body.data.budgetUsdc ? { budgetUsdc: body.data.budgetUsdc } : {}),
      },
      ownerAddress: body.data.ownerAddress,
    });
    return NextResponse.json(prepared);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof PolicyError) return errorResponse(error, 400);
    if (error instanceof SetupRequiredError) return errorResponse(error, 409);
    return errorResponse(error);
  }
}
