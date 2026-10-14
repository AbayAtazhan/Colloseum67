import type { Store } from "@/store";
import {
  RelayerQueue,
  settlePayment,
  type FacilitatorContext,
} from "@/x402/facilitator";
import {
  buildPaymentRequired,
  buildPaymentRequirements,
  type X402ServerConfig,
} from "@/x402/requirements";
import { servePaidProvider } from "@/x402/server";
import { createProviderDefinitions } from "@/providers/data";
import type { ProviderId } from "@/shared/types";
import { ValidationError } from "@/shared/errors";
import type { TestContext } from "./context";

export interface X402Harness {
  providers: ReturnType<typeof createProviderDefinitions>;
  fetchImpl: typeof fetch;
  facilitator: FacilitatorContext;
  serverConfig: X402ServerConfig;
  baseUrl: string;
  /** Directly serves one provider request (used by idempotency tests). */
  serve(providerId: ProviderId, request: Request): Promise<Response>;
}

/**
 * In-process fetch adapter that serves the real provider route logic for a
 * local chain, so integration tests exercise the full HTTP x402 handshake
 * (402 -> PAYMENT-SIGNATURE -> settle -> paid body) without binding a port.
 */
export function createX402Harness(ctx: TestContext, store: Store, dataFetch: typeof fetch = fetch): X402Harness {
  const providers = createProviderDefinitions({
    codePayTo: ctx.meta.recipient1,
    activityPayTo: ctx.meta.recipient2,
    chainId: ctx.meta.chainId,
  });
  const facilitator: FacilitatorContext = {
    publicClient: ctx.publicClient,
    walletClient: ctx.relayerWallet,
    relayerAddress: ctx.meta.relayerAddress,
    delegationManager: ctx.meta.environment.DelegationManager,
    chainId: ctx.meta.chainId,
    budgetEnforcerAddress:
      ctx.meta.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    queue: new RelayerQueue(ctx.publicClient, ctx.meta.relayerAddress),
  };
  const serverConfig: X402ServerConfig = {
    chainId: ctx.meta.chainId,
    network: `eip155:${ctx.meta.chainId}`,
    token: { address: ctx.meta.tokenAddress, symbol: "USDC", decimals: 6 },
    relayerAddress: ctx.meta.relayerAddress,
    maxTimeoutSeconds: 120,
    resourceBaseUrl: "http://swarm.test",
  };

  const serve = async (
    providerId: ProviderId,
    request: Request,
  ): Promise<Response> => {
    const provider = providers[providerId];
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
    const requirements = buildPaymentRequirements(provider, serverConfig);
    const required = buildPaymentRequired(
      provider,
      serverConfig,
      "PAYMENT-SIGNATURE header is required",
    );
    return servePaidProvider(request, args, {
      store,
      provider,
      requirements,
      required,
      facilitator: {
        settle: (facilitatorRequest) =>
          settlePayment(facilitatorRequest, facilitator),
      },
      dataContext: {
        rpcUrl: ctx.meta.rpcUrl,
        chainId: ctx.meta.chainId,
        fetch: dataFetch,
      },
      network: serverConfig.network,
    });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const match = /\/api\/providers\/(code|activity|market|exit)$/.exec(url.pathname);
    if (!match) throw new Error(`unexpected URL in test fetch: ${url}`);
    const request = new Request(url, {
      method: init?.method ?? "GET",
      headers: new Headers(
        (init?.headers ?? undefined) as HeadersInit | undefined,
      ),
    });
    return serve(match[1] as ProviderId, request);
  };

  return {
    providers,
    fetchImpl,
    facilitator,
    serverConfig,
    baseUrl: "http://swarm.test",
    serve,
  };
}
