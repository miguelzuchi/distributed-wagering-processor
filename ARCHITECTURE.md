# Architecture

Este documento registra as decisões arquiteturais, garantias e trade-offs do Distributed Wagering Processor.

## Objetivos

O sistema deve preservar correção financeira sob entrega duplicada, mensagens fora de ordem, concorrência entre instâncias e falhas parciais. PostgreSQL será a fonte final das invariantes; recursos de ordenação do SQS serão apenas otimizações.

## Stack

- Bun como runtime, package manager e executor dos testes.
- NestJS como composition root e camada de transporte.
- MikroORM pelo Unit of Work, Identity Map e suporte explícito a locks.
- PostgreSQL para estado transacional, ledger, inbox e outbox.
- SQS FIFO em LocalStack para desenvolvimento e testes locais.
- Decimal.js para aritmética monetária exata no domínio.

## Configuração

A aplicação segue configuração por ambiente. `.env.example` define o contrato local, enquanto segredos reais não são versionados. O startup rejeita portas com formato inválido.

## Domínio monetário

`Money` encapsula `Decimal` e só aceita contratos externos em formato decimal canônico, não negativo e com exatamente duas casas. Valores negativos só podem existir como resultado interno de operações, como `subtract` e `negate`. O domínio não importa NestJS nem MikroORM.

`Wallet` inicia na versão 1 e só incrementa a versão quando um crédito ou débito positivo é aplicado. Débito insuficiente, moeda divergente e movimento nulo são rejeitados antes de qualquer mutação.

## Persistência

As migrations ficam em `src/infrastructure/persistence/migrations`, são transacionais e `all-or-nothing`. Os mapeamentos do MikroORM 7 usam `defineEntity` e ficam separados das classes de domínio, evitando decorators ou tipos do ORM no domínio.

A representação monetária é `numeric(20,2)` e o código a hidrata como `string`; nunca há conversão para `number`. O schema aplica:

- saldo e balances do ledger não negativos;
- valores financeiros estritamente positivos;
- unicidade de wallet por player e moeda;
- unicidade de idempotency key e de transação externa por provider;
- no máximo um lançamento por transação;
- aritmética válida para cada lançamento;
- estados e formato terminal válidos;
- imutabilidade do ledger por trigger que recusa `UPDATE` e `DELETE`.
- correspondência de wallet e moeda entre ledger, transação e saldo materializado;
- referência diferente da própria transação;
- uma reversão processada por `(reference_transaction_id, kind)`.

As migrations mais recentes foram validadas em PostgreSQL 16 real nos dois sentidos (`up`, `down`, `up`).

## Mensageria local

O LocalStack cria três filas FIFO durante o startup: entrada, DLQ e eventos. A fila principal usa a DLQ como redrive policy com `maxReceiveCount` igual a cinco. Deduplicação do broker não substitui inbox nem idempotência persistente.

O consumidor reutiliza `WageringService.submit`, passando um contexto de inbox. Inbox, transação financeira, wallet, ledger e outbox são confirmados na mesma transação PostgreSQL. O ACK (`DeleteMessage`) ocorre somente depois que o caso de uso retorna, portanto depois do commit. Erros de negócio terminais são persistidos na inbox com status `REJECTED` antes do ACK; se essa auditoria falhar, a mensagem permanece sem ACK.

Erros HTTP de negócio são terminais e recebem ACK. Erros de infraestrutura e mensagens inválidas ficam sem ACK; o consumidor agenda redelivery com visibility timeout exponencial de 5, 10, 20 e 40 segundos e libera a mensagem imediatamente no quinto recebimento, quando a redrive policy a encaminha à DLQ. No shutdown, novos polls são interrompidos, mensagens em andamento recebem até dez segundos para terminar e as restantes têm a visibilidade devolvida antes da destruição do cliente.

Os testes end-to-end cobrem inbox duplicada, redrive real, três processos e crash com `SIGKILL` depois do commit e antes do ACK, comprovando redelivery sem débito duplicado.

