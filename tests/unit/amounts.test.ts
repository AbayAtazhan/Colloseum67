import { describe, expect, it } from "vitest";
import {
  AmountError,
  formatAmount,
  formatAmountShort,
  multiplyAmount,
  parseAmount,
  sumAmounts,
} from "@/shared/amounts";

describe("amounts (integer minimal units)", () => {
  it("parses USDC amounts exactly", () => {
    expect(parseAmount("0.05", 6)).toBe(50_000n);
    expect(parseAmount("0.02", 6)).toBe(20_000n);
    expect(parseAmount("1", 6)).toBe(1_000_000n);
    expect(parseAmount("1.234567", 6)).toBe(1_234_567n);
  });

  it("rejects anything that would lose precision", () => {
    expect(() => parseAmount("0.0000001", 6)).toThrow(AmountError);
    expect(() => parseAmount("-1", 6)).toThrow(AmountError);
    expect(() => parseAmount("1e-6", 6)).toThrow(AmountError);
    expect(() => parseAmount("0.0.1", 6)).toThrow(AmountError);
    expect(() => parseAmount("abc", 6)).toThrow(AmountError);
  });

  it("formats minimal units without floating point", () => {
    expect(formatAmount(50_000n, 6)).toBe("0.050000");
    expect(formatAmount(20_000n, 6)).toBe("0.020000");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmountShort(20_000n, 6)).toBe("0.02");
    expect(formatAmountShort(1_200_000n, 6)).toBe("1.2");
    expect(() => formatAmount(-1n, 6)).toThrow(AmountError);
  });

  it("multiplies and sums with bigint semantics", () => {
    expect(multiplyAmount(20_000n, 3)).toBe(60_000n);
    expect(sumAmounts([20_000n, 20_000n, 10_000n])).toBe(50_000n);
    expect(() => multiplyAmount(1n, 1.5)).toThrow(AmountError);
  });
});
