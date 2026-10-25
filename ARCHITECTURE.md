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

## Autenticação

A primeira versão terá um ponto de extensão para um Identity Provider OIDC, mas não implementará autenticação. A decisão preserva o timebox para os itens que pontuam: correção financeira, concorrência e tolerância a falhas.

## Concorrência

A unidade de serialização será a wallet. O caso de uso financeiro abrirá uma única transação SQL e obterá `SELECT ... FOR UPDATE` da wallet antes de validar saldo, resolver a direção e escrever wallet, transaction, ledger, inbox e outbox. Locks de wallets diferentes não se bloqueiam. Deadlocks e falhas transitórias terão retry limitado com jitter; erros de negócio não serão repetidos.

## Decisões pendentes

- Taxonomia de failure codes.
- TTL e tentativas de transações `PENDING_REFERENCE`.
- Backoff e claim concorrente da outbox.
