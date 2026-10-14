import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SetupRequiredError, ValidationError } from "@/shared/errors";
import { runContractStressTest } from "@/missions/stress";
import {
  errorResponse,
  publicOrigin,
  runtime as appRuntime,
  store,
} from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Explicit contract-path stress test (no DeepSeek): creates a fresh local
 * mission and fires three concurrent x402 purchases against the 0.05 budget.
 */
export async function POST(request: NextRequest) {
  try {
    const app = appRuntime();
    if (app.config.mode !== "local") {
      return NextResponse.json({ error: "local_demo_only" }, { status: 403 });
    }
    if (!app.owner || !app.config.relayerAddress || !app.executor) {
      throw new SetupRequiredError(
        "the policy stress test needs the local test owner/executor accounts",
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      address?: string;
      count?: number;
      action?: string;
    };
    if (body.action === "create") {
      const mission = await (await import("@/missions/service")).createLocalMission({
        runtime: app,
        store: store(),
        input: {
          title: "Policy stress test (no LLM)",
          task: "Contract budget stress test setup.",
          addresses: [(body.address ?? app.config.providerPayTo.code) as `0x${string}`],
        },
      });
      return NextResponse.json({ missionId: mission.id }, { status: 201 });
    }
    const address = (body.address ?? app.config.providerPayTo.code) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ValidationError("invalid address");
    }
    const result = await runContractStressTest({
      runtime: app,
      store: store(),
      baseUrl: publicOrigin(request),
      address,
      count: Math.min(Math.max(body.count ?? 3, 2), 6),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ValidationError) return errorResponse(error, 400);
    if (error instanceof SetupRequiredError) return errorResponse(error, 409);
    return errorResponse(error);
  }
}
