import type { PaymentErrorKind } from "./types";

/** A payment was refused by policy (server-side check or on-chain caveat). */
export class PolicyError extends Error {
  readonly kind: PaymentErrorKind = "policy";

  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** A payment failed for an infrastructure reason (RPC, gas, nonce, unexpected revert). */
export class InfrastructureError extends Error {
  readonly kind: PaymentErrorKind = "infrastructure";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InfrastructureError";
  }
}

/** Invalid request input (bad address, unknown provider, malformed payload). */
export class ValidationError extends Error {
  readonly kind = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Required server configuration is missing; the UI shows a setup state. */
export class SetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupRequiredError";
  }
}

export function errorKindOf(error: unknown): PaymentErrorKind {
  if (error instanceof PolicyError) return "policy";
  if (error instanceof InfrastructureError) return "infrastructure";
  return "infrastructure";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
