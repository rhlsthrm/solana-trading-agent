import { v4 as uuidv4 } from "uuid";

interface Signal {
  id: string;
  tokenAddress: string;
  type: "BUY" | "SELL";
  price: number;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  timeframe?: string;
}

export function parseSignal(text: string): Signal | null {
  try {
    // DegenSeals specific patterns
    const addressPattern = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
    const pricePattern = /(?:entry|price|bought at|sold at)[:\s]*[$]?([\d.]+)/i;
    const typePattern = /(buy|sell|long|short)/i;

    // Extract token address
    const addressMatch = text.match(addressPattern);
    if (!addressMatch) {
      return null;
    }

    // Extract price
    const priceMatch = text.match(pricePattern);
    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

    // Determine signal type
    const typeMatch = text.match(typePattern);
    const type = typeMatch
      ? typeMatch[1].toLowerCase() === "buy" ||
        typeMatch[1].toLowerCase() === "long"
        ? "BUY"
        : "SELL"
      : "BUY";

    // Extract risk level
    let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";
    if (
      text.toLowerCase().includes("safe") ||
      text.toLowerCase().includes("low risk")
    ) {
      riskLevel = "LOW";
    } else if (
      text.toLowerCase().includes("risky") ||
      text.toLowerCase().includes("high risk")
    ) {
      riskLevel = "HIGH";
    }

    // Extract timeframe
    let timeframe: string | undefined;
    const timeframeMatch = text.match(/(\d+)\s*(m|h|d)/i);
    if (timeframeMatch) {
      timeframe = timeframeMatch[0].toLowerCase();
    }

    // Create signal
    const signal: Signal = {
      id: uuidv4(),
      tokenAddress: addressMatch[0],
      type,
      price,
      riskLevel,
      timeframe,
    };

    return signal;
  } catch (error) {
    console.error("Error parsing signal:", error);
    return null;
  }
}
