import { z } from "zod";
import { getAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { addressSchema, hexSchema } from "@/shared/schemas";
import type { TokenInfo } from "@/shared/types";
import { parseAmount } from "@/shared/amounts";
import { accountFromPrivateKey } from "./accounts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  USDC_BASE_SEPOLIA,
  USDC_DECIMALS,
} from "./network";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

const optionalAddress = emptyToUndefined(addressSchema.optional());
const optionalHex = emptyToUndefined(hexSchema.optional());

const envSchema = z.object({
  SWARM_TAB_NETWORK: z.enum(["base-sepolia", "local"]).default("base-sepolia"),
  BASE_SEPOLIA_RPC_URL: z
    .string()
    .url()
    .default("https://sepolia.base.org"),
  USDC_ADDRESS: optionalAddress,
  USER_OWNER_PRIVATE_KEY: optionalHex,
  EXECUTOR_PRIVATE_KEY: optionalHex,
  RELAYER_PRIVATE_KEY: optionalHex,
  DEPLOYER_PRIVATE_KEY: optionalHex,
  ALLOWED_RECIPIENT_1: optionalAddress,
  ALLOWED_RECIPIENT_2: optionalAddress,
  MISSION_BUDGET_USDC: z.string().default("0.05"),
  PER_CALL_MAX_USDC: z.string().default("0.02"),
  MISSION_VALIDITY_SECONDS: z.coerce.number().int().positive().default(86_400),
  MISSION_POLICY_ENFORCER_ADDRESS: optionalAddress,
  DATABASE_PATH: z.string().default("data/swarm-tab.db"),
});

export interface ServerConfig {
  network: "base-sepolia" | "local";
  chainId: number;
  rpcUrl: string;
  token: TokenInfo;
  budget: bigint;
  perCallMax: bigint;
  /** Configured recipient allow-list (may be empty until a mission is created). */
  recipients: Address[];
  validitySeconds: number;
  enforcerAddress: Address | null;
  databasePath: string;
  /** Present in process memory only; never serialise or log these. */
  ownerPrivateKey: Hex | null;
  executorPrivateKey: Hex | null;
  relayerPrivateKey: Hex | null;
  deployerPrivateKey: Hex | null;
  ownerAddress: Address | null;
  executorAddress: Address | null;
  relayerAddress: Address | null;
  deployerAddress: Address | null;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const values = parsed.data;
  const isLocal = values.SWARM_TAB_NETWORK === "local";
  const chainId = isLocal ? LOCAL_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
  const tokenAddress =
    values.USDC_ADDRESS ?? (isLocal ? null : USDC_BASE_SEPOLIA);
  if (!tokenAddress) {
    throw new ConfigError(
      "USDC_ADDRESS is required for the local network (deploy the mock token first)",
    );
  }

  const recipients = [values.ALLOWED_RECIPIENT_1, values.ALLOWED_RECIPIENT_2]
    .filter((value): value is Address => Boolean(value))
    .map((value) => getAddress(value));

  const ownerPrivateKey = values.USER_OWNER_PRIVATE_KEY ?? null;
  const executorPrivateKey = values.EXECUTOR_PRIVATE_KEY ?? null;
  const relayerPrivateKey = values.RELAYER_PRIVATE_KEY ?? null;
  const deployerPrivateKey = values.DEPLOYER_PRIVATE_KEY ?? null;

  return {
    network: values.SWARM_TAB_NETWORK,
    chainId,
    rpcUrl: values.BASE_SEPOLIA_RPC_URL,
    token: {
      address: getAddress(tokenAddress),
      symbol: "USDC",
      decimals: USDC_DECIMALS,
    },
    budget: parseAmount(values.MISSION_BUDGET_USDC, USDC_DECIMALS),
    perCallMax: parseAmount(values.PER_CALL_MAX_USDC, USDC_DECIMALS),
    recipients,
    validitySeconds: values.MISSION_VALIDITY_SECONDS,
    enforcerAddress: values.MISSION_POLICY_ENFORCER_ADDRESS ?? null,
    databasePath: values.DATABASE_PATH,
    ownerPrivateKey,
    executorPrivateKey,
    relayerPrivateKey,
    deployerPrivateKey,
    ownerAddress: deriveAddress(ownerPrivateKey, "USER_OWNER_PRIVATE_KEY"),
    executorAddress: deriveAddress(executorPrivateKey, "EXECUTOR_PRIVATE_KEY"),
    relayerAddress: deriveAddress(
      relayerPrivateKey ?? executorPrivateKey,
      "RELAYER_PRIVATE_KEY",
    ),
    deployerAddress: deriveAddress(
      deployerPrivateKey ?? executorPrivateKey,
      "DEPLOYER_PRIVATE_KEY",
    ),
  };
}

function deriveAddress(privateKey: Hex | null, label: string): Address | null {
  if (!privateKey) return null;
  try {
    return accountFromPrivateKey(privateKey).address;
  } catch {
    throw new ConfigError(`${label} is not a valid secp256k1 private key`);
  }
}

export function requireRecipients(config: ServerConfig): [Address] | [Address, Address] {
  if (config.recipients.length < 1) {
    throw new ConfigError(
      "ALLOWED_RECIPIENT_1 (and optionally ALLOWED_RECIPIENT_2) must be configured",
    );
  }
  return config.recipients.length === 1
    ? [config.recipients[0]]
    : [config.recipients[0], config.recipients[1]];
}

export function requireExecutorAccount(config: ServerConfig): LocalAccount {
  if (!config.executorPrivateKey) {
    throw new ConfigError(
      "EXECUTOR_PRIVATE_KEY is not configured; server-side payment execution is unavailable",
    );
  }
  return accountFromPrivateKey(config.executorPrivateKey);
}

/**
 * The owner key is only needed to sign the root mission delegation (and to
 * revoke it). The agent runtime never loads it.
 */
export function requireRelayerAccount(config: ServerConfig): LocalAccount {
  const key = config.relayerPrivateKey ?? config.executorPrivateKey;
  if (!key) {
    throw new ConfigError(
      "RELAYER_PRIVATE_KEY (or EXECUTOR_PRIVATE_KEY) is not configured; the facilitator cannot settle",
    );
  }
  return accountFromPrivateKey(key);
}

export function requireDeployerAccount(config: ServerConfig): LocalAccount {
  const key = config.deployerPrivateKey ?? config.executorPrivateKey;
  if (!key) {
    throw new ConfigError(
      "DEPLOYER_PRIVATE_KEY (or EXECUTOR_PRIVATE_KEY) is not configured; deployments are unavailable",
    );
  }
  return accountFromPrivateKey(key);
}

export function requireOwnerAccount(config: ServerConfig): LocalAccount {
  if (!config.ownerPrivateKey) {
    throw new ConfigError(
      "USER_OWNER_PRIVATE_KEY is not configured; creating a mission root delegation is unavailable",
    );
  }
  return accountFromPrivateKey(config.ownerPrivateKey);
}

export { BASE_SEPOLIA_CHAIN_ID, LOCAL_CHAIN_ID, USDC_BASE_SEPOLIA, USDC_DECIMALS };
