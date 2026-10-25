import { CurrencyMismatchError, InvalidMoneyError } from './domain.error.js';
import { Money } from './money.js';

describe('Money', () => {
  it.each([
    '',
    '1',
    '1.0',
    '1.000',
    '-1.00',
    '+1.00',
    '01.00',
    '1e2',
    'NaN',
    'Infinity',
  ])('rejects invalid amount %s', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each(['brl', 'BR', 'REAL', '12A'])(
    'rejects invalid currency %s',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  it('calculates exactly and always serializes with fixed scale', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );
    expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(result.toString()).toBe('0.30 BRL');
  });

  it('supports negative intermediate values without accepting negative input', () => {
    const result = Money.from({ amount: '1.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '2.00', currency: 'BRL' }),
    );
    expect(result.isNegative()).toBe(true);
    expect(result.negate().toJSON().amount).toBe('1.00');
  });

  it('rejects operations between currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });
});
