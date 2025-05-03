// db-schema.ts - Centralized database schema definitions

export const tradingSchema = `
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    entry_price NUMERIC NOT NULL,
    current_price NUMERIC,
    last_updated INTEGER NOT NULL,
    profit_loss NUMERIC,
    status TEXT CHECK (status IN ('ACTIVE', 'CLOSED', 'LIQUIDATED'))
  );

  CREATE INDEX IF NOT EXISTS idx_positions_token_address 
    ON positions(token_address);
  
  CREATE INDEX IF NOT EXISTS idx_positions_status 
    ON positions(status);

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    token_address TEXT,
    entry_price NUMERIC,
    exit_price NUMERIC,
    position_size NUMERIC,
    signal_id TEXT,
    entry_time INTEGER,
    exit_time INTEGER,
    profit_loss NUMERIC,
    status TEXT,
    tx_id TEXT
  );

  CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    liquidity NUMERIC,
    volume_24h NUMERIC,
    last_updated INTEGER DEFAULT (unixepoch())
  );
`;

// Create required tables for ELIZA
export const elizaSchema = `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      "createdAt" INTEGER DEFAULT (unixepoch()),
      "name" TEXT,
      "username" TEXT,
      "email" TEXT,
      "avatarUrl" TEXT,
      "details" TEXT
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      "createdAt" INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      userId TEXT NOT NULL,
      roomId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      "unique" INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      "createdAt" INTEGER DEFAULT (unixepoch()),
      "userId" TEXT,
      "roomId" TEXT,
      "userState" TEXT,
      "last_message_read" TEXT,
      FOREIGN KEY ("userId") REFERENCES accounts(id),
      FOREIGN KEY ("roomId") REFERENCES rooms(id)
    );
  `;

// Additional tables specific to telegram monitor
export const telegramSchema = `
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source TEXT,
      token_address TEXT,
      signal_type TEXT,
      price NUMERIC,
      timestamp INTEGER DEFAULT (unixepoch()),
      processed INTEGER DEFAULT 0,
      risk_level TEXT,
      confidence NUMERIC,
      timeframe TEXT,
      stop_loss NUMERIC,
      take_profit NUMERIC,
      liquidity NUMERIC,
      volume_24h NUMERIC
    );

    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      rsi NUMERIC,
      short_ma NUMERIC,
      long_ma NUMERIC,
      volume_ma NUMERIC,
      timestamp INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (token_address) REFERENCES tokens(address)
    );
  `;

export const initializeDatabase = (db: any) => {
  // Execute schema creation in a transaction
  db.exec("BEGIN TRANSACTION;");
  try {
    db.exec(tradingSchema);
    db.exec("COMMIT;");
    console.log("Database schema created successfully");
  } catch (error) {
    db.exec("ROLLBACK;");
    console.error("Error creating database schema:", error);
    throw error;
  }
};
