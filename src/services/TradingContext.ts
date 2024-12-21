// src/services/tradingContext.ts
import { Connection } from "@solana/web3.js";
import { Service, ServiceType } from "@ai16z/eliza";

export class TradingContextService extends Service {
  static serviceType = ServiceType.TEXT_GENERATION; // Using existing service type

  constructor(public connection: Connection, public walletClient: any) {
    super();
  }

  async initialize(): Promise<void> {
    // No initialization needed
  }
}

export function createTradingContextService(
  connection: Connection,
  walletClient: any
): TradingContextService {
  return new TradingContextService(connection, walletClient);
}
