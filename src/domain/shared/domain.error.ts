export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}

export class InsufficientBalanceError extends DomainError {}

export class InvalidTransactionStateError extends DomainError {}

export class InvalidWagerTransactionError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}
