import type { NextRequest } from "next/server";
import { SetupRequiredError, ValidationError } from "@/shared/errors";
import type { ProviderId } from "@/shared/types";
import { servePaidProvider } from "@/x402/server";
import {
  buildPaymentRequired,
  buildPaymentRequirements,
  type X402ServerConfig,
} from "@/x402/requirements";
import { settlePayment } from "@/x402/facilitator";
import {
  facilitatorContext,
  publicOrigin,
  runtime as appRuntime,
  store,
} from "../_lib";

/**
 * Shared provider endpoint logic. The route files are thin wrappers that only
 * pick the registered provider; the URL, price and payee always come from the
 * server-side registry.
 */
export async function handleProviderRequest(
  request: NextRequest,
  providerId: ProviderId,
) {
  try {
    const app = appRuntime();
    const relayerAddress = app.config.relayerAddress;
    if (!relayerAddress) {
      throw new SetupRequiredError("relayer address is not configured");
    }
    const provider = app.providers[providerId];
    const url = new URL(request.url);
    let args;
    try {
      args = provider.parseArgs(url.searchParams);
    } catch (error) {
      if (error instanceof ValidationError) {
        return Response.json(
          { error: "invalid_request", message: error.message },
          { status: 400 },
        );
      }
      throw error;
    }
    const config: X402ServerConfig = {
      chainId: app.config.chainId,
      network: app.config.network,
      token: app.config.token,
      relayerAddress,
      maxTimeoutSeconds: 120,
      resourceBaseUrl: publicOrigin(request),
    };
    const requirements = buildPaymentRequirements(provider, config);
    const required = buildPaymentRequired(
      provider,
      config,
      "PAYMENT-SIGNATURE header is required",
    );
    return await servePaidProvider(request, args, {
      store: store(),
      provider,
      requirements,
      required,
      facilitator: {
        settle: (facilitatorRequest) =>
          settlePayment(facilitatorRequest, facilitatorContext(app)),
      },
      dataContext: app.providerContext,
      network: app.config.network,
    });
  } catch (error) {
    if (error instanceof SetupRequiredError) {
      return Response.json(
        { error: "setup_required", message: error.message },
        { status: 503 },
      );
    }
    return Response.json(
      {
        error: "server_error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
