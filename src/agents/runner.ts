import type { Address } from "viem";
import type { MissionReport } from "@/shared/types";
import { runMissionScenario, type OrchestratorDeps } from "./orchestrator";
import type { MissionScenario } from "@/shared/exit-check";

interface RunningMission {
  startedAt: number;
  promise: Promise<MissionReport>;
}

const running = new Map<string, RunningMission>();

export function isMissionRunning(missionId: string): boolean {
  return running.has(missionId);
}

/**
 * Starts the mission scenario in the background. A mission can only run once
 * at a time; the promise is kept so the UI can report a running state while
 * polling the journal.
 */
export function startMissionRun(params: {
  missionId: string;
  task: string;
  addresses: Address[];
  scenario?: MissionScenario;
  positionUsd?: string;
  deps: OrchestratorDeps;
}): { started: boolean; promise: Promise<MissionReport> | null } {
  if (running.has(params.missionId)) {
    return { started: false, promise: null };
  }
  const promise = runMissionScenario({
    missionId: params.missionId,
    task: params.task,
    addresses: params.addresses,
    scenario: params.scenario, positionUsd: params.positionUsd,
    deps: params.deps,
  })
    .catch((error) => {
      params.deps.store.appendEvent({
        missionId: params.missionId,
        type: "mission.scenario.failed",
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    })
    .finally(() => {
      running.delete(params.missionId);
    });
  // Prevent an unhandled rejection if nobody awaits the background promise.
  promise.catch(() => undefined);
  running.set(params.missionId, { startedAt: Date.now(), promise });
  return { started: true, promise };
}
