export const SIGNAL_EXTRACTION_PROMPT = `
        You are an expert cryptocurrency trader specializing in Solana memecoins and shitcoins. 
        Analyze this Telegram message for trading signals:

        Message:
        {{text}}

        Identify:
        1. Is this a trading signal? Look for mentions of tokens, prices, or trading actions
        2. Signal details:
          - BUY/SELL/UNKNOWN signal type
          - Token address (any Solana address format)
          - Entry price (if given)
          - Risk level based on message tone and details
          - Confidence score (0-100) based on detail quality
          - Timeframe mentioned or implied
          - Stop loss levels (if mentioned)
          - Take profit targets (if mentioned)
          - Expected slippage or liquidity concerns
          - Any technical analysis mentioned
          - Catalysts or reasons for the trade
          - Risk factors mentioned

        For token addresses, look for strings that match Solana address format (base58, 32-44 characters).
        Assess risk level based on language used, urgency, and detail provided.
        `;