Eventos de integração são publicados em `wager-events.fifo`. Publishers concorrentes reivindicam lotes com `FOR UPDATE SKIP LOCKED` e um lease persistente. A transação termina antes do I/O com SQS; assim, lentidão de rede não mantém locks nem conexões transacionais ocupadas. Claims abandonados expiram e podem ser retomados. Sucesso grava `published_at`, enquanto falha incrementa `attempts` e agenda backoff exponencial limitado a 60 segundos. O envio ocorre antes da marcação no banco, portanto uma queda nesse intervalo pode duplicar a publicação, mas nunca perder um evento. `eventId` é usado como deduplication ID e também permite deduplicação persistente no consumidor.

Referências pendentes são examinadas em lotes de 25. Cada item é reprocessado em transação própria, com locks da transação e da wallet. O backoff é exponencial e limitado a 60 segundos; após oito tentativas sem referência, a transação é rejeitada com `REFERENCE_NOT_FOUND`. Os testes cobrem tanto REFUND antes da BET quanto expiração definitiva sem criação de ledger.

## Transições de estado

```text
PENDING ───────────────► PROCESSED
   │
   ├─ referência ausente ─► PENDING_REFERENCE ─► PROCESSED
   │                              └──────────────► REJECTED
   ├─ regra de negócio ─────────────────────────► REJECTED
   └─ falha permanente ─────────────────────────► FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. LOSS é processada sem ledger.

## Autenticação

A primeira versão não implementa autenticação. `AuthModule` registra um `NoAuthGuard`
global e `ProviderIdentityPort` define o contrato que será substituído por um adapter
OIDC. Health checks continuam públicos quando esse adapter for implementado. A decisão
preserva o timebox para correção financeira, concorrência e tolerância a falhas.

## Concorrência

A unidade de serialização financeira é a wallet. O caso de uso abre uma única transação SQL e obtém `SELECT ... FOR UPDATE` da wallet antes de validar saldo, resolver a direção e escrever wallet, transaction, ledger e outbox. Locks de wallets diferentes não se bloqueiam. Deadlocks (`40P01`) e falhas de serialização (`40001`) têm até três tentativas com backoff exponencial e jitter; erros de negócio não são repetidos.

Antes do lock da wallet, `pg_advisory_xact_lock(hashtextextended(idempotencyKey, 0))` serializa apenas submissões com a mesma chave, inclusive se payloads conflitantes apontarem para wallets diferentes. O lock é transacional, liberado automaticamente, e não constitui lock financeiro global.

## Idempotência HTTP

O hash é SHA-256 do JSON canônico do payload de negócio: objetos têm chaves ordenadas recursivamente e campos `undefined` são omitidos. Header e metadados de transporte não entram no hash. A chave tem constraint única no banco.

Replay com mesmo hash retorna a transação persistida e o saldo observado originalmente; payload divergente retorna conflito. O saldo de resposta persiste valor e moeda separadamente para que até uma rejeição por conflito de moeda possa ser reproduzida exatamente.

Os testes end-to-end executam 50 submissões HTTP paralelas da mesma aposta e o cenário de duas apostas de `80.00` sobre saldo `100.00` contra PostgreSQL real.

## Consultas e reconciliação

O ledger usa keyset pagination por `(created_at, id)` em ordem decrescente. O cursor é um token Base64URL opaco, validado antes de entrar na consulta; não há paginação por offset instável.

A reconciliação soma créditos e débitos diretamente do ledger e compara com o saldo materializado. Divergências são retornadas e logadas, nunca corrigidas implicitamente. Liveness não consulta dependências; readiness exige PostgreSQL e a fila SQS configurada.

## Observabilidade

Logs HTTP são estruturados, carregam correlation ID e não incluem payload
financeiro completo. Métricas persistentes cobrem status, inbox, outbox,
replays idempotentes, tentativas de publicação, latência média e lag da outbox.
Detalhes operacionais e cenários automatizados estão em `docs/TESTING.md`.

## Decisões pendentes

- Política de retenção para inbox, outbox publicada e transações antigas.
- Tracing distribuído e alertas operacionais.
- Estratégia de autenticação OIDC.

## Limitações conhecidas

- A entrega do outbox é `at-least-once`; consumidores precisam deduplicar por `eventId`.
- Retenção e arquivamento de registros antigos dependem da política operacional do ambiente.
- O adapter OIDC não faz parte desta entrega; o guard atual é deliberadamente permissivo.
- SQL explícito torna locks e constraints visíveis, mas exige mais mapeamento do que o uso integral do Unit of Work.
