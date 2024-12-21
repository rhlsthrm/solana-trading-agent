// src/__tests__/unit/utils/parseSignal.test.ts
import { jest } from "@jest/globals";
// src/__tests__/unit/utils/parseSignal.test.ts

// Mock the entire uuid module
jest.mock("uuid", () => {
  return {
    v4: () => "test-uuid",
  };
});

const mockIdGenerator = () => "test-uuid";

import { parseSignal } from "../../../utils/parseSignal.js";

describe("parseSignal", () => {
  test("parses valid buy signal correctly", () => {
    const message = `🚨 NEW SIGNAL 🚨
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Buy at: $1.25
Risk: LOW`;

    const result = parseSignal(message, mockIdGenerator);

    expect(result).toEqual({
      id: "test-uuid",
      tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      type: "BUY",
      price: 1.25,
      riskLevel: "LOW",
      timeframe: undefined,
    });
  });

  test("parses valid sell signal correctly", () => {
    const message = `🔥 SELL SIGNAL 🔥
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Price: $2.50
Risk: HIGH`;

    const result = parseSignal(message, mockIdGenerator);

    expect(result).toEqual({
      id: "test-uuid",
      tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      type: "SELL",
      price: 2.5,
      riskLevel: "HIGH",
      timeframe: undefined,
    });
  });

  test("extracts timeframe when present", () => {
    const message = `🚨 NEW SIGNAL 🚨
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Buy at: $1.25
Timeframe: 15m
Risk: MEDIUM`;

    const result = parseSignal(message, mockIdGenerator);

    expect(result).toEqual({
      id: "test-uuid",
      tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      type: "BUY",
      price: 1.25,
      riskLevel: "MEDIUM",
      timeframe: "15m",
    });
  });

  test("returns null for invalid token address", () => {
    const message = `🚨 NEW SIGNAL 🚨
Token: invalid-address
Buy at: $1.25
Risk: MEDIUM`;

    const result = parseSignal(message, mockIdGenerator);
    expect(result).toBeNull();
  });

  test("defaults to MEDIUM risk when risk level not specified", () => {
    const message = `🚨 NEW SIGNAL 🚨
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Buy at: $1.25`;

    const result = parseSignal(message, mockIdGenerator);
    expect(result?.riskLevel).toBe("MEDIUM");
  });

  test("handles different price formats", () => {
    const testCases = [
      {
        message: "Buy at: 1.25",
        expected: 1.25,
      },
      {
        message: "Entry: $1.25",
        expected: 1.25,
      },
      {
        message: "Price: $1.25",
        expected: 1.25,
      },
      {
        message: "Bought at $1.25",
        expected: 1.25,
      },
    ];

    testCases.forEach(({ message, expected }) => {
      const fullMessage = `🚨 NEW SIGNAL 🚨
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
${message}
Risk: MEDIUM`;

      const result = parseSignal(fullMessage, mockIdGenerator);
      expect(result?.price).toBe(expected);
    });
  });

  test("handles messages with extra content", () => {
    const message = `🚨 NEW SIGNAL 🚨
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Buy at: $1.25
Risk: LOW
Additional notes: Looking good for a quick flip
Target 1: $1.50
Target 2: $1.75
Stop loss: $1.15`;

    const result = parseSignal(message, mockIdGenerator);

    expect(result).toEqual({
      id: "test-uuid",
      tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      type: "BUY",
      price: 1.25,
      riskLevel: "LOW",
      timeframe: undefined,
    });
  });

  test("returns null for completely invalid messages", () => {
    const invalidMessages = [
      "",
      "Random text",
      "No token address here",
      "🚨 NEW SIGNAL 🚨\nBuy at: $1.25",
    ];

    invalidMessages.forEach((message) => {
      const result = parseSignal(message, mockIdGenerator);
      expect(result).toBeNull();
    });
  });

  test("properly parses risk levels", () => {
    const testCases = [
      {
        message: "Risk: LOW",
        expected: "LOW",
      },
      {
        message: "Risk: HIGH",
        expected: "HIGH",
      },
      {
        message: "Safe trade",
        expected: "LOW",
      },
      {
        message: "Risky one",
        expected: "HIGH",
      },
    ];

    testCases.forEach(({ message, expected }) => {
      const fullMessage = `🚨 NEW SIGNAL 🚨
Token: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Buy at: $1.25
${message}`;

      const result = parseSignal(fullMessage, mockIdGenerator);
      expect(result?.riskLevel).toBe(expected);
    });
  });
});
