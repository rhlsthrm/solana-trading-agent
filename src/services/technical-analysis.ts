import { Connection } from "@solana/web3.js";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface IndicatorValues {
  rsi: number;
  shortMA: number;
  longMA: number;
  volumeMA: number;
}

export class TechnicalAnalysisService {
  private readonly RSI_PERIOD = 14;
  private readonly SHORT_MA_PERIOD = 20;
  private readonly LONG_MA_PERIOD = 50;
  private readonly VOLUME_MA_PERIOD = 20;

  constructor(
    private connection: Connection,
    private timeframes: string[] = ["5m", "15m", "1h"]
  ) {}

  // Calculate RSI
  private calculateRSI(closes: number[]): number {
    if (closes.length < this.RSI_PERIOD + 1) {
      return 50; // Default to neutral if not enough data
    }

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= this.RSI_PERIOD; i++) {
      const difference = closes[i] - closes[i - 1];
      if (difference >= 0) {
        gains += difference;
      } else {
        losses -= difference;
      }
    }

    let avgGain = gains / this.RSI_PERIOD;
    let avgLoss = losses / this.RSI_PERIOD;

    // Calculate subsequent values
    for (let i = this.RSI_PERIOD + 1; i < closes.length; i++) {
      const difference = closes[i] - closes[i - 1];
      if (difference >= 0) {
        avgGain =
          (avgGain * (this.RSI_PERIOD - 1) + difference) / this.RSI_PERIOD;
        avgLoss = (avgLoss * (this.RSI_PERIOD - 1)) / this.RSI_PERIOD;
      } else {
        avgGain = (avgGain * (this.RSI_PERIOD - 1)) / this.RSI_PERIOD;
        avgLoss =
          (avgLoss * (this.RSI_PERIOD - 1) - difference) / this.RSI_PERIOD;
      }
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // Calculate Moving Average
  private calculateMA(values: number[], period: number): number {
    if (values.length < period) {
      return values[values.length - 1]; // Return last value if not enough data
    }

    const sum = values.slice(-period).reduce((acc, val) => acc + val, 0);
    return sum / period;
  }

  // Analyze price data for a specific timeframe
  private async analyzePriceData(
    tokenAddress: string,
    timeframe: string
  ): Promise<IndicatorValues | null> {
    try {
      // Fetch historical prices
      // Note: In a real implementation, you'd fetch this from a price feed
      // For now, we'll implement a placeholder that returns mock data
      const candles = await this.fetchHistoricalPrices(tokenAddress, timeframe);

      if (!candles || candles.length < this.LONG_MA_PERIOD) {
        console.log(
          `Not enough data for ${tokenAddress} on ${timeframe} timeframe`
        );
        return null;
      }

      const closes = candles.map((c) => c.close);
      const volumes = candles.map((c) => c.volume);

      return {
        rsi: this.calculateRSI(closes),
        shortMA: this.calculateMA(closes, this.SHORT_MA_PERIOD),
        longMA: this.calculateMA(closes, this.LONG_MA_PERIOD),
        volumeMA: this.calculateMA(volumes, this.VOLUME_MA_PERIOD),
      };
    } catch (error) {
      console.error(`Error analyzing ${tokenAddress} on ${timeframe}:`, error);
      return null;
    }
  }

  // Placeholder for historical price fetching
  // In production, implement real price feed integration
  private async fetchHistoricalPrices(
    tokenAddress: string,
    timeframe: string
  ): Promise<Candle[]> {
    // TODO: Implement real price feed
    // For now, return mock data
    const now = Date.now();
    const mockCandles: Candle[] = [];

    // Generate 100 candles of mock data
    for (let i = 0; i < 100; i++) {
      mockCandles.push({
        timestamp: now - i * this.timeframeToMs(timeframe),
        open: 100 - i * 0.1,
        high: 100 - i * 0.1 + 0.5,
        low: 100 - i * 0.1 - 0.5,
        close: 100 - i * 0.1 + (Math.random() - 0.5),
        volume: 1000000 * (1 + Math.random()),
      });
    }

    return mockCandles.reverse();
  }

  private timeframeToMs(timeframe: string): number {
    const value = parseInt(timeframe.slice(0, -1));
    const unit = timeframe.slice(-1);

    switch (unit) {
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unsupported timeframe: ${timeframe}`);
    }
  }

  // Analyze token across all timeframes
  public async analyzeToken(
    tokenAddress: string
  ): Promise<Record<string, IndicatorValues | null>> {
    const results: Record<string, IndicatorValues | null> = {};

    for (const timeframe of this.timeframes) {
      results[timeframe] = await this.analyzePriceData(tokenAddress, timeframe);
    }

    return results;
  }

  // Check if token meets trading criteria
  public meetsEntryConditions(analysis: IndicatorValues): boolean {
    // RSI oversold condition (< 30)
    const isOversold = analysis.rsi < 30;

    // Moving average crossover (short MA > long MA)
    const isCrossover = analysis.shortMA > analysis.longMA;

    // Volume above average
    const isHighVolume = analysis.volumeMA > analysis.volumeMA * 1.5;

    return isOversold && isCrossover && isHighVolume;
  }
}

export const createTechnicalAnalysisService = (
  connection: Connection,
  timeframes?: string[]
) => {
  return new TechnicalAnalysisService(connection, timeframes);
};
