import type { TypedData } from "viem";

/** Raw eth_signTypedData_v4 needs explicit domain fields. Unlike viem's
 * signing helper, MetaMask does not infer these from the domain object.
 */
export const EIP712_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export type WalletTypedDataTypes = TypedData & { EIP712Domain: typeof EIP712_DOMAIN_TYPES };

export function withEip712Domain(types: TypedData): WalletTypedDataTypes {
  return { ...types, EIP712Domain: EIP712_DOMAIN_TYPES } as WalletTypedDataTypes;
}
