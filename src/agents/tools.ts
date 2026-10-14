import { isAddress } from "viem";
import { z } from "zod";
import type { ToolDefinition } from "./deepseek";
import type { PaidRequestResult, X402AgentClient } from "@/x402/client";
import type { ProviderRequestArgs } from "@/providers/types";
import type { ProviderId } from "@/shared/types";
import { parseMarketArgs } from "@/providers/market";

export const CODE_TOOL_NAME = "code_facts";
export const ACTIVITY_TOOL_NAME = "address_activity";

export interface AgentToolDescriptor {
  name: string;
  providerId: ProviderId;
  definition: ToolDefinition;
  parse(args: unknown): ProviderRequestArgs;
}

const addressField = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "invalid EVM address");

const codeArgsSchema = z
  .object({
    providerId: z.literal("code"),
    address: addressField,
  })
  .strict();

const activityArgsSchema = z
  .object({
    providerId: z.literal("activity"),
    address: addressField,
    blockNumber: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * The provider id is a fixed enum, the URL and the payee are never model
 * inputs, and the arguments are validated before any paid request is made.
 */
export const CODE_TOOL: AgentToolDescriptor = {
  name: CODE_TOOL_NAME,
  providerId: "code",
  definition: {
    type: "function",
    function: {
      name: CODE_TOOL_NAME,
      description:
        "Buy bytecode facts (size, keccak hash, prefix, contract presence) for one address at a fixed block. Returns observed facts only. Costs 0.02 test USDC from the shared mission budget.",
      parameters: {
        type: "object",
        properties: {
          providerId: {
            type: "string",
            enum: ["code"],
            description: "Registered provider id. Must be 'code'.",
          },
          address: {
            type: "string",
            pattern: "^0x[0-9a-fA-F]{40}$",
            description: "EVM address to observe.",
          },
        },
        required: ["providerId", "address"],
        additionalProperties: false,
      },
    },
  },
  parse: (args) => {
    const parsed = codeArgsSchema.parse(args);
    return { address: parsed.address as `0x${string}` };
  },
};

export const ACTIVITY_TOOL: AgentToolDescriptor = {
  name: ACTIVITY_TOOL_NAME,
  providerId: "activity",
  definition: {
    type: "function",
    function: {
      name: ACTIVITY_TOOL_NAME,
      description:
        "Buy activity facts (native balance and transaction count) for one address at a fixed block. Returns observed facts only. Costs 0.02 test USDC from the shared mission budget.",
      parameters: {
        type: "object",
        properties: {
          providerId: {
            type: "string",
            enum: ["activity"],
            description: "Registered provider id. Must be 'activity'.",
          },
          address: {
            type: "string",
            pattern: "^0x[0-9a-fA-F]{40}$",
            description: "EVM address to observe.",
          },
          blockNumber: {
            type: "integer",
            minimum: 0,
            description:
              "Optional block number for a consistent observation; defaults to the latest block.",
          },
        },
        required: ["providerId", "address"],
        additionalProperties: false,
      },
    },
  },
  parse: (args) => {
    const parsed = activityArgsSchema.parse(args);
    return {
      address: parsed.address as `0x${string}`,
      ...(parsed.blockNumber !== undefined ? { blockNumber: parsed.blockNumber } : {}),
    };
  },
};

function marketTool(providerId: "market" | "exit", name: string, description: string): AgentToolDescriptor {
  return {
    name, providerId,
    definition: { type: "function", function: {
      name, description,
      parameters: { type: "object", properties: {
        providerId: { type: "string", enum: [providerId] },
        address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        compareAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        ...(providerId === "exit" ? { depth: { type: "boolean", description: "false for the requested position; true for an optional 10x position depth check." } } : {}),
      }, required: ["providerId", "address"], additionalProperties: false },
    } },
    parse: (args) => {
      const parsed = z.object({ providerId: z.literal(providerId), address: addressField,
        compareAddress: addressField.optional(),
        ...(providerId === "exit" ? { depth: z.boolean().optional() } : {}),
      }).strict().parse(args);
      const params = new URLSearchParams({ address: parsed.address });
      if (parsed.compareAddress) params.set("compareAddress", parsed.compareAddress);
      if ("depth" in parsed) params.set("depth", String(parsed.depth ?? false));
      return parseMarketArgs(params);
    },
  };
}

export const MARKET_TOOL = marketTool("market", "market_snapshot",
  "Buy one normalized market comparison for all supplied Base token addresses: highest reported pair liquidity, 24h volume, prices, timestamps and source links. Costs 0.02 test USDC. Supply both addresses in a single call.");
export const EXIT_TOOL = marketTool("exit", "exit_quotes",
  "Buy indicative sell quotes into Base USDC for all supplied tokens at the user-selected USD position size. Sizing is fixed by the server. Returns token quantities, quoted USDC proceeds, gas and gaps, without executing trades. Costs 0.02 test USDC. Supply both addresses in one call; depth=true checks 10x size.");
export const ALL_TOOLS: AgentToolDescriptor[] = [CODE_TOOL, ACTIVITY_TOOL, MARKET_TOOL, EXIT_TOOL];

export function toolByName(name: string): AgentToolDescriptor | null {
  return ALL_TOOLS.find((tool) => tool.name === name) ?? null;
}

export interface MissionRunBudget {
  paidAttempts: number;
  maxPaidAttempts: number;
}

export interface ToolExecutionResult {
  content: string;
  result: PaidRequestResult | null;
}

/**
 * Executes one model tool call. The model cannot choose a URL, a price or a
 * payee: those come from the provider registry and the signed mission terms.
 */
export async function executeToolCall(params: {
  toolName: string;
  rawArguments: string;
  client: X402AgentClient;
  agentRunId: string;
  budget: MissionRunBudget;
  constraints?: { allowedTools: string[]; addresses: readonly string[]; positionUsd?: string };
}): Promise<ToolExecutionResult> {
  const tool = toolByName(params.toolName);
  if (!tool) {
    return {
      content: JSON.stringify({
        ok: false,
        reason: `unknown_tool:${params.toolName}`,
      }),
      result: null,
    };
  }
  if (params.constraints && !params.constraints.allowedTools.includes(params.toolName)) {
    return { content: JSON.stringify({ ok: false, reason: "tool_not_allowed_for_agent" }), result: null };
  }
  let args: ProviderRequestArgs;
  try {
    const parsed = JSON.parse(params.rawArguments || "{}") as unknown;
    args = tool.parse(parsed);
    if (params.constraints) {
      const expected = params.constraints.addresses.map((address) => address.toLowerCase()).sort();
      const requested = [args.address, ...(args.compareAddress ? [args.compareAddress] : [])]
        .map((address) => address.toLowerCase()).sort();
      if (requested.some((address) => !expected.includes(address)) ||
        ((tool.providerId === "market" || tool.providerId === "exit") && JSON.stringify(requested) !== JSON.stringify(expected))) {
        throw new Error("tool must use the mission's supplied token addresses");
      }
      if (tool.providerId === "market" || tool.providerId === "exit") {
        args.positionUsd = params.constraints.positionUsd ?? "100";
      }
    }
  } catch (error) {
    return {
      content: JSON.stringify({
        ok: false,
        reason: "invalid_arguments",
        message: error instanceof Error ? error.message : String(error),
      }),
      result: null,
    };
  }
  if (params.budget.paidAttempts >= params.budget.maxPaidAttempts) {
    return {
      content: JSON.stringify({
        ok: false,
        reason: "mission_paid_call_limit",
        message: `the demo mission allows at most ${params.budget.maxPaidAttempts} paid calls`,
        providerId: tool.providerId,
      }),
      result: null,
    };
  }
  params.budget.paidAttempts += 1;
  const result = await params.client.requestPaidData(tool.providerId, args, {
    agentRunId: params.agentRunId,
  });
  const modelResult = !result.ok && result.reason.includes("insufficient_funds")
    ? { ...result, explanation: "The contract rejected this purchase because it exceeds the cumulative shared mission spending allowance. No data was returned for this purchase. This does not mean the spending wallet is empty." }
    : result;
  return {
    content: JSON.stringify(modelResult, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    result,
  };
}
