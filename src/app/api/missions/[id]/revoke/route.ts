import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { PolicyError, SetupRequiredError } from "@/shared/errors";
import { addressSchema, hexSchema } from "@/shared/schemas";
import {
  prepareMissionRevocation,
  signRevocationWithAccount,
  submitMissionRevocation,
} from "@/missions/revoke";
import {
  errorResponse,
  revocationContext,
  runtime as appRuntime,
  store,
} from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const userOpSchema = z.object({
  sender: addressSchema,
  nonce: z.string().regex(/^[0-9]+$/),
  callData: hexSchema,
  callGasLimit: z.string().regex(/^[0-9]+$/),
  verificationGasLimit: z.string().regex(/^[0-9]+$/),
  preVerificationGas: z.string().regex(/^[0-9]+$/),
  maxFeePerGas: z.string().regex(/^[0-9]+$/),
  maxPriorityFeePerGas: z.string().regex(/^[0-9]+$/),
  entryPoint: addressSchema,
});

const revokeBodySchema = z.object({
  userOp: userOpSchema.optional(),
  signature: hexSchema.optional(),
});

/**
 * Revokes the mission root.
 *  - Browser flow: the client returns the owner-signed user operation from
 *    `/revoke/prepare`; the server validates and submits it (no owner key).
 *  - Local test fallback: when the server holds the matching test owner key it
 *    signs the same operation itself (used by the server-signed demo/CLI).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const app = appRuntime();
    const mission = store().getMission(id);
    const body = revokeBodySchema.safeParse(
      await request.json().catch(() => ({})),
    );
    if (!body.success) {
      return NextResponse.json(
        { error: "invalid_request", message: "invalid revocation payload" },
        { status: 400 },
      );
    }
    const revocation = revocationContext(app);

    if (body.data.userOp && body.data.signature) {
      const txHash = await submitMissionRevocation(revocation, {
        missionId: id,
        userOp: body.data.userOp,
        signature: body.data.signature,
      });
      return NextResponse.json({ txHash, status: "revoked" });
    }

    if (
      app.config.mode === "local" &&
      app.owner &&
      mission.ownerAddress.toLowerCase() === app.owner.address.toLowerCase()
    ) {
      const prepared = await prepareMissionRevocation(revocation, id);
      const signature = await signRevocationWithAccount(app.owner, prepared);
      const txHash = await submitMissionRevocation(revocation, {
        missionId: id,
        userOp: prepared.userOp,
        signature,
      });
      return NextResponse.json({ txHash, status: "revoked", serverSigned: true });
    }

    throw new SetupRequiredError(
      "connect the wallet that owns this mission and sign the revocation request",
    );
  } catch (error) {
    if (error instanceof PolicyError) return errorResponse(error, 400);
    if (error instanceof SetupRequiredError) {
      return NextResponse.json(
        { error: "owner_signature_required", message: error.message },
        { status: 409 },
      );
    }
    return errorResponse(error);
  }
}
