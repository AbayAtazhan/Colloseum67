import type { Account, PublicClient, WalletClient, Chain, Transport } from "viem";

/** Read-only public client (no local account attached). */
export type ReadClient = PublicClient;

/**
 * Wallet client with an account bound, so viem signs transactions locally
 * instead of relying on `eth_sendTransaction`.
 */
export type BoundWalletClient = WalletClient<Transport, Chain, Account>;
