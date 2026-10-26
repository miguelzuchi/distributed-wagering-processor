#!/usr/bin/env sh
set -eu

DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
EVENTS_QUEUE_NAME="wager-events.fifo"

awslocal sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' \
  >/dev/null

awslocal sqs create-queue \
  --queue-name "$EVENTS_QUEUE_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  >/dev/null

DLQ_URL="$(awslocal sqs get-queue-url --queue-name "$DLQ_NAME" --query QueueUrl --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

QUEUE_ATTRIBUTES="$(python3 -c '
import json
import sys

redrive_policy = json.dumps({
    "deadLetterTargetArn": sys.argv[1],
    "maxReceiveCount": "5",
})
print(json.dumps({
    "FifoQueue": "true",
    "ContentBasedDeduplication": "true",
    "RedrivePolicy": redrive_policy,
}))
' "$DLQ_ARN")"

awslocal sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "$QUEUE_ATTRIBUTES" \
  >/dev/null

echo "SQS FIFO queues are ready"
