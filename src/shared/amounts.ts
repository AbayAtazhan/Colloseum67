/**
 * Minimal-unit (integer) money helpers. Never use floating point for money.
 */

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const DECIMAL_RE = /^[0-9]+(?:\.[0-9]+)?$/;

/**
 * Parses a human decimal string such as "0.05" into minimal units.
 * Throws on exponents, signs, or more fractional digits than the token supports.
 */
export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AmountError(`unsupported decimals: ${decimals}`);
  }
  if (!DECIMAL_RE.test(value)) {
    throw new AmountError(`invalid decimal amount: ${value}`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new AmountError(
      `amount ${value} has more than ${decimals} fractional digits`,
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  return BigInt(`${whole}${padded}`);
}

/** Formats minimal units as a fixed-point decimal string. */
export function formatAmount(amount: bigint, decimals: number): string {
  if (amount < 0n) {
    throw new AmountError(`amount must not be negative: ${amount}`);
  }
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0");
  return decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
}

/** Formats with the minimum number of decimals needed, for logs and the UI. */
export function formatAmountShort(amount: bigint, decimals: number): string {
  const fixed = formatAmount(amount, decimals);
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

export function multiplyAmount(amount: bigint, factor: number): bigint {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new AmountError(`factor must be a non-negative integer: ${factor}`);
  }
  return amount * BigInt(factor);
}

export function sumAmounts(amounts: readonly bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n);
}
