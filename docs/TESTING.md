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
- Três processos completos coordenam pela mesma base.
- Crash com `SIGKILL` após commit e antes do ACK não duplica efeito.
- Mensagem inválida excede cinco recebimentos e chega à DLQ.
- REFUND fora de ordem é retomado quando a BET aparece.
- Referência ausente após oito tentativas é rejeitada sem ledger.
- Lease de outbox abandonado é retomado por outro publisher.
- LOSS não gera ledger; rollback de BET, WIN e REFUND é validado.
- Constraints recusam saldo negativo e mutação do ledger.

O atraso de ACK usado para posicionar deterministicamente o crash só é lido em
`NODE_ENV=test`; não altera o comportamento de produção.

## Invariante de encerramento

Todo cenário financeiro confirma que o saldo materializado é compatível com a
sequência do ledger. O endpoint de reconciliação oferece a mesma verificação em
operação.
