export const SQS_MAX_RECEIVE_COUNT = 5;

const PRODUCTION_BASE_VISIBILITY_SECONDS = 5;
const TEST_BASE_VISIBILITY_SECONDS = 1;
const MAX_VISIBILITY_SECONDS = 300;

export function sqsRetryVisibilitySeconds(
  receiveCount: number,
  testEnvironment: boolean,
): number {
  if (receiveCount >= SQS_MAX_RECEIVE_COUNT) return 0;

  const normalizedCount = Math.max(1, Math.floor(receiveCount));
  const base = testEnvironment
    ? TEST_BASE_VISIBILITY_SECONDS
    : PRODUCTION_BASE_VISIBILITY_SECONDS;

  return Math.min(base * 2 ** (normalizedCount - 1), MAX_VISIBILITY_SECONDS);
}
