# Estratégia de testes

## Comandos

```bash
bun run build
bun run lint
bun test
bun run test:cov
bun run infra:up
bun run db:migrate
bun run test:e2e
```

Os E2E usam PostgreSQL e LocalStack reais. Arquivos E2E são serializados porque
compartilham filas; o paralelismo dentro dos cenários continua real.

## Cenários críticos

- 50 replays concorrentes geram um débito.
- Duas BETs de `80.00` sobre `100.00` deixam saldo `20.00`.
- Wallets distintas são processadas em paralelo sem lock financeiro global.
- Três processos completos coordenam pela mesma base.
- Crash com `SIGKILL` após commit e antes do ACK não duplica efeito.
- Após o crash, uma nova instância reconcilia saldo e ledger persistidos.
- Mensagem estruturalmente inválida é classificada como permanente e chega à DLQ antes do ACK da origem.
- REFUND fora de ordem é retomado quando a BET aparece.
- Referência ausente após oito tentativas é rejeitada sem ledger.
- Lease de outbox abandonado é retomado por outro publisher.
- LOSS não gera ledger; rollback de BET, WIN e REFUND é validado.
- Constraints recusam saldo negativo e mutação do ledger.
- Métricas persistentes expõem retries SQS, mensagens na DLQ e conflitos de lock.
- A CI executa o ciclo completo de migrations `up → down até zero → up`.

O atraso de ACK usado para posicionar deterministicamente o crash só é lido em
`NODE_ENV=test`; não altera o comportamento de produção.

## Invariante de encerramento

Todo cenário financeiro confirma que o saldo materializado é compatível com a
sequência do ledger. O endpoint de reconciliação oferece a mesma verificação em
operação.
