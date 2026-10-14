import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveLlmConfig, createLlmClient, LlmSetupRequiredError } from "@/agents/llm";
import { isMissionRunning, startMissionRun } from "@/agents/runner";
import {
  errorResponse,
  runtime as appRuntime,
  store,
} from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts the two-agent DeepSeek scenario in the background. Returns 202
 * immediately; the UI follows progress through GET /api/state.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const missionStore = store();
    const mission = missionStore.findMission(id);
    if (!mission) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (mission.status !== "active") {
      return NextResponse.json(
        { error: "mission_not_active", status: mission.status },
        { status: 409 },
      );
    }
    if (isMissionRunning(id)) {
      return NextResponse.json({ started: false, running: true }, { status: 202 });
    }
    const missionContext = missionStore
      .listEvents(id)
      .find((event) => event.type === "mission.context")?.payload as
      | { task?: string; addresses?: string[]; scenario?: "research" | "exit-check"; positionUsd?: string }
      | undefined;
    if (!missionContext?.task || !missionContext.addresses?.length) {
      return NextResponse.json(
        { error: "mission_context_missing" },
        { status: 409 },
      );
    }

    const llmConfig = resolveLlmConfig();
    let llm;
    try {
      llm = createLlmClient(llmConfig);
    } catch (error) {
      if (error instanceof LlmSetupRequiredError) {
        return NextResponse.json(
          { error: "deepseek_setup_required", message: error.message },
          { status: 409 },
        );
      }
      throw error;
    }
    const app = appRuntime();
    const result = startMissionRun({
      missionId: id,
      task: missionContext.task,
      addresses: missionContext.addresses as `0x${string}`[],
      scenario: missionContext.scenario, positionUsd: missionContext.positionUsd,
      deps: {
        store: missionStore,
        runtime: app,
        llm,
        publicClient: app.publicClient,
        baseUrl: process.env.SWARM_TAB_PUBLIC_URL ?? new URL(request.url).origin,
      },
    });
    missionStore.appendEvent({
      missionId: id,
      type: "mission.scenario.started",
      payload: {
        fixture: llm.fixture,
        model: llm.model,
        started: result.started,
      },
    });
    return NextResponse.json(
      { started: result.started, running: true, fixture: llm.fixture },
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
