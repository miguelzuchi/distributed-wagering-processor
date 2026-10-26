import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_SECONDS,
  outboxRetryDelayMs,
} from './outbox-policy.js';

describe('outbox policy', () => {
  it('uses a bounded exponential retry delay', () => {
    expect(outboxRetryDelayMs(1)).toBe(2_000);
    expect(outboxRetryDelayMs(2)).toBe(4_000);
    expect(outboxRetryDelayMs(6)).toBe(60_000);
    expect(outboxRetryDelayMs(20)).toBe(60_000);
  });

  it('keeps the claim comfortably longer than a normal batch', () => {
    expect(OUTBOX_BATCH_SIZE).toBe(25);
    expect(OUTBOX_CLAIM_SECONDS).toBeGreaterThan(60);
  });
});
