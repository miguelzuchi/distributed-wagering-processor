export const OUTBOX_BATCH_SIZE = 25;
export const OUTBOX_CLAIM_SECONDS = 120;

export function outboxRetryDelayMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
}
