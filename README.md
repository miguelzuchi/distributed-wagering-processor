# Distributed Wagering Processor

Serviço financeiro distribuído para processar transações de apostas entregues por múltiplos provedores. O projeto faz parte do desafio técnico da Jungle Gaming e prioriza correção financeira, concorrência, idempotência persistente e recuperação após falhas.

Documentação complementar:

- [Decisões arquiteturais](ARCHITECTURE.md)
- [Referência da API](docs/API.md)
- [Estratégia de testes](docs/TESTING.md)
- [Matriz de requisitos](REQUIREMENTS.md)

## Estado atual

O núcleo financeiro, abertura de wallet e processamento HTTP de transações estão implementados. `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` compartilham um caso de uso transacional com idempotência persistente, lock por wallet, ledger e outbox. Referências ausentes são persistidas como `PENDING_REFERENCE`.

Há testes de concorrência HTTP contra PostgreSQL real, duas instâncias isoladas e três processos completos da aplicação. Eles incluem 50 replays paralelos, apostas disputando o mesmo saldo entre réplicas, crash depois do commit e antes do ACK, redelivery sem efeito duplicado, redrive real até a DLQ e a matriz de rollback de BET, WIN e REFUND. Ledger paginado, reconciliação e health checks de PostgreSQL/SQS também estão disponíveis. O consumidor SQS usa inbox atômica, auditoria de rejeições, ACK após commit e redrive para DLQ. No shutdown ele interrompe novos polls, aguarda mensagens em andamento e devolve imediatamente a visibilidade das que excederem o prazo. O publisher concorrente da outbox usa claims com lease, `SKIP LOCKED`, fila de eventos dedicada e backoff persistente sem manter transações abertas durante chamadas de rede. Referências fora de ordem são reprocessadas automaticamente. Deadlocks e falhas de serialização do PostgreSQL têm retry limitado com backoff e jitter. Métricas Prometheus expõem volume processado, replays idempotentes, latência, lag e backlogs persistentes. A CI valida build, lint, testes, migrations, E2E e a imagem de produção.

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
bun install --frozen-lockfile
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

```bash
# Linux/macOS
cp .env.example .env
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

As métricas no formato Prometheus ficam em `GET /metrics`. O endpoint deriva os
contadores e backlogs do estado persistido, portanto continua correto após
reinícios e pode ser coletado de qualquer réplica da aplicação.

Toda resposta HTTP inclui `X-Correlation-Id`. Um identificador seguro enviado
pelo cliente é preservado; quando ausente ou inválido, a aplicação gera um UUID.
Ao concluir a resposta, um log estruturado registra correlação, método, caminho,
status e duração, sem incluir payloads ou dados financeiros.

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
bun run db:migrate:down # reverte a última migration
```

Os testes E2E exigem a infraestrutura e as migrations ativas. Eles usam
PostgreSQL e LocalStack reais; veja [docs/TESTING.md](docs/TESTING.md).

## Imagem de produção

O `Dockerfile` usa build multi-stage, instala somente dependências de produção na
imagem final e executa a aplicação como usuário sem privilégios:

```bash
docker build -t distributed-wagering-processor .
docker run --env-file .env -p 3000:3000 distributed-wagering-processor
```

Em produção, banco, região AWS e URLs das filas devem ser informados
explicitamente; a aplicação falha durante o startup quando a configuração está
incompleta ou inválida. As migrations devem ser executadas como uma etapa
separada antes da atualização da aplicação.

## Infraestrutura local

O arquivo `compose.yaml` fornece:

- PostgreSQL na porta `5432`, com volume persistente e healthcheck;
- LocalStack na porta `4566`, limitado ao serviço SQS;
- fila FIFO `wager-transactions.fifo`;
- DLQ FIFO `wager-transactions-dlq.fifo`;
- redrive automático para a DLQ após cinco recebimentos.

O healthcheck do LocalStack só considera o serviço pronto depois que as três
filas obrigatórias existem, evitando que migrations e testes E2E comecem
durante a execução dos hooks de inicialização.

O LocalStack está fixado na versão comunitária `4.4.0`. Versões publicadas a partir de março de 2026 passaram a exigir autenticação e uma licença, inclusive ao iniciar o container.

As credenciais de desenvolvimento existem apenas para o ambiente local e estão documentadas em `.env.example`. O arquivo `.env` real não é versionado.

## Escopo implementado

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

## Estrutura do projeto

```text
distributed-wagering-processor/
├── infra/localstack/     # inicialização das filas locais
├── docs/                 # referência de API e estratégia de testes
├── src/config/           # leitura e validação do ambiente
├── src/infrastructure/   # adaptadores, MikroORM e migrations
├── test/                 # testes end-to-end
├── .env.example          # contrato de configuração
├── compose.yaml          # PostgreSQL e LocalStack
├── REQUIREMENTS.md       # requisito → implementação → teste
├── package.json          # dependências e comandos
└── tsconfig.json         # TypeScript em modo estrito
```

## Decisões arquiteturais

As decisões sobre modelagem monetária, locks, constraints, idempotência, inbox/outbox e tratamento de falhas estão registradas em `ARCHITECTURE.md`.

O schema também valida que ledger, transaction e wallet pertencem à mesma
moeda e wallet; impede autorreferência e mais de uma reversão processada do
mesmo tipo. As migrations mais recentes foram verificadas em `down → up` contra
PostgreSQL real.

## Autenticação

Autenticação não foi implementada porque não pontua no desafio. `AuthModule` registra um `NoAuthGuard` global e `ProviderIdentityPort` explicita o ponto de substituição por um provedor OIDC, como Keycloak.

## Licença

Projeto privado desenvolvido para fins de avaliação técnica.
