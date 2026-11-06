import { describe, expect, it } from 'vitest';
import { formatAmount, formatNear, parseAmount, parseNear, truncateAccount } from './amount';

describe('parseAmount', () => {
  it('survives past 2^53, where NEAR amounts live', () => {
    // Number("1000000000000000000000001") loses the last digit; this must not.
    expect(parseNear('1.000000000000000000000001')).toBe('1000000000000000000000001');
    expect(parseNear('2')).toBe('2000000000000000000000000');
  });

  it('handles the shapes a text input produces', () => {
    expect(parseNear('')).toBe('0');
    expect(parseNear('0.5')).toBe('500000000000000000000000');
    expect(parseNear('.5')).toBe('500000000000000000000000');
    expect(parseNear('5.')).toBe('5000000000000000000000000');
  });

  it('truncates extra decimals rather than rounding up', () => {
    // Rounding up would ask the wallet for more than the user typed.
    expect(parseAmount('1.999', 2)).toBe('199');
  });

  it('refuses something that is not an amount', () => {
    expect(() => parseNear('1e24')).toThrow('is not an amount');
    expect(() => parseNear('-1')).toThrow('is not an amount');
    expect(() => parseNear('two')).toThrow('is not an amount');
  });
});

describe('formatAmount', () => {
  it('truncates, because showing more than someone has costs them a transaction', () => {
    expect(formatNear('1999999999999999999999999', 2)).toBe('1.99');
    expect(formatAmount('199', 2, 2)).toBe('1.99');
  });

  it('drops trailing zeros and the point with them', () => {
    expect(formatNear('2000000000000000000000000')).toBe('2');
    expect(formatNear('2500000000000000000000000')).toBe('2.5');
  });

  it('round trips what parse produced', () => {
    for (const value of ['0', '1', '2.5', '0.0001', '123456.789']) {
      expect(formatNear(parseNear(value), 6)).toBe(
        value === '0' ? '0' : String(Number(value)).replace(/\.0+$/, '')
      );
    }
  });

  it('handles amounts below one without losing the leading zero', () => {
    expect(formatNear('1000000000000000000000')).toBe('0.001');
  });
});

describe('truncateAccount', () => {
  it('leaves a short account alone', () => {
    expect(truncateAccount('alice.near')).toBe('alice.near');
  });

  it('keeps both ends of a long one, which is what people recognise', () => {
    const shortened = truncateAccount('jg-p2-72362.testnet');
    expect(shortened.startsWith('jg-p2-')).toBe(true);
    expect(shortened.endsWith('testnet')).toBe(true);
    expect(shortened).toContain('…');
  });

  it('does not truncate an implicit account into something misleading', () => {
    const implicit = 'a'.repeat(64);
    expect(truncateAccount(implicit)).toHaveLength(6 + 1 + 7);
  });
});
