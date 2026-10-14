import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createMissionSchema } from "@/shared/schemas";
import { PolicyError, SetupRequiredError, ValidationError } from "@/shared/errors";
import {
  createLocalMission,
  submitWalletMission,
} from "@/missions/service";
import { errorResponse, runtime as appRuntime, store } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Creates a mission. `local` uses the server-side test owner; `wallet` requires an owner-signed root. */
export async function POST(request: NextRequest) {
  try {
    const body = createMissionSchema.safeParse(await request.json());
    if (!body.success) {
      throw new ValidationError(
        body.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    }
    const app = appRuntime();
    if (body.data.mode === "local" && app.config.mode !== "local") {
      return NextResponse.json({ error: "local_demo_only", message: "Use a wallet-signed permission on Base Sepolia." }, { status: 403 });
    }
    const mission =
      body.data.mode === "local"
        ? await createLocalMission({
            runtime: app,
            store: store(),
            input: {
              title: body.data.title,
              task: body.data.task,
              addresses: body.data.addresses,
              scenario: body.data.scenario, positionUsd: body.data.positionUsd,
              ...(body.data.budgetUsdc ? { budgetUsdc: body.data.budgetUsdc } : {}),
            },
          })
        : await submitWalletMission({
            runtime: app,
            store: store(),
            input: {
              title: body.data.title,
              task: body.data.task,
              addresses: body.data.addresses,
              scenario: body.data.scenario, positionUsd: body.data.positionUsd,
              ...(body.data.budgetUsdc ? { budgetUsdc: body.data.budgetUsdc } : {}),
            },
            ownerAddress: body.data.ownerAddress,
            delegation: body.data.delegation,
            signature: body.data.signature,
          });
    return NextResponse.json(
      {
        missionId: mission.id,
        smartAccountAddress: mission.smartAccountAddress,
        rootDelegationHash: mission.rootDelegationHash,
        rootDelegation: mission.rootDelegation,
        policy: {
          chainId: mission.policy.chainId,
          token: mission.policy.token,
          budget: mission.policy.budget.toString(),
          perCallMax: mission.policy.perCallMax.toString(),
          recipients: mission.policy.recipients,
          validAfter: mission.policy.validAfter,
          validBefore: mission.policy.validBefore,
          redeemer: mission.policy.redeemer,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ValidationError || error instanceof PolicyError) {
      return errorResponse(error, 400);
    }
    if (error instanceof SetupRequiredError) {
      return errorResponse(error, 409);
    }
    return errorResponse(error);
  }
}
