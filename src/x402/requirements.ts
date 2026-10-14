import { getAddress, type Address } from "viem";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { ValidationError } from "@/shared/errors";
import type { TokenInfo } from "@/shared/types";
import type { ProviderDefinition } from "@/providers/types";

export function toCaip2(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`;
}

export function fromCaip2(network: string): number {
  const match = /^eip155:([0-9]+)$/.exec(network);
  if (!match) throw new ValidationError(`unsupported network: ${network}`);
  return Number(match[1]);
}

export interface X402ServerConfig {
  chainId: number;
  network: `${string}:${string}`;
  token: TokenInfo;
  relayerAddress: Address;
  maxTimeoutSeconds: number;
  resourceBaseUrl: string;
}

/**
 * Builds the `exact` / ERC-7710 payment requirements for one provider.
 *
 * `paymentFlow: "upfront"` is declared because the provider settles (and waits
 * for confirmation) before serving data, so the paid result can never be
 * returned on the strength of verification alone.
 */
export function buildPaymentRequirements(
  provider: ProviderDefinition,
  config: X402ServerConfig,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    amount: provider.price.toString(),
    asset: getAddress(config.token.address),
    payTo: getAddress(provider.payTo),
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      assetTransferMethod: "erc7710",
      paymentFlow: "upfront",
      name: config.token.symbol,
      version: "2",
      facilitatorAddresses: [getAddress(config.relayerAddress)],
      providerId: provider.id,
    },
  };
}

export function buildPaymentRequired(
  provider: ProviderDefinition,
  config: X402ServerConfig,
  error: string,
): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: {
      url: `${config.resourceBaseUrl.replace(/\/$/, "")}${provider.path}`,
      description: provider.description,
      mimeType: "application/json",
      serviceName: "SWARM TAB data",
    },
    accepts: [buildPaymentRequirements(provider, config)],
  };
}

function sameAddress(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Requires the client's `accepted` requirements to be exactly the server's
 * advertised terms. This prevents a client from paying a different amount,
 * token or payee than the resource asked for.
 */
export function assertAcceptedMatches(
  accepted: PaymentRequirements,
  requirements: PaymentRequirements,
): void {
  if (accepted.scheme !== requirements.scheme) {
    throw new ValidationError("invalid_scheme");
  }
  if (accepted.network !== requirements.network) {
    throw new ValidationError("invalid_network");
  }
  if (accepted.asset !== requirements.asset) {
    throw new ValidationError("invalid_exact_evm_payload_asset_mismatch");
  }
  if (accepted.amount !== requirements.amount) {
    throw new ValidationError(
      "invalid_exact_evm_payload_authorization_value_mismatch",
    );
  }
  if (!sameAddress(accepted.payTo, requirements.payTo)) {
    throw new ValidationError("invalid_exact_evm_payload_recipient_mismatch");
  }
  if (accepted.extra?.assetTransferMethod !== "erc7710") {
    throw new ValidationError("invalid_scheme");
  }
}

export interface Erc7710Payload {
  delegationManager: Address;
  permissionContext: `0x${string}`;
  delegator: Address;
}

export function readErc7710Payload(paymentPayload: PaymentPayload): Erc7710Payload {
  const payload = paymentPayload.payload as Partial<Erc7710Payload> | undefined;
  if (
    !payload ||
    typeof payload.delegationManager !== "string" ||
    typeof payload.permissionContext !== "string" ||
    !payload.permissionContext.startsWith("0x") ||
    typeof payload.delegator !== "string"
  ) {
    throw new ValidationError("invalid_payload");
  }
  return {
    delegationManager: getAddress(payload.delegationManager),
    permissionContext: payload.permissionContext,
    delegator: getAddress(payload.delegator),
  };
}
