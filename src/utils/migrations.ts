// src/utils/migrations.ts
import Database from "better-sqlite3";

export function runMigrations(db: Database.Database) {
  console.log("Running database migrations...");
  
  try {
    // Start a transaction for all migrations
    db.exec("BEGIN TRANSACTION");
    
    // Check if highest_price column exists
    const hasHighestPrice = checkColumnExists(db, "positions", "highest_price");
    if (!hasHighestPrice) {
      console.log("Adding highest_price column to positions table");
      db.exec("ALTER TABLE positions ADD COLUMN highest_price NUMERIC");
    }
    
    // Check if trailing_stop_percentage column exists
    const hasTrailingStop = checkColumnExists(db, "positions", "trailing_stop_percentage");
    if (!hasTrailingStop) {
      console.log("Adding trailing_stop_percentage column to positions table");
      db.exec("ALTER TABLE positions ADD COLUMN trailing_stop_percentage NUMERIC DEFAULT 20");
    }
    
    // Update existing rows to set values for new columns
    if (!hasHighestPrice || !hasTrailingStop) {
      console.log("Setting default values for new columns in existing positions");
      db.exec(`
        UPDATE positions 
        SET 
          highest_price = COALESCE(highest_price, current_price, entry_price),
          trailing_stop_percentage = COALESCE(trailing_stop_percentage, 20)
        WHERE status = 'ACTIVE'
      `);
    }
    
    // Commit all migrations
    db.exec("COMMIT");
    console.log("Database migrations completed successfully");
  } catch (error) {
    // Rollback on error
    db.exec("ROLLBACK");
    console.error("Error running database migrations:", error);
    throw error;
  }
}

// Helper function to check if a column exists in a table
function checkColumnExists(db: Database.Database, table: string, column: string): boolean {
  try {
    const result = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return result.some(col => col.name === column);
  } catch (error) {
    console.error(`Error checking if column ${column} exists in table ${table}:`, error);
    return false;
  }
}