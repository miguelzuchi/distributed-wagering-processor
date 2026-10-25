import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain.error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const DECIMAL_WITH_FIXED_SCALE = /^(?:0|[1-9]\d*)\.\d{2}$/;
const ISO_4217_CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!ISO_4217_CURRENCY.test(props.currency)) {
      throw new InvalidMoneyError('Currency must be an ISO-4217 alpha code');
    }

    if (!DECIMAL_WITH_FIXED_SCALE.test(props.amount)) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with exactly two decimal places',
      );
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static fromDecimal(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.decimalPlaces() > 2) {
      throw new InvalidMoneyError(
        'Money must be finite and have at most two decimals',
      );
    }

    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.sub(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Cannot operate on ${this.currency} and ${other.currency}`,
      );
    }
  }
}
