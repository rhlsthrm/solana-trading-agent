// token.ts:
// Utility functions for token amount conversion and formatting

/**
 * Normalize a token amount from its raw decimal-less format to a human-readable format
 * 
 * Solana tokens typically have 6-9 decimal places
 * @param amount - The raw token amount from the blockchain/database
 * @param decimals - The number of decimal places (default: 6 for SPL tokens)
 * @returns The normalized token amount
 */
export function normalizeTokenAmount(amount: number, decimals: number = 6): number {
  return amount / Math.pow(10, decimals);
}

/**
 * Convert a human-readable token amount to its raw format for blockchain transactions
 * 
 * @param amount - The human-readable amount
 * @param decimals - The number of decimal places (default: 6 for SPL tokens)
 * @returns The raw token amount
 */
export function denormalizeTokenAmount(amount: number, decimals: number = 6): number {
  return Math.floor(amount * Math.pow(10, decimals));
}

/**
 * Format a token amount for display
 * 
 * @param amount - The normalized token amount (after using normalizeTokenAmount)
 * @returns Formatted string
 */
export function formatTokenAmount(amount: number): string {
  if (amount < 0.001) {
    return amount.toExponential(4);
  } else if (amount < 1) {
    return amount.toFixed(6);
  } else if (amount < 1000) {
    return amount.toFixed(4);
  } else {
    return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}

/**
 * Format a currency value for display
 * 
 * @param amount - The currency amount
 * @returns Formatted string
 */
export function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined || isNaN(amount)) return "N/A";
  
  if (Math.abs(amount) < 0.01) {
    return amount.toFixed(8);
  } else if (Math.abs(amount) < 1) {
    return amount.toFixed(6);
  } else if (Math.abs(amount) < 1000) {
    return amount.toFixed(4);
  } else {
    return amount.toLocaleString(undefined, { 
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
}