# Referência da API

Valores monetários são strings decimais canônicas com exatamente duas casas.
Todas as respostas HTTP incluem `X-Correlation-Id`.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| POST | `/wallets` | cria wallet e lançamento de abertura |
| GET | `/wallets/:walletId` | consulta saldo materializado |
| GET | `/wallets/:walletId/ledger` | ledger com cursor opaco |
| POST | `/wallets/:walletId/reconciliation` | compara saldo e ledger |
| POST | `/wagering/transactions` | submete operação idempotente |
| GET | `/wagering/transactions/:id` | consulta por ID interno |
| GET | `/providers/:providerId/wagering/transactions/:externalId` | consulta por ID externo |
| GET | `/health/live` | liveness sem dependências |
| GET | `/health/ready` | readiness de PostgreSQL e SQS |
| GET | `/metrics` | métricas Prometheus |

## Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance":{"amount":"1000.00","currency":"BRL"}
  }'
```

Saldo inicial positivo cria `OPENING` e ledger `CREDIT` na mesma transação SQL.

## Submeter BET

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -d '{
    "providerId":"provider-a",
    "externalTransactionId":"transaction-123",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId":"0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId":"round-987",
    "gameId":"fortune-chimp",
    "kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}
  }'
```

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.

## Status HTTP

| Status | Significado | Ação do provedor |
|---|---|---|
| `200` | replay ou consulta bem-sucedida | usar resultado original |
| `201` | operação criada e processada | não reenviar |
| `202` | aguardando referência | consultar depois |
| `400` | contrato inválido | corrigir payload |
| `404` | recurso inexistente | verificar IDs |
| `409` | conflito de unicidade/idempotência | corrigir a causa |
| `422` | rejeição de negócio | interpretar `failureCode` |
| `503/5xx` | falha de infraestrutura | retry com backoff |

## Failure codes

| Código | Significado |
|---|---|
| `INSUFFICIENT_BALANCE` | BET excede saldo disponível |
| `REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE` | reversão produziria saldo negativo |
| `REFERENCE_NOT_FOUND` | referência não apareceu no limite |
| `INVALID_REFERENCE` | referência incompatível |
| `REFERENCE_ALREADY_REVERSED` | reversão do mesmo tipo já processada |
| `AMOUNT_MISMATCH` | valor difere da referência |
| `CURRENCY_MISMATCH` | moeda difere da wallet |
| `PERMANENT_INFRASTRUCTURE_FAILURE` | falha permanente auditável |

## Paginação e reconciliação

O ledger usa `limit` entre os limites validados pelo DTO e um cursor Base64URL
opaco. Reconciliação nunca corrige divergência silenciosamente: retorna
`consistent: false`, registra log e preserva os dados para investigação.
