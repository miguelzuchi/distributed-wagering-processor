# Distributed Wagering Processor

Serviço financeiro distribuído para processar transações de apostas entregues por múltiplos provedores. O projeto faz parte do desafio técnico da Jungle Gaming e prioriza correção financeira, concorrência, idempotência persistente e recuperação após falhas.

## Estado atual

O núcleo financeiro, abertura de wallet e processamento HTTP de transações estão implementados. `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` compartilham um caso de uso transacional com idempotência persistente, lock por wallet, ledger e outbox. Referências ausentes são persistidas como `PENDING_REFERENCE`.

Há testes de concorrência HTTP contra PostgreSQL real, incluindo 50 replays paralelos e apostas disputando o mesmo saldo. Ledger paginado, reconciliação e health checks de PostgreSQL/SQS também estão disponíveis. O consumidor SQS usa inbox atômica, ACK após commit e redrive para DLQ. Ainda estão em desenvolvimento o publisher da outbox, reprocessamento agendado, métricas e testes entre múltiplos processos.

## Stack

- Bun 1.x
- TypeScript com `strict: true`
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS via LocalStack
- Docker Compose
- Vitest executado com Bun

## Pré-requisitos

- Bun 1.x
- Docker Desktop com Docker Compose
- Git

Verifique o ambiente:

```bash
bun --version
docker --version
docker compose version
git --version
```

## Instalação

```bash
bun install
copy .env.example .env
```

## Execução local

Suba PostgreSQL e LocalStack. O LocalStack cria automaticamente a fila principal e sua DLQ:

```bash
bun run infra:up
```

Depois aplique as migrations e inicie a API:

```bash
bun run db:migrate
bun run start:dev
```

A API fica disponível por padrão em `http://localhost:3000`.

## Comandos

```bash
bun run build       # compila a aplicação
bun run start:dev   # inicia em modo de desenvolvimento
bun run lint        # executa a análise estática
bun run format      # formata o código
bun test            # executa testes unitários
bun run test:e2e    # executa testes end-to-end
bun run infra:up    # sobe PostgreSQL e LocalStack
bun run infra:down  # encerra a infraestrutura
bun run infra:logs  # acompanha os logs dos containers
bun run db:migrate  # aplica migrations pendentes
```

## Infraestrutura local

O arquivo `compose.yaml` fornece:

- PostgreSQL na porta `5432`, com volume persistente e healthcheck;
- LocalStack na porta `4566`, limitado ao serviço SQS;
- fila FIFO `wager-transactions.fifo`;
- DLQ FIFO `wager-transactions-dlq.fifo`;
- redrive automático para a DLQ após cinco recebimentos.

O LocalStack está fixado na versão comunitária `4.4.0`. Versões publicadas a partir de março de 2026 passaram a exigir autenticação e uma licença, inclusive ao iniciar o container.

As credenciais de desenvolvimento existem apenas para o ambiente local e estão documentadas em `.env.example`. O arquivo `.env` real não é versionado.

## Escopo planejado

- `Money` imutável, sem uso de `number` para valores monetários.
- Wallet com saldo materializado e ledger imutável.
- Processamento de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Concorrência controlada por wallet.
- Idempotência persistente com detecção de payload divergente.
- Inbox e transactional outbox na mesma transação financeira.
- SQS com retry, backoff, DLQ e graceful shutdown.
- Reprocessamento de referências entregues fora de ordem.
- Reconciliação entre saldo e ledger.
- Logs estruturados, métricas e health checks.
- Testes de integração e concorrência com serviços reais em containers.

## Estrutura inicial

```text
distributed-wagering-processor/
├── infra/localstack/     # inicialização das filas locais
├── src/config/           # leitura e validação do ambiente
├── src/infrastructure/   # adaptadores, MikroORM e migrations
├── test/                 # testes end-to-end
├── .env.example          # contrato de configuração
├── compose.yaml          # PostgreSQL e LocalStack
├── package.json          # dependências e comandos
└── tsconfig.json         # TypeScript em modo estrito
```

## Decisões arquiteturais

As decisões sobre modelagem monetária, locks, constraints, idempotência, inbox/outbox e tratamento de falhas serão registradas em `ARCHITECTURE.md` conforme forem implementadas.

## Autenticação

Autenticação não será implementada na primeira etapa, pois não pontua no desafio. O código manterá um ponto de extensão explícito para integração futura com um provedor OIDC, como Keycloak.

## Licença

Projeto privado desenvolvido para fins de avaliação técnica.
