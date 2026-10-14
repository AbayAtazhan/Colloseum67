import { NextResponse } from "next/server";
import { getDefaultStore, type Store } from "@/store";
import { SetupRequiredError } from "@/shared/errors";
import { loadAppRuntime, type AppRuntime } from "@/payments/runtime";
import { RelayerQueue, type FacilitatorContext } from "@/x402/facilitator";
import type { RevocationContext } from "@/missions/revoke";

/** Shared helpers for API routes. Server-only. */

export function store(): Store {
  return getDefaultStore();
}

export function runtime(): AppRuntime {
  return loadAppRuntime();
}

export function publicOrigin(request: Request): string {
  return (
    process.env.SWARM_TAB_PUBLIC_URL ?? new URL(request.url).origin
  );
}

export function facilitatorContext(
  app: AppRuntime,
  onSettled?: FacilitatorContext["onSettled"],
): FacilitatorContext {
  const relayer = app.relayer ?? app.executor;
  const walletClient = app.relayerWallet ?? app.executorWallet;
  if (!relayer || !walletClient) {
    throw new SetupRequiredError(
      "the facilitator/relayer key is not configured; set RELAYER_PRIVATE_KEY (or EXECUTOR_PRIVATE_KEY)",
    );
  }
  return {
    publicClient: app.publicClient,
    walletClient,
    relayerAddress: relayer.address,
    delegationManager: app.environment.DelegationManager,
    chainId: app.config.chainId,
    budgetEnforcerAddress: app.config.budgetEnforcerAddress,
    queue:
      app.relayerQueue ??
      new RelayerQueue(app.publicClient, relayer.address),
    ...(onSettled ? { onSettled } : {}),
  };
}

/** Gas-paying context for owner-authorized smart-account user operations. */
export function revocationContext(app: AppRuntime): RevocationContext {
  const walletClient =
    app.deployerWallet ?? app.relayerWallet ?? app.executorWallet;
  const beneficiary =
    app.config.deployerAddress ??
    app.config.relayerAddress ??
    app.config.executorAddress;
  if (!walletClient || !beneficiary) {
    throw new SetupRequiredError(
      "no testnet gas account is configured for owner-authorized user operations",
    );
  }
  return {
    store: store(),
    publicClient: app.publicClient,
    walletClient,
    beneficiary,
    entryPoint: app.environment.EntryPoint,
    chainId: app.config.chainId,
    environment: app.environment,
  };
}

export function errorResponse(error: unknown, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof SetupRequiredError
      ? "setup_required"
      : status === 400
        ? "invalid_request"
        : "server_error";
  return NextResponse.json({ error: code, message }, { status });
}
