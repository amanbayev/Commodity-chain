# Commodity Chain

Commodity Chain is a regulated tokenized commodity exchange intended for the AIFC/AFSA Operating an Exchange and Clearing House licensing perimeter. The pilot instrument is a grain token representing a claim secured by an electronic grain receipt.

The repository contains the contract-first platform scaffold plus the initial PostgreSQL ledger,
oracle gateway, electronic grain receipt mock, verified collateral, and collateral-backed minting
slices. Matching, settlement, redemption, and the wider exchange workflows remain scaffolds.

## Technology baseline

- TypeScript on Node.js 22 LTS
- NestJS modular monolith
- PostgreSQL 16
- NATS JetStream with the outbox pattern
- Redis
- React 18 with Vite
- OpenAPI 3.1 as the API source of truth
- pnpm workspaces

## Local commands

1. Install Node.js 22 and enable pnpm through Corepack.
2. Run pnpm install.
3. Run pnpm lint, pnpm typecheck, pnpm test, and pnpm build.
4. Start local dependencies with Docker Compose using infra/docker-compose.yml.

Repository-wide engineering rules are defined in AGENTS.md.
