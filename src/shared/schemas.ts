import { z } from "zod";
import type { Address, Hex } from "viem";
import { getAddress, isAddress, isHex } from "viem";

/** Strict address schema (checksum applied). */
export const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an EVM address")
  .transform((value) => getAddress(value) as Address);

export const hexSchema = z
  .string()
  .refine((value) => isHex(value), "not a hex string")
  .transform((value) => value as Hex);

/** Amount as a positive decimal string of minimal units (no floating point). */
export const minimalUnitsSchema = z
  .string()
  .regex(/^[0-9]+$/, "amount must be a decimal string of minimal units")
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n, "amount must be > 0");

export const tokenInfoSchema = z.object({
  address: addressSchema,
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
});

export const caveatSchema = z.object({
  enforcer: addressSchema,
  terms: hexSchema,
  args: hexSchema,
});

export const delegationSchema = z.object({
  delegate: addressSchema,
  delegator: addressSchema,
  authority: hexSchema,
  caveats: z.array(caveatSchema),
  salt: hexSchema,
  signature: hexSchema,
});

export const missionDraftSchema = z.object({
  title: z.string().min(1).max(200),
  task: z.string().min(1).max(4000),
  addresses: z.array(addressSchema).min(1).max(2),
  scenario: z.enum(["research", "exit-check"]).optional(),
  positionUsd: z.string().regex(/^[0-9]+(?:\.[0-9]{1,2})?$/)
    .refine((value) => Number(value) >= 1 && Number(value) <= 100_000,
      "position must be between $1 and $100,000").optional(),
  budgetUsdc: z
    .string()
    .regex(/^[0-9]+(?:\.[0-9]{1,6})?$/, "budget must be a decimal USDC amount")
    .optional(),
});

export const createMissionSchema = z.discriminatedUnion("mode", [
  missionDraftSchema.extend({ mode: z.literal("local") }),
  missionDraftSchema.extend({
    mode: z.literal("wallet"),
    ownerAddress: addressSchema,
    delegation: delegationSchema,
    signature: hexSchema,
  }),
]);

export const prepareMissionSchema = missionDraftSchema.extend({
  ownerAddress: addressSchema,
});

export type CreateMissionBody = z.input<typeof createMissionSchema>;
export type PrepareMissionBody = z.input<typeof prepareMissionSchema>;

export const missionPolicySchema = z
  .object({
    chainId: z.number().int().positive(),
    token: tokenInfoSchema,
    budget: minimalUnitsSchema,
    perCallMax: minimalUnitsSchema,
    recipients: z.array(addressSchema).min(1).max(2),
    validAfter: z.number().int().nonnegative(),
    validBefore: z.number().int().positive(),
    redeemer: addressSchema,
  })
  .refine((policy) => policy.perCallMax <= policy.budget, {
    message: "perCallMax cannot exceed the mission budget",
    path: ["perCallMax"],
  })
  .refine((policy) => policy.validBefore > policy.validAfter, {
    message: "validBefore must be after validAfter",
    path: ["validBefore"],
  });

export const paymentRequestSchema = z.object({
  missionId: z.string().min(1),
  agentRunId: z.string().min(1).nullish(),
  recipient: addressSchema,
  amount: minimalUnitsSchema,
});

export type PaymentRequestInput = z.input<typeof paymentRequestSchema>;
