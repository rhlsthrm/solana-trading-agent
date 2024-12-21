import { generateId } from "./uuid";

export interface Signal {
  id: string;
  tokenAddress: string;
  type: "BUY" | "SELL";
  price: number;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  timeframe?: string;
}

export function parseSignal(
  text: string,
  idGenerator = generateId
): Signal | null {
  try {
    // DegenSeals specific patterns
    const addressPattern = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
    const pricePattern =
      /(?:entry|price|buy at|bought at|sell at|sold at)[:\s]*\$?\s*([\d.]+)/i;
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

    // Extract risk level with exact pattern matching
    let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";
    const riskPattern = /risk:?\s*(low|medium|high)/i;
    const riskMatch = text.match(riskPattern);

    if (riskMatch) {
      const risk = riskMatch[1].toUpperCase() as "LOW" | "MEDIUM" | "HIGH";
      riskLevel = risk;
    } else if (text.toLowerCase().includes("safe")) {
      riskLevel = "LOW";
    } else if (text.toLowerCase().includes("risky")) {
      riskLevel = "HIGH";
    }

    // Extract timeframe with improved pattern
    let timeframe: string | undefined;
    const timeframePattern = /(?:timeframe|time frame):\s*(\d+\s*[mhd])/i;
    const timeframeMatch = text.match(timeframePattern);
    if (timeframeMatch) {
      timeframe = timeframeMatch[1].toLowerCase().replace(/\s+/g, "");
    }

    // Create signal
    const signal: Signal = {
      id: idGenerator(), // Use the injected generator
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
