# Solana Trading Agent Documentation

## Overview

This application is a Solana-based trading agent that monitors Telegram channels for trading signals, analyzes them using AI, and automatically executes trades on the Solana blockchain via the Jupiter DEX aggregator.

## Current Features

### Telegram Monitoring

- Connects to specific Telegram channels to monitor messages for trading signals
- Parses signals from channels like DegenSeals, fadedarc, goattests, cryptomattcall
- Maintains connection health checks and auto-reconnection

### Token Analysis

- Uses ProficyService to get token information via the ProficyPriceBot on Telegram
- Extracts token addresses, price, liquidity, volume metrics
- Parses Proficy responses using Claude AI

### Sentiment Analysis

- Analyzes message sentiment using Claude AI
- Determines trade signals (BUY/SELL)
- Calculates confidence levels for trading decisions

### Trade Execution

- Executes trades through Jupiter DEX aggregator
- AI-driven position sizing based on multiple factors
- Stores trade records in SQLite database
- Transaction management with proper error handling

### Position Management

- Tracks active and partially closed positions
- Updates position values and calculates profit/loss (both realized and unrealized)
- Stores position data with comprehensive tracking in database
- Implements progressive profit-taking strategy (25% at 30%, 50%, and 100% profit)
- Features dynamic trailing stop-loss (15% below highest price)
- Includes automated position scaling for winning trades
- Provides detailed position monitoring with visual progress indicators
- Implements moonshot potential for highly profitable trades

### Database Management

- SQLite database for storing signals, trades, positions
- Schema design for tracking trading activities
- Transaction management for data integrity

## Architecture Overview

### Service-Based Architecture

The application follows a service-based pattern with clear separation of concerns:

1. **TelegramMonitorService**: Listens for signals from Telegram channels
2. **ProficyService**: Fetches token information from Proficy bot
3. **SentimentAnalysisService**: Analyzes message sentiment using Claude AI
4. **JupiterService**: Interacts with Jupiter DEX for quotes and swaps
5. **TradeExecutionService**: Handles the trade execution logic
6. **PositionManager**: Manages open positions and calculates P&L
7. **PositionMonitor**: Automated service to check positions and execute stop-loss/take-profit
8. **Dashboard**: Web-based interface for monitoring portfolio performance (Express + EJS)

### Data Flow

Message → Token Info → Sentiment Analysis → Signal Validation → Trade Execution → Position Management

### AI Integration

- Uses Claude API for sentiment analysis and decision-making
- AI-driven position sizing and risk management
- AI character defined with specific trading personality

## Recently Completed Features

### Position Closing Mechanism

- ✅ Implemented token selling functionality in `closePosition()` method
- ✅ Added execution of sell transactions based on stop-loss (-15%) and take-profit (+30%) conditions
- ✅ Created complete workflow for closing positions and converting tokens back to SOL
- ✅ Added transaction recording and proper profit/loss calculation
- ✅ Implemented manual position closing by token address
- ✅ Added utilities for bulk position management and cleanup
- ✅ Created dedicated position monitoring service that runs on a configurable interval

### Dashboard and Monitoring

- ✅ Implemented web dashboard running on localhost:3000
- ✅ Added real-time price updates for all active positions
- ✅ Display summary of portfolio value and performance
- ✅ Track recent trades with profit/loss metrics
- ✅ Created auto-refreshing view for continuous monitoring
- ✅ Added token symbol lookup and caching for better readability
- ✅ Implemented responsive and user-friendly interface

## Remaining Features to Implement

### Advanced Trading Strategy

- ✅ Implemented progressive profit-taking strategy:
  - 25% of position at 30% profit
  - 25% of position at 50% profit 
  - 25% of position at 100% profit
  - Hold 25% for moonshot potential
- ✅ Added partial position closing functionality with tracking
- ✅ Developed position scaling for winning trades (10-25% profit range)
- ✅ Created position size adjustment based on available balance
- ✅ Added profit tracking for both realized and unrealized gains

### Enhanced Risk Management

- ✅ Implemented automated trailing stop-loss (15% below highest price)
- ✅ Added intelligent position monitoring with visual indicators
- ✅ Created automated position monitor for proactive risk management
- ✅ Implemented optimal position scaling rules (10-25% profit window)
- ✅ Added detailed profit target tracking system

### Portfolio Management

- ✅ Implement complete portfolio analytics with realized/unrealized P&L
- ✅ Created advanced position status visualization
- ✅ Added profit-target progress tracking
- Add diversification controls
- Create position correlation analysis

### Monitoring and Reporting

- Develop regular reporting of position status
- Implement alerting for critical events
- Add performance metrics and historical analysis

### Configuration Management

- Create external configuration system for risk parameters
- Remove hardcoded values (min liquidity, min volume, etc.)
- Implement environment-specific configurations

### Testing Infrastructure

- Develop unit and integration tests
- Create simulation environment for testing trading strategies
- Implement backtesting capabilities
