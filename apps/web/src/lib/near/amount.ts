/**
 * Fixed-point amounts on BigInt.
 *
 * NEAR amounts are 24 decimals, which is well past what a double can hold
 * exactly: `Number("1000000000000000000000001")` loses the last digit. Every
 * conversion here goes through BigInt and strings, so nothing is ever rounded
 * behind the user's back.
 */

export const NEAR_DECIMALS = 24;

/** Parse a decimal string into base units. Extra decimals are truncated. */
export function parseAmount(value: string, decimals: number): string {
  const trimmed = value.trim();
  if (trimmed === '') return '0';
  if (!/^\d*(\.\d*)?$/.test(trimmed)) throw new Error(`"${value}" is not an amount`);

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return String(BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0'));
}

/**
 * Format base units for display.
 *
 * Truncates rather than rounds: showing 1.00 for 0.999 tells someone they have
 * more than they do, and that is the direction that costs them a transaction.
 */
export function formatAmount(value: string | bigint, decimals: number, places = 4): string {
  const units = BigInt(value);
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = units % divisor;

  if (places === 0) return String(whole);

  const digits = fraction.toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return digits ? `${whole}.${digits}` : String(whole);
}

export const parseNear = (value: string) => parseAmount(value, NEAR_DECIMALS);
export const formatNear = (value: string | bigint, places = 4) =>
  formatAmount(value, NEAR_DECIMALS, places);

/** Shorten an account id for a header: `jg-p2-72362.testnet` → `jg-p2…testnet`. */
export function truncateAccount(accountId: string, head = 6, tail = 7): string {
  if (accountId.length <= head + tail + 1) return accountId;
  return `${accountId.slice(0, head)}…${accountId.slice(-tail)}`;
}
