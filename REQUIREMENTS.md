# Matriz de rastreabilidade

Esta matriz relaciona os principais requisitos do desafio às garantias e provas
automatizadas do projeto.

| Área | Implementação | Evidência automatizada |
|---|---|---|
| Dinheiro exato | `Money`, Decimal.js e `numeric(20,2)` | `money.spec.ts` |
| Saldo não negativo | domínio, lock da wallet e CHECK | unidade + E2E de constraints |
| Ledger imutável | trigger contra UPDATE/DELETE | E2E de constraints |
| Relações do ledger | trigger wallet/transação/moeda | migration 006 |
| Wallet única | UNIQUE player/currency | migration 001 |
| Idempotência HTTP | advisory lock, hash e UNIQUE | 50 requests paralelas |
| Payload divergente | hash persistente | unidade e HTTP `409` |
| Concorrência | `FOR UPDATE` por wallet | duas BETs de 80 sobre 100 |
| Paralelismo entre wallets | lock restrito à wallet | 12 wallets em duas réplicas |
| Múltiplas instâncias | coordenação pelo PostgreSQL | três processos reais |
| Inbox | PK consumer/message na transação | SQS real e redelivery |
| ACK após commit | ACK fora da transação SQL | crash commit/ACK com SIGKILL |
| Retry e DLQ | backoff/redrive transitório; publicação segura para erro permanente | LocalStack real até DLQ |
| Graceful shutdown | drain + visibility zero | implementação e crash recovery |
| Transactional outbox | insert no commit financeiro | auditoria E2E no banco |
| Publishers concorrentes | lease + `SKIP LOCKED` | duas apps + lease abandonado |
| Referência fora de ordem | `PENDING_REFERENCE` + worker | REFUND antes da BET |
| Referência expirada | oito tentativas + backoff | `REFERENCE_NOT_FOUND` |
| BET/WIN/LOSS | regras por tipo | unidade + matriz E2E |
| REFUND/ROLLBACK | reversão integral validada | matriz BET/WIN/REFUND |
| Reconciliação | soma independente do ledger | E2E de reconciliação |
| Paginação | cursor `(created_at,id)` | E2E do ledger |
| Health | live isolado, ready DB/SQS | E2E de health |
| Observabilidade | logs JSON e `/metrics`, incluindo retry, DLQ e lock conflicts | testes dedicados |
| Migrations | up/down versionados | PostgreSQL real down/up |
| Reinicialização | estado persistido independente do processo | SIGKILL, nova instância e reconciliação |

## Falhas demonstradas

```text
duplicação HTTP              → replay do resultado original
mesma chave, outro payload   → conflito sem novo efeito
duas BETs concorrentes       → uma processada, uma rejeitada
processo morre antes do ACK  → redelivery sem novo débito
mensagem inválida repetida   → DLQ
referência chega depois      → processamento automático
referência nunca chega       → rejeição auditável
publisher abandona lease     → outra instância publica
```

## Fora do escopo assumido

- adapter OIDC concreto;
- reversão parcial;
- double-entry bookkeeping;
- política produtiva de retenção;
- tracing distribuído e dashboards;
- exactly-once no transporte.
