import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidMoneyError,
} from '../shared/domain.error.js';
import { Money } from '../shared/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError(
        'A wallet cannot open with a negative balance',
      );
    }

    const at = props.at ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, at: Date = new Date()): WalletMovement {
    this.assertMovableMoney(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError('Insufficient wallet balance');
    }

    return this.applyBalance(this._balance.subtract(money), at);
  }

  credit(money: Money, at: Date = new Date()): WalletMovement {
    this.assertMovableMoney(money);
    return this.applyBalance(this._balance.add(money), at);
  }

  private applyBalance(balanceAfter: Money, at: Date): WalletMovement {
    const balanceBefore = this._balance;
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return { balanceBefore, balanceAfter };
  }

  private assertMovableMoney(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError('Wallet movements must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Wallet uses ${this.currency}, operation uses ${money.currency}`,
      );
    }
  }
}
