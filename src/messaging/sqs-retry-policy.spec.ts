import {
  SQS_MAX_RECEIVE_COUNT,
  sqsRetryVisibilitySeconds,
} from './sqs-retry-policy.js';

describe('SQS retry policy', () => {
  it('uses bounded exponential visibility in production', () => {
    expect(sqsRetryVisibilitySeconds(1, false)).toBe(5);
    expect(sqsRetryVisibilitySeconds(2, false)).toBe(10);
    expect(sqsRetryVisibilitySeconds(4, false)).toBe(40);
  });

  it('uses short delays in tests without removing the backoff behavior', () => {
    expect(sqsRetryVisibilitySeconds(1, true)).toBe(1);
    expect(sqsRetryVisibilitySeconds(2, true)).toBe(2);
    expect(sqsRetryVisibilitySeconds(4, true)).toBe(8);
  });

  it('releases the message when the DLQ receive limit is reached', () => {
    expect(sqsRetryVisibilitySeconds(SQS_MAX_RECEIVE_COUNT, false)).toBe(0);
  });
});
