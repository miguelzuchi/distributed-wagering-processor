# Architecture

Este documento registra as decisões arquiteturais do Distributed Wagering Processor. Ele será evoluído junto com a implementação.

## Objetivos

O sistema deve preservar correção financeira sob entrega duplicada, mensagens fora de ordem, concorrência entre instâncias e falhas parciais. PostgreSQL será a fonte final das invariantes; recursos de ordenação do SQS serão apenas otimizações.

## Stack inicial

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

A migration inicial foi validada em PostgreSQL 16 real nos dois sentidos (`up`, `down`, `up`).

## Mensageria local

O LocalStack cria duas filas FIFO durante o startup. A fila principal usa a DLQ como redrive policy com `maxReceiveCount` igual a cinco. Deduplicação do broker não substituirá inbox nem idempotência persistente.

O consumidor reutiliza `WageringService.submit`, passando um contexto de inbox. Inbox, transação financeira, wallet, ledger e outbox são confirmados na mesma transação PostgreSQL. O ACK (`DeleteMessage`) ocorre somente depois que o caso de uso retorna, portanto depois do commit.

Erros HTTP de negócio são terminais e recebem ACK. Erros de infraestrutura e mensagens inválidas ficam sem ACK; a visibility timeout permite redelivery e a redrive policy encaminha à DLQ após cinco recebimentos. `OnModuleDestroy` interrompe novos polls e destrói o cliente SQS.

Um teste end-to-end envia uma mensagem FIFO ao LocalStack, espera a inbox processada e reenvia o mesmo `messageId`, comprovando um único débito.

## Autenticação

A primeira versão terá um ponto de extensão para um Identity Provider OIDC, mas não implementará autenticação. A decisão preserva o timebox para os itens que pontuam: correção financeira, concorrência e tolerância a falhas.

## Concorrência

A unidade de serialização financeira é a wallet. O caso de uso abre uma única transação SQL e obtém `SELECT ... FOR UPDATE` da wallet antes de validar saldo, resolver a direção e escrever wallet, transaction, ledger e outbox. Locks de wallets diferentes não se bloqueiam. Deadlocks e falhas transitórias terão retry limitado com jitter; erros de negócio não serão repetidos.

Antes do lock da wallet, `pg_advisory_xact_lock(hashtextextended(idempotencyKey, 0))` serializa apenas submissões com a mesma chave, inclusive se payloads conflitantes apontarem para wallets diferentes. O lock é transacional, liberado automaticamente, e não constitui lock financeiro global.

## Idempotência HTTP

O hash é SHA-256 do JSON canônico do payload de negócio: objetos têm chaves ordenadas recursivamente e campos `undefined` são omitidos. Header e metadados de transporte não entram no hash. A chave tem constraint única no banco.

Replay com mesmo hash retorna a transação persistida e o saldo observado originalmente; payload divergente retorna conflito. O saldo de resposta persiste valor e moeda separadamente para que até uma rejeição por conflito de moeda possa ser reproduzida exatamente.

Os testes end-to-end executam 50 submissões HTTP paralelas da mesma aposta e o cenário de duas apostas de `80.00` sobre saldo `100.00` contra PostgreSQL real.

## Consultas e reconciliação

O ledger usa keyset pagination por `(created_at, id)` em ordem decrescente. O cursor é um token Base64URL opaco, validado antes de entrar na consulta; não há paginação por offset instável.

A reconciliação soma créditos e débitos diretamente do ledger e compara com o saldo materializado. Divergências são retornadas e logadas, nunca corrigidas implicitamente. Liveness não consulta dependências; readiness exige PostgreSQL e a fila SQS configurada.

## Decisões pendentes

- Taxonomia de failure codes.
- TTL e tentativas de transações `PENDING_REFERENCE`.
- Backoff e claim concorrente da outbox.
- Retry limitado para deadlock/serialization failure.
