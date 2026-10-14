import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";
import type { ProviderId } from "@/shared/types";
import { ValidationError } from "@/shared/errors";

/** Both providers cost exactly 0.02 test USDC. */
export const PROVIDER_PRICE = 20_000n;
export const PROVIDER_PRICE_USDC = "0.02";

export interface ProviderRequestArgs {
  address: Address;
  blockNumber?: number;
  compareAddress?: Address;
  positionUsd?: string;
  depth?: boolean;
}

export interface ProviderResult {
  /** Facts only — never owner, history or risk claims the data cannot prove. */
  facts: Record<string, unknown>;
  blockNumber: number | null;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  description: string;
  /** Route path served by this app. */
  path: string;
  price: bigint;
  payTo: Address;
  /** Validates query parameters and returns canonical arguments. */
  parseArgs(searchParams: URLSearchParams): ProviderRequestArgs;
  /** Reads facts from RPC at a fixed block. */
  run(
    args: ProviderRequestArgs,
    context: ProviderExecutionContext,
  ): Promise<ProviderResult>;
}

export interface ProviderExecutionContext {
  rpcUrl: string;
  chainId: number;
  fetch: typeof fetch;
}

const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "invalid address");

const blockSchema = z
  .string()
  .regex(/^[0-9]+$/, "blockNumber must be a non-negative integer")
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value), "blockNumber is too large");

export function parseProviderArgs(searchParams: URLSearchParams): ProviderRequestArgs {
  const address = addressSchema.safeParse(searchParams.get("address"));
  if (!address.success) {
    throw new ValidationError(
      `invalid 'address' parameter: ${address.error.issues[0]?.message ?? "missing"}`,
    );
  }
  let blockNumber: number | undefined;
  const rawBlock = searchParams.get("blockNumber");
  if (rawBlock !== null && rawBlock !== "") {
    const block = blockSchema.safeParse(rawBlock);
    if (!block.success) {
      throw new ValidationError(
        `invalid 'blockNumber' parameter: ${block.error.issues[0]?.message ?? "invalid"}`,
      );
    }
    blockNumber = block.data;
  }
  return { address: getAddress(address.data), blockNumber };
}

export function canonicalRequestJson(
  providerId: ProviderId,
  args: ProviderRequestArgs,
): string {
  // Stable key order keeps the request hash verifiable across retries.
  return JSON.stringify({
    providerId,
    address: getAddress(args.address),
    ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
    ...(args.compareAddress ? { compareAddress: getAddress(args.compareAddress) } : {}),
    ...(args.positionUsd !== undefined ? { positionUsd: args.positionUsd } : {}),
    ...(args.depth !== undefined ? { depth: args.depth } : {}),
  });
}

export function requestHash(providerId: ProviderId, args: ProviderRequestArgs): Hex {
  return keccak256(new TextEncoder().encode(canonicalRequestJson(providerId, args)));
}
